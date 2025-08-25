// api/clean-note.js
// Node.js (CommonJS) - Vercel Serverless Function
const crypto = require("crypto");

/* ===================== 설정 ===================== */
// 주문 생성 직후 몇 초 동안만 자동 정리 (사후 수동 수정 보호)
const CLEAN_WINDOW_SECONDS = Number(process.env.CLEAN_WINDOW_SECONDS || 30);
// 태그 선호 포맷: 'DMY' | 'YMD'
//  - DMY: 26-08-2025 (앱 스타일) [기본]
//  - YMD: 2025-08-26 (연-월-일)
const PREFERRED_TAG_FORMAT = (process.env.PREFERRED_TAG_FORMAT || "DMY").toUpperCase();

/* ===================== 공통 유틸 ===================== */
async function rawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

function verifyHmac(raw, hmacHeader, secret) {
  const digest = crypto.createHmac("sha256", secret).update(raw).digest("base64");
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader || "", "utf8"));
}

function to2(n) {
  return String(n).padStart(2, "0");
}
function formatDateDMY(y, m, d) {
  return `${to2(d)}-${to2(m)}-${y}`;
}
function formatDateYMD(y, m, d) {
  return `${y}-${to2(m)}-${to2(d)}`;
}
function formatTagByPreference(y, m, d) {
  return PREFERRED_TAG_FORMAT === "YMD"
    ? formatDateYMD(y, m, d)
    : formatDateDMY(y, m, d);
}

/* ========== 메모에서 (Delivery Date: …) 블록만 제거 (본문 보존) ========== */
function stripDeliveryDateBlock(note) {
  if (!note) return { cleaned: "", changed: false };
  let cleaned = String(note);

  // 예: (Delivery Date: 26/08/2025), (Delivery Date: 26-08-2025)
  //     (Delivery Date: 2025/08/26), (Delivery Date: 2025-08-26)
  const patterns = [
    /\s*\(\s*delivery\s*date\s*:\s*\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\s*\)\s*/gim,
    /\s*\(\s*delivery\s*date\s*:\s*\d{4}[\/\-]\d{2}[\/\-]\d{2}\s*\)\s*/gim,
  ];

  const before = cleaned;
  patterns.forEach((re) => {
    cleaned = cleaned.replace(re, " "); // 괄호 블록만 제거
  });

  cleaned = cleaned
    .replace(/[ \t]+\n/g, "\n") // 줄 끝 공백 정리
    .replace(/\n{3,}/g, "\n\n") // 과한 개행 정리
    .trim();

  return { cleaned, changed: cleaned !== before.trim() };
}

/* ========== 메모에서 배송일 추출 (YYYY,MM,DD) ========== */
function extractDeliveryYMD(note) {
  if (!note) return null;
  const s = String(note);

  // (Delivery Date: 26/08/2025) or 26-08-2025
  let m = s.match(/\(.*?delivery\s*date\s*:\s*(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4}).*?\)/i);
  if (m) {
    let [, dd, mm, yy] = m;
    const year = yy.length === 2 ? (Number(yy) >= 70 ? `19${yy}` : `20${yy}`) : yy;
    return { y: String(year), m: to2(mm), d: to2(dd) };
  }
  // (Delivery Date: 2025/08/26) or 2025-08-26
  m = s.match(/\(.*?delivery\s*date\s*:\s*(\d{4})[\/\-](\d{2})[\/\-](\d{2}).*?\)/i);
  if (m) {
    const [, yyyy, mm, dd] = m;
    return { y: String(yyyy), m: to2(mm), d: to2(dd) };
  }
  return null;
}

/* ========== 태그 정규화 (선호 포맷 한 개만 유지) ========== */
function findDateTagsInTags(tagsString) {
  const tags = String(tagsString || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  const reYMD = /^\d{4}-\d{2}-\d{2}$/; // 2025-08-26
  const reDMY = /^\d{2}-\d{2}-\d{4}$/; // 26-08-2025

  const dateTags = [];
  for (const t of tags) {
    if (reYMD.test(t) || reDMY.test(t)) dateTags.push(t);
  }
  return { tags, dateTags };
}

function normalizeTagsKeepOneDate(tagsArray, targetY, targetM, targetD) {
  const ymd = formatDateYMD(targetY, targetM, targetD);
  const dmy = formatDateDMY(targetY, targetM, targetD);

  // 동일 날짜(두 포맷 모두) 제거
  const keep = [];
  for (const t of tagsArray) {
    if (t === ymd || t === dmy) continue; // 동일 날짜는 일단 제거
    keep.push(t); // 다른 날짜/일반 태그는 유지
  }

  // 선호 포맷 1개만 추가
  const preferred = formatTagByPreference(targetY, targetM, targetD);
  if (!keep.includes(preferred)) keep.push(preferred);

  return keep;
}

/* ========== Shopify API 호출 ========== */
async function getOrder({ store, token, apiVersion, orderId }) {
  const url = `https://${store}.myshopify.com/admin/api/${apiVersion}/orders/${orderId}.json?fields=id,tags,note`;
  const resp = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`GET /orders failed: ${resp.status} ${text}`);
  }
  const data = await resp.json();
  return data.order;
}

async function updateOrder({ store, token, apiVersion, orderId, nextTags, nextNote }) {
  const url = `https://${store}.myshopify.com/admin/api/${apiVersion}/orders/${orderId}.json`;
  const body = { order: { id: orderId } };
  if (typeof nextTags === "string") body.order.tags = nextTags;
  if (typeof nextNote === "string") body.order.note = nextNote;

  const resp = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`PUT /orders failed: ${resp.status} ${text}`);
  }
}

/* ===================== 핸들러 ===================== */
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    const raw = await rawBody(req);

    // HMAC 검증
    const hmac = req.headers["x-shopify-hmac-sha256"];
    if (!verifyHmac(raw, hmac, process.env.SHOPIFY_WEBHOOK_SECRET)) {
      return res.status(401).send("Invalid HMAC");
    }

    const topic = req.headers["x-shopify-topic"]; // orders/create, orders/updated 등
    const payload = JSON.parse(raw.toString("utf8"));

    // 주문 생성 직후 짧은 시간 안에서만 실행 (사후 수동 수정 보호)
    const createdAt = payload?.created_at ? new Date(payload.created_at) : null;
    let withinWindow = false;
    if (createdAt && !isNaN(createdAt.getTime())) {
      const now = new Date();
      const diffSec = (now.getTime() - createdAt.getTime()) / 1000;
      withinWindow = diffSec >= 0 && diffSec <= CLEAN_WINDOW_SECONDS;
    }
    const allowedByTopic =
      topic === "orders/create" || (topic === "orders/updated" && withinWindow);
    if (!allowedByTopic) return res.status(200).send("ok");

    // 메모에서 배송일 추출
    const ymd = extractDeliveryYMD(payload?.note || "");
    if (!ymd) return res.status(200).send("ok");

    const store = process.env.SHOPIFY_STORE;
    const token = process.env.SHOPIFY_ADMIN_API_TOKEN;
    const apiVersion = process.env.SHOPIFY_API_VERSION || "2025-07";
    const orderId = payload.id;

    // 최신 상태 읽기
    const current = await getOrder({ store, token, apiVersion, orderId });
    const currentTags = String(current.tags || "");
    const currentNote = String(current.note || "");

    // 태그 정규화: 동일 날짜는 선호 포맷 1개만 남김
    const { tags: tagArr } = findDateTagsInTags(currentTags);
    const nextTagsArr = normalizeTagsKeepOneDate(tagArr, ymd.y, ymd.m, ymd.d);
    const nextTags = nextTagsArr.join(", ");

    // 메모에서 (Delivery Date: …) 블록만 제거
    const { cleaned: nextNote, changed } = stripDeliveryDateBlock(currentNote);

    // 변경이 있으면 한 번에 업데이트
    if (changed || nextTags !== currentTags) {
      await updateOrder({
        store,
        token,
        apiVersion,
        orderId,
        nextTags,
        nextNote,
      });
    }

    return res.status(200).send("ok");
  } catch (e) {
    console.error(e);
    return res.status(500).send("error");
  }
};

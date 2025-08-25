// api/clean-note.js
const crypto = require("crypto");

// ===== 설정 =====
// 주문 생성 직후 몇 초 동안만 자동 정리 (기본 60초)
// Vercel 환경변수 CLEAN_WINDOW_SECONDS 로 조절 가능 (예: 30)
const CLEAN_WINDOW_SECONDS = Number(process.env.CLEAN_WINDOW_SECONDS || 60);

// ---- raw body (HMAC 검증용)
async function rawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

// ---- HMAC 검증
function verifyHmac(raw, hmacHeader, secret) {
  const digest = crypto.createHmac("sha256", secret).update(raw).digest("base64");
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader || "", "utf8"));
}

// ---- note에서 (Delivery Date: …) 블록만 제거 (괄호 포함, 본문 보존)
function stripDeliveryDateBlock(note) {
  if (!note) return { cleaned: "", changed: false };
  let cleaned = String(note);

  const patterns = [
    // (Delivery Date: 26/08/2025), (Delivery Date: 26-08-2025)
    /\s*\(\s*delivery\s*date\s*:\s*\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\s*\)\s*/gim,
    // (Delivery Date: 2025/08/26), (Delivery Date: 2025-08-26)
    /\s*\(\s*delivery\s*date\s*:\s*\d{4}[\/\-]\d{2}[\/\-]\d{2}\s*\)\s*/gim,
  ];

  const before = cleaned;
  patterns.forEach((re) => {
    cleaned = cleaned.replace(re, " ");
  });

  cleaned = cleaned
    .replace(/[ \t]+\n/g, "\n")  // 줄 끝 공백 정리
    .replace(/\n{3,}/g, "\n\n")  // 과한 개행 정리
    .trim();

  return { cleaned, changed: cleaned !== before.trim() };
}

// ---- note에서 날짜 추출 (태그로 쓰기 위함). YYYY-MM-DD 형태로 정규화 반환.
function extractDeliveryDateTag(note) {
  if (!note) return null;
  const s = String(note);

  // 26/08/2025 or 26-08-2025
  let m = s.match(/\(.*?delivery\s*date\s*:\s*(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4}).*?\)/i);
  if (m) {
    const [ , dd, mm, yy ] = m;
    const day = dd.padStart(2, "0");
    const mon = mm.padStart(2, "0");
    const year = yy.length === 2 ? (Number(yy) >= 70 ? `19${yy}` : `20${yy}`) : yy;
    return `${year}-${mon}-${day}`; // YYYY-MM-DD
  }

  // 2025/08/26 or 2025-08-26
  m = s.match(/\(.*?delivery\s*date\s*:\s*(\d{4})[\/\-](\d{2})[\/\-](\d{2}).*?\)/i);
  if (m) {
    const [ , yyyy, mm, dd ] = m;
    return `${yyyy}-${mm}-${dd}`; // YYYY-MM-DD
  }

  return null;
}

// ---- 주문 가져오기 (최신 tags/note 상태를 안전하게 업데이트 위해)
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

// ---- 주문 업데이트 (tags에 날짜 추가 + note에서 블록 제거)
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

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    const raw = await rawBody(req);

    // Shopify HMAC 검증
    const hmac = req.headers["x-shopify-hmac-sha256"];
    if (!verifyHmac(raw, hmac, process.env.SHOPIFY_WEBHOOK_SECRET)) {
      return res.status(401).send("Invalid HMAC");
    }

    const topic = req.headers["x-shopify-topic"]; // orders/create, orders/updated 등
    const payload = JSON.parse(raw.toString("utf8"));

    // ---- 주문 생성 직후 짧은 시간 안에서만 수행(사후 수동 수정 보호)
    const createdAt = payload?.created_at ? new Date(payload.created_at) : null;
    let withinWindow = false;
    if (createdAt && !isNaN(createdAt.getTime())) {
      const now = new Date();
      const diffSec = (now.getTime() - createdAt.getTime()) / 1000;
      withinWindow = diffSec >= 0 && diffSec <= CLEAN_WINDOW_SECONDS;
    }
    const allowedByTopic =
      topic === "orders/create" || (topic === "orders/updated" && withinWindow);

    if (!allowedByTopic) {
      return res.status(200).send("ok");
    }

    // 1) note에서 배송일자 태그값 추출
    const deliveryTag = extractDeliveryDateTag(payload?.note || "");
    if (!deliveryTag) {
      // 없으면 할 게 없음
      return res.status(200).send("ok");
    }

    // 2) 최신 주문 데이터 한번 읽어서 tags/note 동기화 안전 업데이트
    const store = process.env.SHOPIFY_STORE;
    const token = process.env.SHOPIFY_ADMIN_API_TOKEN;
    const apiVersion = process.env.SHOPIFY_API_VERSION || "2025-07";
    const orderId = payload.id;

    const current = await getOrder({ store, token, apiVersion, orderId });
    const currentTags = String(current.tags || "");
    const currentNote = String(current.note || "");

    // 3) tags에 배송일자 태그가 없다면 추가
    const tagList = currentTags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    if (!tagList.includes(deliveryTag)) {
      tagList.push(deliveryTag);
    }
    const nextTags = tagList.join(", ");

    // 4) note에서 "(Delivery Date: ...)" 블록만 제거
    const { cleaned: nextNote, changed } = stripDeliveryDateBlock(currentNote);

    // 변경사항이 있으면 한 번에 업데이트 (tags + note)
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

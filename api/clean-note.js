// api/clean-note.js
const crypto = require("crypto");

// ===== 설정 =====
// 주문 생성 직후 몇 초 동안만 자동 정리 (기본 60초)
// Vercel에서 CLEAN_WINDOW_SECONDS 환경변수로 조절 가능 (예: 30)
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

// ---- "(Delivery Date: ...)" 블록만 제거 (괄호 포함, 본문 보존)
function stripDeliveryDateBlock(note) {
  if (!note) return { cleaned: "", changed: false };
  let cleaned = String(note);

  // 예: (Delivery Date: 26/08/2025), (Delivery Date: 2025-08-26)
  const patterns = [
    /\s*\(\s*delivery\s*date\s*:\s*\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\s*\)\s*/gim,
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

// ---- 태그에 날짜/Delivery Date 관련 태그가 있는지 (앱이 태그 작업 완료했는지) 확인
function hasDateTag(tagsString) {
  if (!tagsString) return false;
  const tags = String(tagsString)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const dateTagPatterns = [
    /^\d{4}-\d{2}-\d{2}$/,                 // 2025-08-31
    /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/, // 31/08/2025, 31-08-2025
    /^delivery date[:\s-]?/,               // "Delivery Date: ..."
  ];
  return tags.some((t) => dateTagPatterns.some((re) => re.test(t)));
}

// ---- note 업데이트 (tags는 절대 변경 X)
async function updateOrderNote({ store, token, apiVersion, orderId, note }) {
  const url = `https://${store}.myshopify.com/admin/api/${apiVersion}/orders/${orderId}.json`;
  const resp = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ order: { id: orderId, note } }),
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

    // ---- "주문 생성 직후" 짧은 시간 안에서만 동작 (수동 수정 보호)
    const createdAt = payload?.created_at ? new Date(payload.created_at) : null;
    let withinWindow = false;
    if (createdAt && !isNaN(createdAt.getTime())) {
      const now = new Date();
      const diffSec = (now.getTime() - createdAt.getTime()) / 1000;
      withinWindow = diffSec >= 0 && diffSec <= CLEAN_WINDOW_SECONDS;
    }

    // create 이벤트는 그대로, updated는 "생성 직후 짧은 시간 안"만 허용
    const allowedByTopic =
      topic === "orders/create" || (topic === "orders/updated" && withinWindow);

    if (!allowedByTopic) {
      // 생성 후 시간이 꽤 지난 수정(=사람이 수동으로 추가 가능성)이라면 절대 건드리지 않음
      return res.status(200).send("ok");
    }

    const originalNote = payload?.note || "";
    const tags = payload?.tags || "";

    // 앱이 태그를 먼저 달아둔 걸 확인(태그가 보존돼야 하므로)
    const tagReady = hasDateTag(tags);

    if (tagReady && originalNote) {
      // "(Delivery Date: ...)" 블록만 제거
      const { cleaned, changed } = stripDeliveryDateBlock(originalNote);

      if (changed) {
        await updateOrderNote({
          store: process.env.SHOPIFY_STORE,
          token: process.env.SHOPIFY_ADMIN_API_TOKEN,
          apiVersion: process.env.SHOPIFY_API_VERSION || "2025-07",
          orderId: payload.id,
          note: cleaned, // ✅ 고객 메시지는 보존, 괄호+날짜 블록만 제거
        });
      }
    }

    return res.status(200).send("ok");
  } catch (e) {
    console.error(e);
    return res.status(500).send("error");
  }
};

// api/clean-note.js
const crypto = require("crypto");

// ---- 설정: 주문 생성 후 몇 분 안에만 자동 정리할지 (수동 추가 보호용)
const CLEAN_WINDOW_MINUTES = Number(process.env.CLEAN_WINDOW_MINUTES || 10);

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

// ---- "(Delivery Date: ...)" 블록만 제거(괄호 포함)
// 다양한 날짜 포맷 지원, 여러 개면 모두 제거. 본문은 보존.
function stripDeliveryDateBlock(note) {
  if (!note) return { cleaned: "", changed: false };
  let cleaned = String(note);

  const patterns = [
    // (Delivery Date: 26/08/2025) / (Delivery Date: 26-08-2025)
    /\s*\(\s*delivery\s*date\s*:\s*\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\s*\)\s*/gim,
    // (Delivery Date: 2025/08/26) / (Delivery Date: 2025-08-26)
    /\s*\(\s*delivery\s*date\s*:\s*\d{4}[\/\-]\d{2}[\/\-]\d{2}\s*\)\s*/gim,
  ];

  const before = cleaned;
  patterns.forEach((re) => {
    cleaned = cleaned.replace(re, " ");
  });

  cleaned = cleaned.replace(/[ \t]+\n/g, "\n")
                   .replace(/\n{3,}/g, "\n\n")
                   .trim();

  return { cleaned, changed: cleaned !== before.trim() };
}

// ---- 태그 안에 날짜/Delivery Date 관련 태그가 이미 있는지 (앱이 태그 작업 끝냈는지) 확인
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

// ---- note 업데이트 (tags는 절대 변경하지 않음)
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

    // ---- 수동 추가를 보호하기 위한 시간 조건
    // created_at 기준으로 현재 시각과 차이를 계산, CLEAN_WINDOW_MINUTES 안에서만 작동
    const createdAt = new Date(payload?.created_at || payload?.created_at_ms || 0);
    const now = new Date();
    const minutesSinceCreate = (now - createdAt) / 60000;

    const withinWindow = minutesSinceCreate >= 0 && minutesSinceCreate <= CLEAN_WINDOW_MINUTES;

    // 권장: orders/create는 항상 허용, orders/updated는 "생성 후 짧은 시간 안"만 허용
    const allowedByTopic =
      topic === "orders/create" || (topic === "orders/updated" && withinWindow);

    if (!allowedByTopic) {
      // 생성 오래 지난 후의 업데이트(=사람이 수동으로 남긴 경우일 가능성 높음)는 건너뜀
      return res.status(200).send("ok");
    }

    const originalNote = payload?.note || "";
    const tags = payload?.tags || "";

    // 앱이 태그 작업을 끝냈는지 확인 (가능하면 태그가 이미 있어야 note를 손댐)
    const tagReady = hasDateTag(tags);

    // "(Delivery Date: ...)" 블록만 제거
    if (tagReady && originalNote) {
      const { cleaned, changed } = stripDeliveryDateBlock(originalNote);
      if (changed) {
        await updateOrderNote({
          store: process.env.SHOPIFY_STORE,
          token: process.env.SHOPIFY_ADMIN_API_TOKEN,
          apiVersion: process.env.SHOPIFY_API_VERSION || "2025-07",
          orderId: payload.id,
          note: cleaned, // 고객 메세지는 그대로, 괄호 블록만 제거
        });
      }
    }

    return res.status(200).send("ok");
  } catch (e) {
    console.error(e);
    return res.status(500).send("error");
  }
};

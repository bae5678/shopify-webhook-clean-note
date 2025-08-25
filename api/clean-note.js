// api/clean-note.js  (브라우저에서 그대로 붙여넣기)
const crypto = require("crypto");

// raw body 읽기 (HMAC 검증용)
async function rawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

// HMAC 검증
function verifyHmac(raw, hmacHeader, secret) {
  const digest = crypto.createHmac("sha256", secret).update(raw).digest("base64");
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader || "", "utf8"));
}

// "날짜만 있는 노트" 판별 패턴
const dateOnlyPatterns = [
  /^\s*\d{4}-\d{2}-\d{2}\s*$/,                       // 2025-08-31
  /^\s*\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\s*$/,       // 31/08/2025, 31-08-2025
  /^\s*(delivery\s*date|delivery\s*day|배송일|납품일)\s*[:\-]?\s*\d{4}-\d{2}-\d{2}\s*$/i,
  /^\s*\d{1,2}\s+[A-Za-z]{3,}\s+\d{2,4}\s*$/,        // 31 Aug 2025
  /^\s*[A-Za-z]{3,}\s+\d{1,2},?\s+\d{2,4}\s*$/,      // Aug 31, 2025
];

function isDateOnlyNote(note) {
  const t = String(note || "").trim();
  if (!t) return false;
  return dateOnlyPatterns.some((re) => re.test(t));
}

// Shopify 주문 note 비우기
async function clearOrderNote({ store, token, apiVersion, orderId }) {
  const url = `https://${store}.myshopify.com/admin/api/${apiVersion}/orders/${orderId}.json`;
  const resp = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ order: { id: orderId, note: "" } }),
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

    const hmac = req.headers["x-shopify-hmac-sha256"];
    if (!verifyHmac(raw, hmac, process.env.SHOPIFY_WEBHOOK_SECRET)) {
      return res.status(401).send("Invalid HMAC");
    }

    const payload = JSON.parse(raw.toString("utf8"));
    // note가 "날짜만"이면 비우기
    if (payload?.note && isDateOnlyNote(payload.note)) {
      await clearOrderNote({
        store: process.env.SHOPIFY_STORE,
        token: process.env.SHOPIFY_ADMIN_API_TOKEN,
        apiVersion: process.env.SHOPIFY_API_VERSION || "2025-07",
        orderId: payload.id,
      });
    }

    return res.status(200).send("ok");
  } catch (e) {
    console.error(e);
    return res.status(500).send("error");
  }
};

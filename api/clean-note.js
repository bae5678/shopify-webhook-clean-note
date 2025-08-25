// api/clean-note.js
const crypto = require("crypto");

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

// ---- "날짜만 있는 노트" 판별 패턴
const dateOnlyPatterns = [
  /^\s*\d{4}-\d{2}-\d{2}\s*$/,                        // 2025-08-31
  /^\s*\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\s*$/,        // 31/08/2025, 31-08-2025
  /^\s*(delivery\s*date|delivery\s*day|배송일|납품일)\s*[:\-]?\s*\d{4}-\d{2}-\d{2}\s*$/i,
  /^\s*\d{1,2}\s+[A-Za-z]{3,}\s+\d{2,4}\s*$/,         // 31 Aug 2025
  /^\s*[A-Za-z]{3,}\s+\d{1,2},?\s+\d{2,4}\s*$/,       // Aug 31, 2025
];

function isDateOnlyNote(note) {
  const t = String(note || "").trim();
  if (!t) return false;
  return dateOnlyPatterns.some((re) => re.test(t));
}

// ---- 태그 안에 “날짜(또는 Delivery Date)”가 이미 있는지 확인
function hasDateTag(tagsString) {
  if (!tagsString) return false;
  const tags = String(tagsString)
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

  // 예: "26-08-2025", "26/08/2025", "delivery date: 26/08/2025" 등
  const dateTagPatterns = [
    /^\d{4}-\d{2}-\d{2}$/,                 // 2025-08-31
    /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/, // 31/08/2025, 31-08-2025
    /^delivery date[:\s-]?/,               // "Delivery Date: ..."
  ];

  return tags.some(tag => dateTagPatterns.some(re => re.test(tag)));
}

// ---- Shopify 주문 note 비우기 (tags는 절대 건드리지 않음)
async function clearOrderNote({ store, token, apiVersion, orderId }) {
  const url = `https://${store}.myshopify.com/admin/api/${apiVersion}/orders/${orderId}.json`;
  const resp = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({
      order: { id: orderId, note: "" }, // ✅ note만 비움
    }),
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
    const note = payload?.note;
    const tags = payload?.tags || "";  // Shopify는 콤마로 연결된 문자열로 옴

    // 1) 노트가 "날짜만"인 경우에만 대상
    // 2) 그리고 이미 "태그에 날짜가 붙어있을 때"만 note를 비움
    if (isDateOnlyNote(note) && hasDateTag(tags)) {
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

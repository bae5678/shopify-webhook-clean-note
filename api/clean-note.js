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

// ---- "(Delivery Date: ...)" 블록만 제거
// - 괄호 포함 전체 제거
// - 공백/대소문자/구분자( / 또는 - ) 유연 처리
// - 여러 개 있으면 모두 제거
function stripDeliveryDateBlock(note) {
  if (!note) return { cleaned: "", changed: false };
  let cleaned = String(note);

  // 패턴들: (Delivery Date: 26/08/2025), (Delivery Date: 2025-08-26) 등
  const patterns = [
    /\s*\(\s*delivery\s*date\s*:\s*\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\s*\)\s*$/gim,
    /\s*\(\s*delivery\s*date\s*:\s*\d{4}[\/\-]\d{2}[\/\-]\d{2}\s*\)\s*$/gim,
    // 앞/중간에 있어도 제거 (줄바꿈 앞뒤 포함)
    /\s*\(\s*delivery\s*date\s*:\s*\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\s*\)\s*/gim,
    /\s*\(\s*delivery\s*date\s*:\s*\d{4}[\/\-]\d{2}[\/\-]\d{2}\s*\)\s*/gim,
  ];

  const before = cleaned;
  patterns.forEach((re) => {
    cleaned = cleaned.replace(re, (m, ...rest) => {
      // 앞뒤에 남는 과한 공백/개행 정리
      return " ";
    });
  });

  cleaned = cleaned.replace(/[ \t]+\n/g, "\n")   // 줄 끝 여분 공백 제거
                   .replace(/\n{3,}/g, "\n\n")  // 과한 개행 정리
                   .trim();

  return { cleaned, changed: cleaned !== before.trim() };
}

// ---- note 업데이트 (tags는 절대 건드리지 않음)
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

    const payload = JSON.parse(raw.toString("utf8"));
    const originalNote = payload?.note || "";

    // "(Delivery Date: ...)" 부분만 제거
    const { cleaned, changed } = stripDeliveryDateBlock(originalNote);

    if (changed) {
      await updateOrderNote({
        store: process.env.SHOPIFY_STORE,
        token: process.env.SHOPIFY_ADMIN_API_TOKEN,
        apiVersion: process.env.SHOPIFY_API_VERSION || "2025-07",
        orderId: payload.id,
        note: cleaned, // ✅ 고객 메세지는 그대로, 괄호 블록만 제거된 note로 업데이트
      });
    }

    return res.status(200).send("ok");
  } catch (e) {
    console.error(e);
    return res.status(500).send("error");
  }
};

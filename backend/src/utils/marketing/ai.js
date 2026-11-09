/**
 * AI-drafted replies with Google Gemini (the company's key from Settings → Integrations, as for bills from PDF).
 * Drafts are shown in the Inbox for approval; they're sent automatically only where the company switched that on.
 */
const BASE = () => (process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com").replace(/\/$/, "");
const MODELS = ["gemini-flash-latest", "gemini-2.5-flash"];

const keyOf = (org) => org?.ai?.geminiKey || process.env.GEMINI_API_KEY || "";

async function generate(org, prompt) {
  const key = keyOf(org);
  if (!key) throw new Error("Add a Google Gemini API key in Settings → Integrations to get AI drafts");
  const pref = org.ai?.model || org.ai?.resolvedModel || process.env.GEMINI_MODEL || "";
  let last = "";
  for (const m of pref ? [pref, ...MODELS.filter((x) => x !== pref)] : MODELS) {
    const res = await fetch(`${BASE()}/v1beta/models/${encodeURIComponent(m)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.4, maxOutputTokens: 600 } }),
      signal: AbortSignal.timeout(45000),
    });
    const j = await res.json().catch(() => ({}));
    if (res.ok) return (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
    last = j.error?.message || `HTTP ${res.status}`;
    if (res.status !== 404) break;
  }
  throw new Error(`Gemini couldn't draft a reply: ${last}`);
}

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" }) : "");
const STATUS = { new: "received, being prepared", packed: "packed", ready_to_ship: "packed, waiting for courier pickup", shipped: "shipped", delivered: "delivered", rto: "being returned to us (RTO)", return_created: "return requested", returned: "returned", cancelled: "cancelled" };

function buildPrompt({ orgName, channel, contactName, messages, orders, instructions }) {
  const thread = messages.slice(-15).map((m) => `${m.direction === "in" ? "Customer" : "Us"}: ${String(m.text || `[${m.kind}]`).slice(0, 600)}`).join("\n");
  const ords = orders.slice(0, 5).map((o) => `- ${o.name} on ${fmtDate(o.orderDate)}: ₹${o.total} ${o.paymentMode === "cod" ? "COD" : "prepaid"}, status ${STATUS[o.status] || o.status}${o.shipment?.awb ? `, ${o.shipment.courierName || "courier"} AWB ${o.shipment.awb}${o.shipment.trackingUrl ? ` (track: ${o.shipment.trackingUrl})` : ""}` : ""}; items: ${(o.lines || []).map((l) => `${l.quantity}× ${l.title}`).join(", ").slice(0, 200)}`).join("\n");
  return `You are a polite, concise customer-support agent for ${orgName}, an Indian online store, replying on ${channel.replace("_", " ")}.
Write ONLY the reply text to send to ${contactName || "the customer"} — no greetings like "Subject:", no placeholders, no markdown.
Keep it under 80 words, in the customer's language (English, Hindi or Hinglish as they wrote). Use only facts below; if you don't know, say the team will check and get back.
Never promise refunds, cancellations or delivery dates that aren't in the facts.${instructions ? `\nCompany instructions: ${instructions}` : ""}

Customer's orders:
${ords || "(no orders found for this contact)"}

Conversation:
${thread}

Reply:`;
}

module.exports = { generate, buildPrompt, keyOf, STATUS };

/**
 * Google Gemini for OrdexaGo's AI features, on the company's own API key (Settings → Integrations) or
 * GEMINI_API_KEY on the server. `ask` = one prompt → text (or JSON); `chat` = a conversation with tools
 * (function calling): Gemini asks for data, we run the tool and hand the result back, until it answers.
 */
const BASE = () => (process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com").replace(/\/$/, "");
// Tried in order: the company's chosen model first, then these. A busy / overloaded model (503, 500, 429 "high
// demand") is retried once after a short wait and then the next model is used.
const MODELS = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-flash-lite-latest", "gemini-2.5-flash-lite"];

const keyOf = (org) => org?.ai?.geminiKey || process.env.GEMINI_API_KEY || "";

class AiError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(org, body, { timeout = 75000, deadline = Date.now() + 150000 } = {}) {
  const key = keyOf(org);
  if (!key) throw new AiError("Add your Google Gemini API key in Settings → Integrations to use AI");
  const pref = org.ai?.model || process.env.GEMINI_MODEL || "";
  const models = [...new Set([pref, org.ai?.resolvedModel, ...MODELS].filter(Boolean))];
  let last = "";
  let busy = false;
  for (const m of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const left = deadline - Date.now();
      if (left < 5000) throw new AiError(busy ? "Gemini is very busy right now — please try again in a minute" : "Gemini took too long to answer — try again", 503);
      let res;
      try {
        res = await fetch(`${BASE()}/v1beta/models/${encodeURIComponent(m)}:generateContent`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(Math.min(timeout, left)),
        });
      } catch (e) {
        last = e.name === "TimeoutError" ? "no answer in time" : e.message;
        busy = true;
        break; // next model
      }
      const j = await res.json().catch(() => ({}));
      if (res.ok) return j;
      last = j.error?.message || `HTTP ${res.status}`;
      if (res.status === 400 && /api key/i.test(last)) throw new AiError("Gemini rejected the API key — check it in Settings → Integrations");
      if (res.status === 403) throw new AiError(`Gemini refused the request: ${last}`, 403);
      if (res.status === 404) break; // model not available on this key: next one
      const overloaded = res.status === 503 || res.status === 500 || res.status === 502 || res.status === 504 || (res.status === 429 && /demand|overload|unavailable/i.test(last));
      if (res.status === 429 && !overloaded) throw new AiError("Your Gemini key's usage limit was reached for now — try again in a minute, or raise the limit in Google AI Studio", 429);
      if (!overloaded) throw new AiError(`Gemini error: ${last}`, 502);
      busy = true;
      if (attempt === 0) await wait(2000);
    }
  }
  throw new AiError(busy ? "Gemini is very busy right now — please try again in a minute" : `Gemini error: ${last}`, 503);
}

const textOf = (j) => (j.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("").trim();

/** One prompt → text, or parsed JSON with { json: true }. */
async function ask(org, prompt, { json = false, temperature = 0.3, maxTokens = 2048, system } = {}) {
  const j = await call(org, {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature, maxOutputTokens: maxTokens, ...(json ? { responseMimeType: "application/json" } : {}) },
  });
  const t = textOf(j);
  if (!json) return t;
  try {
    return JSON.parse(t.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    throw new AiError("Gemini's answer couldn't be read — try again", 502);
  }
}

/**
 * A conversation with tools. history = [{ role: "user"|"model", text }]; tools = [{ name, description, parameters, run(args) }].
 * Returns { text, used: [tool names] }.
 */
async function chat(org, { system, history, tools, maxSteps = 8 }) {
  const contents = history.map((m) => ({ role: m.role === "model" ? "model" : "user", parts: [{ text: String(m.text || "").slice(0, 4000) }] }));
  const decl = tools.map(({ name, description, parameters }) => ({ name, description, ...(parameters ? { parameters } : {}) }));
  const used = [];
  const deadline = Date.now() + 160000; // the whole conversation turn (the web server waits 180 s)
  for (let step = 0; step < maxSteps; step++) {
    const j = await call(org, {
      systemInstruction: { parts: [{ text: system }] },
      contents,
      tools: [{ functionDeclarations: decl }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 4096 },
    }, { deadline });
    const content = j.candidates?.[0]?.content;
    const parts = content?.parts || [];
    const calls = parts.filter((p) => p.functionCall);
    if (!calls.length) {
      const t = textOf(j);
      if (!t && j.candidates?.[0]?.finishReason === "SAFETY") return { text: "I can't answer that one.", used };
      return { text: t || "I couldn't find an answer to that.", used };
    }
    contents.push(content); // as returned (keeps Gemini's thought signatures)
    const responses = [];
    for (const p of calls) {
      const { name, args } = p.functionCall;
      const tool = tools.find((t) => t.name === name);
      used.push(name);
      let result;
      try {
        result = tool ? await tool.run(args || {}) : { error: `No tool called ${name}` };
      } catch (e) {
        result = { error: e.message };
      }
      responses.push({ functionResponse: { name, response: { result } } });
    }
    contents.push({ role: "user", parts: responses });
  }
  return { text: "That needed more steps than I can take in one go — try asking a narrower question.", used };
}

module.exports = { ask, chat, keyOf, AiError };

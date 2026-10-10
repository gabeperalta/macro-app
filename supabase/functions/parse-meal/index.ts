// Supabase Edge Function: parse-meal
// Secrets: GEMINI_API_KEY (required), USDA_API_KEY (optional, falls back to DEMO_KEY),
//          GEMINI_MODEL (optional, default gemini-3.8-flash), DB_LOOKUP ("off" to disable lookups)
import { PROMPT, extractJson, normalizeItems, offPer100, usdaPer100, refine } from "./logic.js";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version, x-region",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// Never throws: timeouts, network errors, non-2xx and bad JSON all return null.
async function fetchJson(url: string, ms = 4000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { "User-Agent": "MacroLog/1.0 (personal app)" } });
    if (!r.ok) return null;
    try { return JSON.parse(await r.text()); } catch { return null; }
  } catch { return null; } finally { clearTimeout(t); }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function callGemini(model: string, key: string, text: string, jsonMode: boolean) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const gc: Record<string, unknown> = { temperature: 0.2 };
    if (jsonMode) gc.responseMimeType = "application/json";
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST", signal: ctl.signal,
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: PROMPT }] },
        contents: [{ role: "user", parts: [{ text }] }],
        generationConfig: gc,
      }),
    });
    const body = await r.text();
    if (!r.ok) return { status: r.status, err: body.slice(0, 300) };
    let data: any = null; try { data = JSON.parse(body); } catch { return { status: 502, err: "Gemini returned non-JSON" }; }
    const out = data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text || "").join("") || "";
    const parsed = extractJson(out);
    if (!parsed) return { status: 502, err: "Couldn't parse Gemini output" };
    return { items: normalizeItems(parsed) };
  } catch (e) {
    return { status: 504, err: (e as Error).name === "AbortError" ? "Gemini timed out" : String((e as Error).message || e) };
  } finally { clearTimeout(t); }
}

async function askGemini(text: string) {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new Error("GEMINI_API_KEY secret is not set");
  const primary = Deno.env.get("GEMINI_MODEL") || "gemini-3.8-flash";
  const attempts = [[primary, true], [primary, false], [primary, true]] as const;
  let last = "";
  for (let i = 0; i < attempts.length; i++) {
    const res = await callGemini(attempts[i][0], key, text, attempts[i][1]);
    if (res.items) return res.items;
    last = `AI error ${res.status}: ${res.err}`;
    if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404) break; // won't fix itself
    await sleep(600 * (i + 1));
  }
  throw new Error(last);
}

async function lookup(item: any) {
  try {
    if (item.brand) {
      const q = encodeURIComponent(`${item.brand} ${item.query}`);
      const off = await fetchJson(`https://world.openfoodfacts.org/cgi/search.pl?search_terms=${q}&search_simple=1&action=process&json=1&page_size=3&fields=product_name,brands,nutriments`);
      for (const p of Array.isArray(off?.products) ? off.products : []) {
        const r = refine(item, offPer100(p), "openfoodfacts");
        if (r.source !== "ai") return r;
      }
    } else {
      const key = Deno.env.get("USDA_API_KEY") || "DEMO_KEY";
      const q = encodeURIComponent(item.query);
      const u = await fetchJson(`https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${key}&query=${q}&pageSize=3&dataType=Foundation,SR%20Legacy`);
      for (const f of Array.isArray(u?.foods) ? u.foods : []) {
        const r = refine(item, usdaPer100(f), "usda");
        if (r.source !== "ai") return r;
      }
    }
  } catch { /* fall back to AI estimate */ }
  return item;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let text: unknown;
  try { ({ text } = await req.json()); } catch { return json({ error: "Request body must be JSON" }, 400); }
  if (!text || typeof text !== "string") return json({ error: "Missing text" }, 400);
  try {
    let items = await askGemini(text.slice(0, 1000));
    if (Deno.env.get("DB_LOOKUP") !== "off") items = await Promise.all(items.map(lookup));
    return json({ items: items.map(({ name, protein, carbs, fat, source }) => ({ name, protein, carbs, fat, source })) });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 502);
  }
});

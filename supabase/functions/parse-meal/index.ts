// Supabase Edge Function: parse-meal
// Secrets: GEMINI_API_KEY (required), USDA_API_KEY (optional, falls back to DEMO_KEY),
//          GEMINI_MODEL (optional, default gemini-2.5-flash), DB_LOOKUP ("off" to disable lookups)
import { PROMPT, extractJson, normalizeItems, offPer100, usdaPer100, refine } from "./logic.js";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function fetchJson(url: string, ms = 5000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { "User-Agent": "MacroBot/1.0 (personal app)" } });
    return r.ok ? await r.json() : null;
  } catch { return null; } finally { clearTimeout(t); }
}

async function askGemini(text: string) {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new Error("GEMINI_API_KEY secret is not set");
  const model = Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash";
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: PROMPT }] },
      contents: [{ role: "user", parts: [{ text }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
    }),
  });
  if (!r.ok) throw new Error(`Gemini error ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  const out = data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text || "").join("") || "";
  return normalizeItems(extractJson(out));
}

async function lookup(item: any) {
  if (item.brand) {
    const q = encodeURIComponent(`${item.brand} ${item.query}`);
    const off = await fetchJson(`https://world.openfoodfacts.org/cgi/search.pl?search_terms=${q}&search_simple=1&action=process&json=1&page_size=3&fields=product_name,brands,nutriments`);
    for (const p of off?.products || []) {
      const r = refine(item, offPer100(p), "openfoodfacts");
      if (r.source !== "ai") return r;
    }
  } else {
    const key = Deno.env.get("USDA_API_KEY") || "DEMO_KEY";
    const q = encodeURIComponent(item.query);
    const u = await fetchJson(`https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${key}&query=${q}&pageSize=3&dataType=Foundation,SR%20Legacy`);
    for (const f of u?.foods || []) {
      const r = refine(item, usdaPer100(f), "usda");
      if (r.source !== "ai") return r;
    }
  }
  return item;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const { text } = await req.json();
    if (!text || typeof text !== "string") return json({ error: "Missing text" }, 400);
    let items = await askGemini(text.slice(0, 1000));
    if (Deno.env.get("DB_LOOKUP") !== "off") items = await Promise.all(items.map(lookup));
    return json({ items: items.map(({ name, protein, carbs, fat, source }) => ({ name, protein, carbs, fat, source })) });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});

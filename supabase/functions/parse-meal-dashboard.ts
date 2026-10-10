// Single-file version for pasting into the Supabase dashboard editor (keep in sync with parse-meal/index.ts + logic.js)
// Pure helpers (no Deno APIs) so they can be unit-tested with Node.

const PROMPT = `You are a nutrition parser. Split the user's meal description into individual food items.
For each item return:
- name: short readable name incl. brand and amount (e.g. "Kodiak Cakes pancakes, 1 serving")
- brand: brand name or "" if generic
- query: a short search query for a food database (e.g. "kodiak power cakes buttermilk" or "egg whole raw")
- grams: your best estimate of the total weight in grams for the stated amount
- protein, carbs, fat: your best estimate in grams for the stated amount (use the brand's official label when you know it)
Respond with JSON only: {"items":[...]}. If there is no food, return {"items":[]}.`;

const num = v => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0; };
const round1 = n => Math.round(num(n) * 10) / 10;

function extractJson(text) {
  if (!text) return null;
  const clean = String(text).replace(/```(?:json)?/gi, "").trim();
  try { return JSON.parse(clean); } catch {}
  const m = clean.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

function normalizeItems(parsed) {
  const arr = Array.isArray(parsed) ? parsed : parsed?.items;
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 25).filter(x => x && x.name).map(x => ({
    name: String(x.name).slice(0, 200),
    brand: String(x.brand || ""),
    query: String(x.query || x.name).slice(0, 100),
    grams: num(x.grams),
    protein: round1(x.protein), carbs: round1(x.carbs), fat: round1(x.fat),
    source: "ai",
  }));
}

// per100 = {protein,carbs,fat} per 100 g
function scale(per100, grams) {
  const k = num(grams) / 100;
  return { protein: round1(per100.protein * k), carbs: round1(per100.carbs * k), fat: round1(per100.fat * k) };
}

// Accept DB value only if it's in the same ballpark as the AI's estimate (guards against bad matches).
function plausible(ai, db) {
  const kcal = m => 4 * m.protein + 4 * m.carbs + 9 * m.fat;
  const a = kcal(ai), b = kcal(db);
  if (b <= 0) return false;
  if (a <= 0) return true;
  const ratio = b / a;
  return ratio > 0.5 && ratio < 2;
}

function offPer100(product) {
  const n = product?.nutriments;
  if (!n || n.proteins_100g == null || n.carbohydrates_100g == null || n.fat_100g == null) return null;
  return { protein: num(n.proteins_100g), carbs: num(n.carbohydrates_100g), fat: num(n.fat_100g) };
}

// USDA nutrient numbers: 203 protein, 205 carbs, 204 fat (values per 100 g)
function usdaPer100(food) {
  const get = (nums, ids) => {
    const f = food?.foodNutrients?.find(x => nums.includes(String(x.nutrientNumber)) || ids.includes(x.nutrientId));
    return f ? num(f.value) : null;
  };
  const p = get(["203"], [1003]), c = get(["205"], [1005]), f = get(["204"], [1004]);
  if (p == null || c == null || f == null) return null;
  return { protein: p, carbs: c, fat: f };
}

function refine(item, per100, source) {
  if (!per100 || !item.grams) return item;
  const db = scale(per100, item.grams);
  if (!plausible(item, db)) return item;
  return { ...item, ...db, source };
}
// Supabase Edge Function: parse-meal
// Secrets: GEMINI_API_KEY (required), USDA_API_KEY (optional, falls back to DEMO_KEY),
//          GEMINI_MODEL (optional, default gemini-3.8-flash), DB_LOOKUP ("off" to disable lookups)
//          GEMINI_FALLBACK_MODELS (optional, comma-separated; default gemini-3.5-flash-lite,gemini-3.6-flash,gemini-3.1-flash-lite,gemini-flash-latest)

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
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 12000);
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

const DEFAULT_FALLBACKS = "gemini-3.5-flash-lite,gemini-3.6-flash,gemini-3.1-flash-lite,gemini-flash-latest";

// Try GEMINI_MODEL first, then each fallback. Overload/rate-limit/5xx/timeout/unknown model -> next model fast.
async function askGemini(text: string) {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new Error("GEMINI_API_KEY secret is not set");
  const primary = Deno.env.get("GEMINI_MODEL") || "gemini-3.8-flash";
  const fallbacks = (Deno.env.get("GEMINI_FALLBACK_MODELS") ?? DEFAULT_FALLBACKS).split(",").map(s => s.trim()).filter(Boolean);
  const models = [...new Set([primary, ...fallbacks])];
  const deadline = Date.now() + 40000;
  let last = "", busy = true;
  for (const model of models) {
    if (Date.now() > deadline) break;
    for (const jsonMode of [true, false]) {
      const res = await callGemini(model, key, text, jsonMode);
      if (res.items) return res.items;
      last = `AI error ${res.status} (${model}): ${res.err}`;
      if (res.status === 401 || res.status === 403) throw new Error(last); // bad key: no point continuing
      if (res.status !== 429 && res.status !== 504 && !(res.status >= 500 && res.status !== 502)) busy = false;
      if (res.status !== 502) break; // only parse failures retry the same model (without JSON mode)
    }
    await sleep(250);
  }
  throw new Error((busy ? "AI_BUSY: " : "") + last);
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
    const msg = String((e as Error).message || e);
    return json({ error: msg.replace(/^AI_BUSY: /, ""), code: msg.startsWith("AI_BUSY") ? "ai_busy" : "error" }, msg.startsWith("AI_BUSY") ? 503 : 502);
  }
});

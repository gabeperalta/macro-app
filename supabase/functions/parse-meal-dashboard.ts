// Single-file version for pasting into the Supabase dashboard editor
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
//          GEMINI_MODEL (optional, default gemini-2.5-flash), DB_LOOKUP ("off" to disable lookups)

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

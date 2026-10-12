// Pure helpers (no Deno APIs) so they can be unit-tested with Node.

export const PROMPT = `You are a nutrition parser. Split the user's meal description into individual food items.
For each item return:
- name: short readable name incl. brand and amount (e.g. "Kodiak Cakes pancakes, 1 serving")
- brand: brand name or "" if generic
- query: a short search query for a food database (e.g. "kodiak power cakes buttermilk" or "egg whole raw")
- grams: your best estimate of the total weight in grams for the stated amount
- protein, carbs, fat: your best estimate in grams for the stated amount (use the brand's official label when you know it)
- calories: kcal for the stated amount (use the label's calories when you know it, not a formula)
- sodium_mg: sodium in milligrams; sugar_g: total sugars in grams; sat_fat_g: saturated fat in grams (all for the stated amount)
Respond with JSON only: {"items":[...]}. If there is no food, return {"items":[]}.`;

const num = v => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0; };
// Optional nutrient: null when missing/invalid, otherwise rounded to 0.1.
const opt = v => { if (v == null || v === "") return null; const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n * 10) / 10 : null; };
export const round1 = n => Math.round(num(n) * 10) / 10;

export function extractJson(text) {
  if (!text) return null;
  const clean = String(text).replace(/```(?:json)?/gi, "").trim();
  try { return JSON.parse(clean); } catch {}
  const m = clean.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

export function normalizeItems(parsed) {
  const arr = Array.isArray(parsed) ? parsed : parsed?.items;
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 25).filter(x => x && x.name).map(x => ({
    name: String(x.name).slice(0, 200),
    brand: String(x.brand || ""),
    query: String(x.query || x.name).slice(0, 100),
    grams: num(x.grams),
    protein: round1(x.protein), carbs: round1(x.carbs), fat: round1(x.fat),
    calories: opt(x.calories), sodium_mg: opt(x.sodium_mg), sugar_g: opt(x.sugar_g), sat_fat_g: opt(x.sat_fat_g),
    source: "ai", calories_source: opt(x.calories) == null ? null : "ai",
  }));
}

// per100 = {protein,carbs,fat, calories?,sodium_mg?,sugar_g?,sat_fat_g?} per 100 g; optional ones may be null
export const EXTRA = ["calories", "sodium_mg", "sugar_g", "sat_fat_g"];
export function scale(per100, grams) {
  const k = num(grams) / 100;
  const out = { protein: round1(per100.protein * k), carbs: round1(per100.carbs * k), fat: round1(per100.fat * k) };
  for (const e of EXTRA) out[e] = per100[e] == null ? null : round1(per100[e] * k);
  return out;
}

// Accept DB value only if it's in the same ballpark as the AI's estimate (guards against bad matches).
export function plausible(ai, db) {
  const kcal = m => 4 * m.protein + 4 * m.carbs + 9 * m.fat;
  const a = kcal(ai), b = kcal(db);
  if (b <= 0) return false;
  if (a <= 0) return true;
  const ratio = b / a;
  return ratio > 0.5 && ratio < 2;
}

export function offPer100(product) {
  const n = product?.nutriments;
  if (!n || n.proteins_100g == null || n.carbohydrates_100g == null || n.fat_100g == null) return null;
  const kcal = n["energy-kcal_100g"] != null ? opt(n["energy-kcal_100g"]) : n.energy_100g != null ? opt(Number(n.energy_100g) / 4.184) : null;
  return { protein: num(n.proteins_100g), carbs: num(n.carbohydrates_100g), fat: num(n.fat_100g), calories: kcal,
    sodium_mg: n.sodium_100g == null ? null : opt(Number(n.sodium_100g) * 1000), sugar_g: opt(n.sugars_100g), sat_fat_g: opt(n["saturated-fat_100g"]) };
}

// USDA nutrient numbers: 203 protein, 205 carbs, 204 fat (values per 100 g)
export function usdaPer100(food) {
  const get = (nums, ids) => {
    const f = food?.foodNutrients?.find(x => nums.includes(String(x.nutrientNumber)) || ids.includes(x.nutrientId));
    return f ? num(f.value) : null;
  };
  const p = get(["203"], [1003]), c = get(["205"], [1005]), f = get(["204"], [1004]);
  if (p == null || c == null || f == null) return null;
  // Energy in KCAL: 1008 (208), else Atwater specific/general 2048/2047 (958/957)
  const kcalN = food?.foodNutrients?.find(x => [1008, 2048, 2047].includes(x.nutrientId) || ["208", "958", "957"].includes(String(x.nutrientNumber)));
  const kc = kcalN && (!kcalN.unitName || /kcal/i.test(kcalN.unitName)) ? num(kcalN.value) : null;
  return { protein: p, carbs: c, fat: f, calories: kc, sodium_mg: get(["307"], [1093]), sugar_g: get(["269"], [2000, 1063]), sat_fat_g: get(["606"], [1258]) };
}

export function refine(item, per100, source) {
  if (!per100 || !item.grams) return item;
  const db = scale(per100, item.grams);
  if (!plausible(item, db)) return item;
  const out = { ...item, protein: db.protein, carbs: db.carbs, fat: db.fat, source };
  for (const e of EXTRA) if (db[e] != null) out[e] = db[e];   // keep the AI's value when the source has none
  if (db.calories != null) out.calories_source = source;
  return out;
}

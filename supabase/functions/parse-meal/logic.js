// Pure helpers (no Deno APIs) so they can be unit-tested with Node.

export const PROMPT = `You are a nutrition parser. Split the user's meal description into individual food items.
For each item return:
- name: short readable name incl. brand and amount (e.g. "Kodiak Cakes pancakes, 1 serving")
- brand: brand name or "" if generic
- query: a short search query for a food database (e.g. "kodiak power cakes buttermilk" or "egg whole raw")
- grams: your best estimate of the total weight in grams for the stated amount
- protein, carbs, fat: your best estimate in grams for the stated amount (use the brand's official label when you know it)
Respond with JSON only: {"items":[...]}. If there is no food, return {"items":[]}.`;

const num = v => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0; };
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
    source: "ai",
  }));
}

// per100 = {protein,carbs,fat} per 100 g
export function scale(per100, grams) {
  const k = num(grams) / 100;
  return { protein: round1(per100.protein * k), carbs: round1(per100.carbs * k), fat: round1(per100.fat * k) };
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
  return { protein: num(n.proteins_100g), carbs: num(n.carbohydrates_100g), fat: num(n.fat_100g) };
}

// USDA nutrient numbers: 203 protein, 205 carbs, 204 fat (values per 100 g)
export function usdaPer100(food) {
  const get = (nums, ids) => {
    const f = food?.foodNutrients?.find(x => nums.includes(String(x.nutrientNumber)) || ids.includes(x.nutrientId));
    return f ? num(f.value) : null;
  };
  const p = get(["203"], [1003]), c = get(["205"], [1005]), f = get(["204"], [1004]);
  if (p == null || c == null || f == null) return null;
  return { protein: p, carbs: c, fat: f };
}

export function refine(item, per100, source) {
  if (!per100 || !item.grams) return item;
  const db = scale(per100, item.grams);
  if (!plausible(item, db)) return item;
  return { ...item, ...db, source };
}

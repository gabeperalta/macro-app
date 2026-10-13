import assert from "node:assert";
import * as L from "./logic.js";
const raw = '```json\n{"items":[{"name":"Kodiak pancakes, 1 serving","brand":"Kodiak Cakes","query":"kodiak power cakes","grams":53,"protein":14,"carbs":30,"fat":2},{"name":"3 eggs","brand":"","query":"egg whole raw","grams":150,"protein":19,"carbs":1,"fat":15},{"bad":1}]}\n```';
const items = L.normalizeItems(L.extractJson(raw));
assert.equal(items.length, 2);
assert.equal(items[1].protein, 19);
assert.deepEqual(L.normalizeItems(L.extractJson("no food here")), []);
const egg = L.usdaPer100({ foodNutrients: [{ nutrientNumber: "203", value: 12.6 }, { nutrientNumber: "205", value: 0.7 }, { nutrientNumber: "204", value: 9.5 }] });
const r = L.refine(items[1], egg, "usda");
assert.equal(r.source, "usda"); assert.equal(r.protein, 18.9); assert.equal(r.fat, 14.3);
// implausible match is rejected
const bad = L.refine(items[1], { protein: 0, carbs: 90, fat: 30 }, "usda");
assert.equal(bad.source, "ai");
const off = L.offPer100({ nutriments: { proteins_100g: 26.4, carbohydrates_100g: 56.6, fat_100g: 3.8 } });
assert.equal(L.refine(items[0], off, "openfoodfacts").protein, 14);
assert.equal(L.offPer100({ nutriments: {} }), null);
const ch = L.normalizeItems({ items: [{ name: "cheese", brand: "Kroger", query: "american cheese", grams: 42, protein: 6, carbs: 2, fat: 8, calories: 140, sodium_mg: 520 }] })[0];
assert.equal(ch.calories, 140); assert.equal(ch.calories_source, "ai"); assert.equal(ch.sugar_g, null);
const offc = L.offPer100({ nutriments: { proteins_100g: 14, carbohydrates_100g: 7, fat_100g: 19, "energy-kcal_100g": 333, sodium_100g: 1.2, sugars_100g: 5, "saturated-fat_100g": 11 } });
const rc = L.refine(ch, offc, "openfoodfacts");
assert.equal(rc.calories, 139.9); assert.equal(rc.sodium_mg, 504); assert.equal(rc.calories_source, "openfoodfacts");
const kj = L.offPer100({ nutriments: { proteins_100g: 14, carbohydrates_100g: 7, fat_100g: 19, energy_100g: 1393 } });
assert.equal(Math.round(kj.calories), 333);
const u = L.usdaPer100({ foodNutrients: [{ nutrientId: 1003, value: 12.6 }, { nutrientId: 1005, value: 0.7 }, { nutrientId: 1004, value: 9.5 }, { nutrientId: 1008, value: 143, unitName: "KCAL" }, { nutrientId: 1093, value: 142 }, { nutrientId: 1258, value: 3.1 }] });
assert.equal(u.calories, 143); assert.equal(u.sodium_mg, 142); assert.equal(u.sat_fat_g, 3.1); assert.equal(u.sugar_g, null);
console.log("logic tests passed");
// feedback helpers
const m = (sim, score, extra = {}) => ({ username: "gabeperalta", food_name: "Salmon and grain bowl, 1 bowl", sim, score, age_days: 0,
  orig_protein: 23.4, orig_carbs: 43.6, orig_fat: 14.7, orig_calories: 400, new_protein: 40, new_carbs: 43.6, new_fat: 14.7, new_calories: 466, ...extra });
const sel = L.selectMatches([[m(0.84, 0.84), m(0.4, 0.4), m(0.6, 0.6), m(0.7, 0.7), m(0.9, 0.5)], []]);
assert.equal(sel[0].length, 3); assert.equal(sel[0][0].score, 0.84); assert.equal(sel[1].length, 0);
const fitems = [{ name: "Salmon and grains bowl", protein: 25, carbs: 45, fat: 15, calories: 420 }, { name: "apple", protein: 0, carbs: 25, fat: 0, calories: 95 }];
const blk = L.correctionBlock(fitems, [[m(0.84, 0.84)], []]);
assert.ok(blk.startsWith("USER CORRECTIONS (past edits by app users")); assert.ok(blk.includes("user gabeperalta corrected P23.4 to P40"));
const adj = L.applyAdjust(fitems, [[m(0.84, 0.84)], []], { items: [{ i: 0, protein: 40, carbs: 45, fat: 15, calories: 480, feedback_applied: true }, { i: 1, protein: 9, carbs: 9, fat: 9, feedback_applied: true }] });
assert.equal(adj[0].protein, 40); assert.equal(adj[0].feedback_applied, true); assert.equal(adj[1].protein, 0); assert.equal(adj[1].feedback_applied, false);
console.log("feedback tests passed");

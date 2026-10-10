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
console.log("logic tests passed");

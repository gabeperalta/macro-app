// Supabase Edge Function: parse-meal
// Secrets: GEMINI_API_KEY (required), USDA_API_KEY (optional, falls back to DEMO_KEY),
//          GEMINI_MODEL (optional, default gemini-3.8-flash), DB_LOOKUP ("off" to disable lookups)
//          GEMINI_FALLBACK_MODELS (optional, comma-separated; default gemini-3.5-flash-lite,gemini-3.6-flash,gemini-3.1-flash-lite,gemini-flash-latest)
import { PROMPT, ADJUST_PROMPT, extractJson, normalizeItems, offPer100, usdaPer100, refine, selectMatches, correctionBlock, applyAdjust, PRE_RULES } from "./logic.js";

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

async function callGemini(model: string, key: string, text: string, jsonMode: boolean, system = PROMPT, raw = false) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 12000);
  try {
    const gc: Record<string, unknown> = { temperature: 0.2 };
    if (jsonMode) gc.responseMimeType = "application/json";
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST", signal: ctl.signal,
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
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
    return { items: raw ? parsed : normalizeItems(parsed) };
  } catch (e) {
    return { status: 504, err: (e as Error).name === "AbortError" ? "Gemini timed out" : String((e as Error).message || e) };
  } finally { clearTimeout(t); }
}

const DEFAULT_FALLBACKS = "gemini-3.5-flash-lite,gemini-3.6-flash,gemini-3.1-flash-lite,gemini-flash-latest";

// Try GEMINI_MODEL first, then each fallback. Overload/rate-limit/5xx/timeout/unknown model -> next model fast.
async function askGemini(text: string, system = PROMPT, raw = false) {
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
      const res = await callGemini(model, key, text, jsonMode, system, raw);
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

// Shared feedback: all users' active corrections via match_feedback (service role). Never throws.
async function matchFeedback(name: string) {
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return [];
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 3000);
  try {
    const r = await fetch(`${url}/rest/v1/rpc/match_feedback`, {
      method: "POST", signal: ctl.signal,
      headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` },
      body: JSON.stringify({ p_name: name, p_limit: 3 }),
    });
    if (!r.ok) { console.log("match_feedback failed", r.status, (await r.text()).slice(0, 200)); return []; }
    const d = await r.json(); return Array.isArray(d) ? d : [];
  } catch (e) { console.log("match_feedback error", String(e)); return []; } finally { clearTimeout(t); }
}

async function applyFeedback(items: any[]) {
  if (!items.length || Deno.env.get("FEEDBACK") === "off") return items.map(i => ({ ...i, feedback_applied: false }));
  const selected = selectMatches(await Promise.all(items.map(i => matchFeedback(i.name))));
  const block = correctionBlock(items, selected);
  if (!block) return items.map(i => ({ ...i, feedback_applied: false }));
  console.log("feedback prompt block:\n" + block);
  const list = items.map((it, i) => ({ i, name: it.name, grams: it.grams, protein: it.protein, carbs: it.carbs, fat: it.fat, calories: it.calories }));
  try {
    const parsed = await askGemini(`ITEMS:\n${JSON.stringify(list)}\n\n${block}`, ADJUST_PROMPT, true);
    const out = applyAdjust(items, selected, parsed);
    console.log("feedback applied:", JSON.stringify(out.map(o => ({ name: o.name, protein: o.protein, feedback_applied: o.feedback_applied }))));
    return out;
  } catch (e) {
    console.log("feedback adjust failed", String((e as Error).message || e));
    return items.map(i => ({ ...i, feedback_applied: false }));
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let text: unknown;
  try { ({ text } = await req.json()); } catch { return json({ error: "Request body must be JSON" }, 400); }
  if (!text || typeof text !== "string") return json({ error: "Missing text" }, 400);
  try {
    const t = text.slice(0, 1000);
    // Whole-text pre-match so a corrected combo food (e.g. a bowl) isn't split into parts before matching.
    let pre = "";
    if (Deno.env.get("FEEDBACK") !== "off" && t.length <= 200) {
      const whole = [{ name: t, whole: true }];
      pre = correctionBlock(whole, selectMatches([await matchFeedback(t)]));
      if (pre) console.log("feedback prompt block (whole text):\n" + pre);
    }
    let items = await askGemini(pre ? `${t}\n\n${pre}\n${PRE_RULES}` : t);
    const preApplied = items.map((i: any) => i.feedback_applied === true);
    if (Deno.env.get("DB_LOOKUP") !== "off") items = await Promise.all(items.map(lookup));
    items = (await applyFeedback(items)).map((it: any, i: number) => ({ ...it, feedback_applied: it.feedback_applied || preApplied[i] }));
    return json({ items: items.map(({ name, protein, carbs, fat, calories, sodium_mg, sugar_g, sat_fat_g, source, calories_source, feedback_applied }) => ({ name, protein, carbs, fat, calories, sodium_mg, sugar_g, sat_fat_g, source, calories_source, feedback_applied })) });
  } catch (e) {
    const msg = String((e as Error).message || e);
    return json({ error: msg.replace(/^AI_BUSY: /, ""), code: msg.startsWith("AI_BUSY") ? "ai_busy" : "error" }, msg.startsWith("AI_BUSY") ? 503 : 502);
  }
});

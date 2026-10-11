(() => {
  const cfg = window.MACRO_CONFIG;
  const sb = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storage: window.localStorage, storageKey: "macro-log-auth" } });
  const $ = id => document.getElementById(id);
  let chart, yearChart;

  const toEmail = u => `${u.trim().toLowerCase()}@${cfg.USERNAME_DOMAIN}`;
  const validUser = u => /^[a-z0-9_.-]{3,30}$/i.test(u.trim());
  const dayKey = d => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,"0")}-${String(x.getDate()).padStart(2,"0")}`; };
  const r1 = n => Math.round((Number(n) || 0) * 10) / 10;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

  async function auth(mode) {
    const u = $("username").value, p = $("password").value;
    if (!validUser(u)) return ($("authMsg").textContent = "Username: 3–30 letters, numbers, _ . -");
    if (p.length < 6) return ($("authMsg").textContent = "Password must be at least 6 characters");
    $("authMsg").textContent = "…";
    const fn = mode === "signup" ? sb.auth.signUp.bind(sb.auth) : sb.auth.signInWithPassword.bind(sb.auth);
    const { data, error } = await fn({ email: toEmail(u), password: p, options: { data: { username: u.trim() } } });
    if (error) return ($("authMsg").textContent = error.message.replace(/email/gi, "username"));
    if (mode === "signup" && !data.session) $("authMsg").textContent = "Account created, but email confirmation is ON in Supabase. Turn it off (see README).";
    else $("authMsg").textContent = "";
  }
  $("login").onclick = () => auth("login");
  $("signup").onclick = () => auth("signup");
  $("userBtn").onclick = e => { e.stopPropagation(); $("userMenu").classList.toggle("hidden"); };
  document.addEventListener("click", e => { if (!e.target.closest(".usermenu")) $("userMenu").classList.add("hidden"); });
  $("logout").onclick = () => { $("userMenu").classList.add("hidden"); sb.auth.signOut(); };
  // iOS freezes home-screen apps; refresh the token when we come back.
  document.addEventListener("visibilitychange", () => { if (!document.hidden) sb.auth.getSession(); });

  sb.auth.onAuthStateChange((_e, session) => show(session));
  sb.auth.getSession().then(({ data }) => show(data.session));

  $("pendingLogout").onclick = () => sb.auth.signOut();
  $("pendingRefresh").onclick = () => sb.auth.getSession().then(({ data }) => show(data.session));

  let showSeq = 0;
  async function show(session) {
    const seq = ++showSeq;
    $("auth").classList.toggle("hidden", !!session);
    $("userBtn").classList.toggle("hidden", !session);
    if (session) $("userBtn").textContent = session.user.user_metadata?.username || session.user.email.split("@")[0];
    if (!session) { $("app").classList.add("hidden"); $("pending").classList.add("hidden"); return; }
    $("pendingMsg").textContent = "";
    const { data: prof, error } = await sb.from("profiles").select("approved").eq("id", session.user.id).maybeSingle();
    if (seq !== showSeq) return;
    const ok = !error && prof?.approved === true;
    $("app").classList.toggle("hidden", !ok);
    $("pending").classList.toggle("hidden", ok);
    if (error) $("pendingMsg").textContent = "Couldn't check approval: " + error.message;
    if (ok) { refresh(); loadGoals(); }
  }

  function status(text, isErr) { const s = $("status"); s.textContent = text || ""; s.classList.toggle("err", !!isErr); }

  // Reload when the local calendar day rolls over (app reopened / refocused after midnight).
  let shownDay = null;
  const dayCheck = () => { if (!document.hidden && shownDay && shownDay !== dayKey(new Date()) && !$("app").classList.contains("hidden")) refresh(); };
  document.addEventListener("visibilitychange", dayCheck); window.addEventListener("focus", dayCheck);
  setInterval(dayCheck, 60000);

  // Week query starts at LOCAL midnight 6 days ago (device timezone), sent as ISO/UTC; "today" = local dayKey.
  async function refresh() {
    const start = new Date(); start.setHours(0,0,0,0); start.setDate(start.getDate() - 6);
    const { data, error } = await sb.from("meal_items").select("*").gte("eaten_at", start.toISOString()).order("eaten_at");
    if (error) return status("Load failed: " + error.message, true);
    const days = [];
    for (let i = 0; i < 7; i++) { const d = new Date(start); d.setDate(start.getDate() + i); days.push(d); }
    const tot = Object.fromEntries(days.map(d => [dayKey(d), { p: 0, c: 0, f: 0 }]));
    data.forEach(r => { const t = tot[dayKey(r.eaten_at)]; if (t) { t.p += +r.protein; t.c += +r.carbs; t.f += +r.fat; } });
    const today = tot[dayKey(new Date())];
    $("tP").textContent = Math.round(today.p) + "g"; $("tC").textContent = Math.round(today.c) + "g"; $("tF").textContent = Math.round(today.f) + "g";
    lastToday = { ...today, n: data.filter(r => dayKey(r.eaten_at) === dayKey(new Date())).length }; showGoals();
    const logged = days.map(d => tot[dayKey(d)]).filter((t, i) => data.some(r => dayKey(r.eaten_at) === dayKey(days[i])));
    const wavg = k => logged.length ? Math.round(logged.reduce((s, t) => s + t[k], 0) / logged.length) : 0;
    $("wP").textContent = wavg("p") + "g"; $("wC").textContent = wavg("c") + "g"; $("wF").textContent = wavg("f") + "g";
    shownDay = dayKey(new Date());
    drawChart(days.map(d => d.toLocaleDateString(undefined, { weekday: "short" })), days.map(d => tot[dayKey(d)]));
    loadYear();
    todayRows = {};
    const todays = data.filter(r => dayKey(r.eaten_at) === dayKey(new Date())).reverse();
    todays.forEach(r => todayRows[r.id] = r);
    $("todayList").innerHTML = todays.length ? todays.map(r => `<li><span>${esc(r.name)}<br><small>P ${r1(r.protein)} · C ${r1(r.carbs)} · F ${r1(r.fat)}</small></span><span class="acts"><button class="link icon" data-edit="${r.id}" aria-label="Edit"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg></button><button class="link icon" data-del="${r.id}" aria-label="Delete">✕</button></span></li>`).join("") : "<li><small>Nothing logged yet today.</small></li>";
  }
  $("todayList").onclick = async e => {
    const t = e.target.closest("button"); if (!t) return;
    const li = t.closest("li");
    if (t.dataset.del) { if (!confirm("Delete this item?")) return; await sb.from("meal_items").delete().eq("id", t.dataset.del); return refresh(); }
    if (t.dataset.edit) {
      const r = todayRows[t.dataset.edit]; if (!r) return;
      li.classList.add("editing");
      li.innerHTML = `<div class="editrow"><div class="ename">${esc(r.name)}</div>
        <div class="efields">${[["protein","P"],["carbs","C"],["fat","F"]].map(([k, l]) => `<label>${l}<input data-k="${k}" type="number" inputmode="decimal" min="0" step="any" value="${r1(r[k])}"></label>`).join("")}</div>
        <div class="row"><button data-esave="${r.id}">Save</button><button class="secondary" data-ecancel="1">Cancel</button></div><p class="status err"></p></div>`;
      return;
    }
    if (t.dataset.ecancel) return refresh();
    if (t.dataset.esave) {
      const vals = {}; let bad = false;
      li.querySelectorAll("input[data-k]").forEach(i => { const v = Number(i.value.replace(",", ".")); if (i.value.trim() === "" || !Number.isFinite(v) || v < 0) bad = true; vals[i.dataset.k] = r1(v); });
      if (bad) return (li.querySelector(".status").textContent = "Enter numbers of 0 or more.");
      t.disabled = true;
      const { error } = await sb.from("meal_items").update(vals).eq("id", t.dataset.esave);
      if (error) { t.disabled = false; return (li.querySelector(".status").textContent = "Save failed: " + error.message); }
      refresh();
    }
  };

  // Goals
  let goals = null, lastToday = null, todayRows = {};
  const GK = [["P", "protein", "p"], ["C", "carbs", "c"], ["F", "fat", "f"]];
  async function loadGoals() {
    const { data } = await sb.from("goals").select("*").maybeSingle();
    goals = data || null; showGoals();
  }
  function showGoals() {
    GK.forEach(([K, name, short]) => {
      const dir = goals?.[name + "_dir"], g = goals?.[name + "_g"];
      const has = dir && g != null;
      $("g" + K).textContent = has ? `Goal: ${dir} ${r1(g)}g` : "";
      const tot = lastToday?.[short] ?? 0;
      const met = has && lastToday?.n > 0 && (dir === "over" ? tot >= +g : tot <= +g);
      $("m" + K).classList.toggle("hidden", !met);
    });
  }
  $("goalsBtn").onclick = () => {
    const f = $("goalsForm"); const open = f.classList.toggle("hidden") === false;
    if (open) GK.forEach(([K, name]) => { $("d" + K).value = goals?.[name + "_dir"] || ""; $("v" + K).value = goals?.[name + "_g"] ?? ""; });
    $("goalsMsg").textContent = "";
  };
  $("goalsCancel").onclick = () => $("goalsForm").classList.add("hidden");
  $("goalsSave").onclick = async () => {
    const row = { updated_at: new Date().toISOString() };
    for (const [K, name] of GK) {
      const dir = $("d" + K).value, raw = $("v" + K).value.trim(), v = Number(raw.replace(",", "."));
      if (dir && (raw === "" || !Number.isFinite(v) || v < 0)) { $("goalsMsg").classList.add("err"); return ($("goalsMsg").textContent = `Enter grams (0 or more) for ${name}.`); }
      row[name + "_dir"] = dir || null; row[name + "_g"] = dir ? r1(v) : null;
    }
    const { data: { user } } = await sb.auth.getUser(); row.user_id = user.id;
    $("goalsSave").disabled = true;
    const { data, error } = await sb.from("goals").upsert(row).select().maybeSingle();
    $("goalsSave").disabled = false;
    if (error) { $("goalsMsg").classList.add("err"); return ($("goalsMsg").textContent = "Save failed: " + error.message); }
    goals = data || row; showGoals(); $("goalsForm").classList.add("hidden");
  };

  async function loadYear() {
    const now = new Date(), start = new Date(now.getFullYear(), now.getMonth() - 11, 1);
    const { data, error } = await sb.from("meal_items").select("eaten_at,protein,carbs,fat").gte("eaten_at", start.toISOString()).limit(20000);
    if (error) return;
    const months = [];
    for (let i = 0; i < 12; i++) months.push(new Date(start.getFullYear(), start.getMonth() + i, 1));
    const mk = d => { const x = new Date(d); return x.getFullYear() * 12 + x.getMonth(); };
    const tot = Object.fromEntries(months.map(m => [mk(m), { p: 0, c: 0, f: 0, days: new Set() }]));
    data.forEach(r => { const t = tot[mk(r.eaten_at)]; if (t) { t.p += +r.protein; t.c += +r.carbs; t.f += +r.fat; t.days.add(dayKey(r.eaten_at)); } });
    const avg = months.map(m => { const t = tot[mk(m)], n = t.days.size || 1; return { p: t.p / n, c: t.c / n, f: t.f / n }; });
    const labels = months.map(m => m.toLocaleDateString(undefined, { month: "short" }));
    const ds = (label, key, color) => ({ label, data: avg.map(x => Math.round(x[key])), backgroundColor: color });
    const datasets = [ds("Protein", "p", "#3b82f6"), ds("Carbs", "c", "#ef4444"), ds("Fats", "f", "#22c55e")];
    if (yearChart) { yearChart.data.labels = labels; yearChart.data.datasets = datasets; return yearChart.update(); }
    yearChart = new Chart($("yearChart"), { type: "bar", data: { labels, datasets }, options: chartOpts("g / day (avg of logged days)") });
  }
  const chartOpts = yTitle => ({ maintainAspectRatio: false, plugins: { legend: { labels: { color: "#9aa3b2", boxWidth: 12 } } },
    scales: { x: { ticks: { color: "#9aa3b2" }, grid: { color: "#2c313c" } },
      y: { beginAtZero: true, title: yTitle ? { display: true, text: yTitle, color: "#9aa3b2" } : undefined, ticks: { color: "#9aa3b2" }, grid: { color: "#2c313c" } } } });

  function drawChart(labels, t) {
    const ds = (label, key, color) => ({ label, data: t.map(x => Math.round(x[key])), borderColor: color, backgroundColor: color, tension: .3, pointRadius: 3 });
    const datasets = [ds("Protein", "p", "#3b82f6"), ds("Carbs", "c", "#ef4444"), ds("Fats", "f", "#22c55e")];
    if (chart) { chart.data.labels = labels; chart.data.datasets = datasets; return chart.update(); }
    chart = new Chart($("chart"), { type: "line", data: { labels, datasets },
      options: { maintainAspectRatio: false, plugins: { legend: { labels: { color: "#9aa3b2", boxWidth: 12 } } },
        scales: { x: { ticks: { color: "#9aa3b2" }, grid: { color: "#2c313c" } }, y: { beginAtZero: true, ticks: { color: "#9aa3b2" }, grid: { color: "#2c313c" } } } } });
  }

  $("chatForm").onsubmit = async e => {
    e.preventDefault();
    const text = $("chatInput").value.trim(); if (!text) return;
    $("send").disabled = true; status("Reading your meal…");
    try {
      const { data, error } = await parseMeal(text);
      if (error) throw new Error(error);
      if (!data?.items?.length) return status(data?.error || "I couldn't find any foods in that. Try again?", true);
      // Save immediately; items show up in Today's items where they can be deleted.
      const { data: { user } } = await sb.auth.getUser();
      const now = new Date().toISOString();
      const rows = data.items.map(it => ({ user_id: user.id, eaten_at: now, description: text, name: String(it.name).slice(0, 200),
        protein: r1(it.protein), carbs: r1(it.carbs), fat: r1(it.fat) }));
      const { error: saveErr } = await sb.from("meal_items").insert(rows);
      if (saveErr) return status("Save failed: " + saveErr.message, true);
      $("chatInput").value = ""; grow(); // clear only on success so a failed message can be resent
      status(""); refresh();
    } catch (err) { const m = String(err.message || err); status(/^The AI is busy/.test(m) ? m : "Error: " + m, true); }
    finally { $("send").disabled = false; }
  };

  // Calls the edge function and returns the function's real error message on failure.
  async function parseMeal(text, retried) {
    await sb.auth.getSession(); // refreshes an expired token first
    const { data, error } = await sb.functions.invoke("parse-meal", { body: { text } });
    if (!error) return { data };
    let msg = error.message, status = error.context?.status, code = "";
    try { const b = await error.context.json(); msg = b.error || b.message || msg; code = b.code || ""; } catch {}
    if (code === "ai_busy" || status === 503 || status === 429 || /high demand|overload|busy|UNAVAILABLE|RESOURCE_EXHAUSTED|timed out/i.test(msg))
      return { error: "The AI is busy right now, tap Send to try again." };
    if (status === 401 && !retried) { await sb.auth.refreshSession(); return parseMeal(text, true); }
    return { error: (status ? `(${status}) ` : "") + msg };
  }

  // Auto-growing textarea: Enter sends, Shift+Enter = newline.
  function grow() { if ($("hint")) $("hint").classList.toggle("hidden", !!$("chatInput").value); const t = $("chatInput"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight + 2, 170) + "px"; t.scrollTop = t.scrollHeight; }
  $("chatInput").addEventListener("input", grow);
  $("chatInput").addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("chatForm").requestSubmit ? $("chatForm").requestSubmit() : $("send").click(); }
  });


  // Voice input (Web Speech API; iOS Safari 14.5+ / home-screen PWA)
  // Custom overlay hint (iOS ignores newlines in textarea placeholders).
  let hintBase = "Type to log food", listening = false;
  function hint() {
    $("hint1").textContent = listening ? "Listening…" : hintBase;
    $("hint").classList.toggle("hidden", !!$("chatInput").value);
  }
  $("chatInput").addEventListener("input", hint);
  (function setupMic() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const btn = $("mic"); if (!SR || !btn) return;
    btn.classList.remove("hidden"); hintBase = "Type or tap the mic to log food"; hint();
    let rec = null, base = "";
    const stop = () => { btn.classList.remove("listening"); btn.setAttribute("aria-pressed", "false"); listening = false; hint(); rec = null; };
    btn.addEventListener("click", () => {
      if (rec) { rec.stop(); return; }
      rec = new SR(); rec.lang = navigator.language || "en-US"; rec.interimResults = true; rec.continuous = false;
      base = $("chatInput").value.trim(); base = base ? base + " " : "";
      rec.onresult = e => { let t = ""; for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript; $("chatInput").value = base + t.trim(); grow(); };
      rec.onerror = e => {
        const m = { "not-allowed": "Microphone or speech recognition permission was denied. On iPhone: Settings → Safari → Microphone, and Settings → Privacy & Security → Speech Recognition.",
          "service-not-allowed": "Speech recognition isn't allowed. Enable Siri & Dictation / Speech Recognition in iPhone Settings.",
          "no-speech": "Didn't catch that — try again.", "audio-capture": "I couldn't hear from a microphone. Check that one is connected and that this app is allowed to use it, or just type your meal.", "network": "Speech recognition needs a network connection." }[e.error];
        if (e.error !== "aborted") status(m || ("Voice input error: " + e.error), true);
      };
      rec.onend = () => { stop(); $("chatInput").focus(); };
      try { rec.start(); btn.classList.add("listening"); btn.setAttribute("aria-pressed", "true"); listening = true; hint(); }
      catch (err) { status("Couldn't start voice input: " + err.message, true); stop(); }
    });
  })();

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then(reg => {
    document.addEventListener("visibilitychange", () => { if (!document.hidden) reg.update(); });
  });
})();

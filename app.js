(() => {
  const cfg = window.MACRO_CONFIG;
  const sb = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storage: window.localStorage, storageKey: "macro-log-auth" } });
  const $ = id => document.getElementById(id);
  let chart, yearChart, pending = [], lastText = "";

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
    if (ok) refresh();
  }

  function bubble(text, who) {
    const b = document.createElement("div");
    b.className = "bubble " + who; b.textContent = text;
    $("chat").appendChild(b); $("chat").scrollTop = 1e9;
  }

  async function refresh() {
    const start = new Date(); start.setHours(0,0,0,0); start.setDate(start.getDate() - 6);
    const { data, error } = await sb.from("meal_items").select("*").gte("eaten_at", start.toISOString()).order("eaten_at");
    if (error) return bubble("Load failed: " + error.message, "bot");
    const days = [];
    for (let i = 0; i < 7; i++) { const d = new Date(start); d.setDate(start.getDate() + i); days.push(d); }
    const tot = Object.fromEntries(days.map(d => [dayKey(d), { p: 0, c: 0, f: 0 }]));
    data.forEach(r => { const t = tot[dayKey(r.eaten_at)]; if (t) { t.p += +r.protein; t.c += +r.carbs; t.f += +r.fat; } });
    const today = tot[dayKey(new Date())];
    $("tP").textContent = Math.round(today.p) + "g"; $("tC").textContent = Math.round(today.c) + "g"; $("tF").textContent = Math.round(today.f) + "g";
    drawChart(days.map(d => d.toLocaleDateString(undefined, { weekday: "short" })), days.map(d => tot[dayKey(d)]));
    loadYear();
    const todays = data.filter(r => dayKey(r.eaten_at) === dayKey(new Date())).reverse();
    $("todayList").innerHTML = todays.length ? todays.map(r => `<li><span>${esc(r.name)}<br><small>P ${r1(r.protein)} · C ${r1(r.carbs)} · F ${r1(r.fat)}</small></span><button class="link" data-del="${r.id}">✕</button></li>`).join("") : "<li><small>Nothing logged yet today.</small></li>";
  }
  $("todayList").onclick = async e => {
    const id = e.target.dataset.del; if (!id || !confirm("Delete this item?")) return;
    await sb.from("meal_items").delete().eq("id", id); refresh();
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
    lastText = text; $("chatInput").value = ""; grow(); bubble(text, "me");
    $("send").disabled = true; bubble("Looking that up…", "bot");
    try {
      const { data, error } = await parseMeal(text);
      $("chat").lastChild.remove();
      if (error) throw new Error(error);
      if (!data?.items?.length) return bubble(data?.error || "I couldn't find any foods in that. Try again?", "bot");
      pending = data.items; renderReview();
      bubble("Here's what I found. Edit anything, then Save.", "bot");
    } catch (err) { bubble("Error: " + (err.message || err), "bot"); }
    finally { $("send").disabled = false; }
  };

  // Calls the edge function and returns the function's real error message on failure.
  async function parseMeal(text, retried) {
    await sb.auth.getSession(); // refreshes an expired token first
    const { data, error } = await sb.functions.invoke("parse-meal", { body: { text } });
    if (!error) return { data };
    let msg = error.message, status = error.context?.status;
    try { const b = await error.context.json(); msg = b.error || b.message || msg; } catch {}
    if (status === 401 && !retried) { await sb.auth.refreshSession(); return parseMeal(text, true); }
    return { error: (status ? `(${status}) ` : "") + msg };
  }

  // Auto-growing textarea: Enter sends, Shift+Enter = newline.
  function grow() { const t = $("chatInput"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight + 2, 160) + "px"; t.scrollTop = t.scrollHeight; }
  $("chatInput").addEventListener("input", grow);
  $("chatInput").addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("chatForm").requestSubmit ? $("chatForm").requestSubmit() : $("send").click(); }
  });

  function renderReview() {
    $("reviewBody").innerHTML = pending.map((it, i) => `<tr>
      <td><input data-i="${i}" data-k="name" value="${esc(it.name)}"></td>
      <td><input data-i="${i}" data-k="protein" inputmode="decimal" value="${r1(it.protein)}"></td>
      <td><input data-i="${i}" data-k="carbs" inputmode="decimal" value="${r1(it.carbs)}"></td>
      <td><input data-i="${i}" data-k="fat" inputmode="decimal" value="${r1(it.fat)}"></td>
      <td><button class="link" data-rm="${i}">✕</button></td></tr>`).join("");
    $("review").classList.toggle("hidden", !pending.length);
  }
  $("reviewBody").oninput = e => { const { i, k } = e.target.dataset; if (i) pending[i][k] = k === "name" ? e.target.value : e.target.value; };
  $("reviewBody").onclick = e => { const i = e.target.dataset.rm; if (i !== undefined) { pending.splice(+i, 1); renderReview(); } };
  $("cancel").onclick = () => { pending = []; renderReview(); };
  $("save").onclick = async () => {
    const { data: { user } } = await sb.auth.getUser();
    const now = new Date().toISOString();
    const rows = pending.map(it => ({ user_id: user.id, eaten_at: now, description: lastText, name: String(it.name).slice(0, 200),
      protein: r1(it.protein), carbs: r1(it.carbs), fat: r1(it.fat) }));
    $("save").disabled = true;
    const { error } = await sb.from("meal_items").insert(rows);
    $("save").disabled = false;
    if (error) return bubble("Save failed: " + error.message, "bot");
    bubble(`Saved ${rows.length} item(s).`, "bot"); pending = []; renderReview(); refresh();
  };

  // Voice input (Web Speech API; iOS Safari 14.5+ / home-screen PWA)
  (function setupMic() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const btn = $("mic"); if (!SR || !btn) return;
    btn.classList.remove("hidden");
    let rec = null, base = "";
    const stop = () => { btn.classList.remove("listening"); btn.setAttribute("aria-pressed", "false"); $("chatInput").placeholder = "e.g. 1 serving Kodiak pancakes, 3 eggs"; rec = null; };
    btn.addEventListener("click", () => {
      if (rec) { rec.stop(); return; }
      rec = new SR(); rec.lang = navigator.language || "en-US"; rec.interimResults = true; rec.continuous = false;
      base = $("chatInput").value.trim(); base = base ? base + " " : "";
      rec.onresult = e => { let t = ""; for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript; $("chatInput").value = base + t.trim(); grow(); };
      rec.onerror = e => {
        const m = { "not-allowed": "Microphone or speech recognition permission was denied. On iPhone: Settings → Safari → Microphone, and Settings → Privacy & Security → Speech Recognition.",
          "service-not-allowed": "Speech recognition isn't allowed. Enable Siri & Dictation / Speech Recognition in iPhone Settings.",
          "no-speech": "Didn't catch that — try again.", "audio-capture": "I couldn't hear from a microphone. Check that one is connected and that this app is allowed to use it, or just type your meal.", "network": "Speech recognition needs a network connection." }[e.error];
        if (e.error !== "aborted") bubble(m || ("Voice input error: " + e.error), "bot");
      };
      rec.onend = () => { stop(); $("chatInput").focus(); };
      try { rec.start(); btn.classList.add("listening"); btn.setAttribute("aria-pressed", "true"); $("chatInput").placeholder = "Listening…"; }
      catch (err) { bubble("Couldn't start voice input: " + err.message, "bot"); stop(); }
    });
  })();

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
})();

// Stevens Parking — the student-facing app (follows the MGT 103 mockup).
// One page, several screens chosen by the #hash in the address bar.
(() => {
  const app = document.getElementById("app");
  let S = null; // latest garage state from the server
  let lastStateAt = 0;
  let connected = false;
  let ws;

  // ---------- "Login" (prototype: just a name saved on this phone) ----------
  const user = () => JSON.parse(localStorage.getItem("user") || "null");
  const prefs = () => JSON.parse(localStorage.getItem("prefs") || '{"lowAlert":true}');
  const setPrefs = (p) => localStorage.setItem("prefs", JSON.stringify({ ...prefs(), ...p }));

  // ---------- Live connection ----------
  function connect() {
    ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host);
    ws.onopen = () => { connected = true; };
    ws.onclose = () => { connected = false; render(); setTimeout(connect, 1500); };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "state") {
        const prevOpen = S ? S.open : null;
        S = msg.state;
        lastStateAt = Date.now();
        checkLowAlert(prevOpen);
        render();
      }
      if (msg.type === "hold_result") {
        if (msg.ok) { toast("Space held ✓"); location.hash = "#/myhold"; }
        else { holdError = msg.error; render(); }
      }
    };
  }
  const send = (m) => connected && ws.send(JSON.stringify(m));

  // ---------- Helpers ----------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const timeStr = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const pct = (a, b) => (b ? Math.max(0, Math.min(100, (a / b) * 100)) : 0);

  function levelStatus(open, cap) {
    const f = open / cap;
    if (open <= 0) return { text: "Full", cls: "gray", board: "FULL" };
    if (f < 0.05) return { text: "Almost full", cls: "gray", board: "ALMOST FULL" };
    if (f < 0.15) return { text: "A few left", cls: "orange", board: "A FEW LEFT" };
    return { text: "Plenty of space", cls: "blue", board: "PLENTY" };
  }
  function bestLevel() {
    if (!S.levelsTracked) return null;
    return S.levels.reduce((best, l) => (l.open > best.open ? l : best), S.levels[0]);
  }
  function myHold() {
    const u = user();
    return u && S ? S.holds.find((h) => h.userId === u.id) : null;
  }
  function entranceCams() {
    return S.cameras.filter((c) => c.location === "entrance");
  }

  function trendLine() {
    if (S.open <= 0) return { cls: "", text: "Garage is full right now" };
    if (S.minutesToFull != null && S.minutesToFull <= 60)
      return { cls: "", text: `Filling fast · full in about ${S.minutesToFull} min at this rate` };
    if (S.fillRatePerMin > 0) return { cls: "ok", text: `Filling slowly · about ${Math.max(1, Math.round(S.fillRatePerMin * 10))} cars per 10 min` };
    if (S.fillRatePerMin < -0.1) return { cls: "ok", text: "Emptying out · spaces opening up" };
    return { cls: "ok", text: "Steady right now" };
  }

  let toastTimer;
  function toast(text) {
    let el = document.querySelector(".toast");
    if (!el) { el = document.createElement("div"); el.className = "toast"; document.body.appendChild(el); }
    el.textContent = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), 4000);
  }

  // "Alert me if the garage drops below 20 open"
  function checkLowAlert(prevOpen) {
    if (prevOpen == null || !prefs().lowAlert) return;
    if (prevOpen >= S.lowAlert && S.open < S.lowAlert) {
      const text = `Babbio Garage is almost full — only ${S.open} spaces open`;
      toast("⚠️ " + text);
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
      if ("Notification" in window && Notification.permission === "granted") new Notification("Stevens Parking", { body: text });
    }
  }

  // ---------- Chart: open spaces today (+ dashed trend for the next 30 min) ----------
  function chart(points, cap, ratePerMin) {
    const W = 340, H = 150, padB = 24, padT = 8;
    const now = S.serverTime;
    if (!points.length) points = [{ t: now - 3600e3, v: null }];
    const t0 = Math.min(points[0].t, now - 3600e3);
    const t1 = now + 30 * 60e3;
    const x = (t) => ((t - t0) / (t1 - t0)) * W;
    const y = (v) => padT + (1 - v / cap) * (H - padB - padT);
    const real = points.filter((p) => p.v != null);
    let path = "";
    real.forEach((p, i) => {
      if (i) path += ` L${x(p.t).toFixed(1)},${y(real[i - 1].v).toFixed(1)}`; // step line: value holds until next event
      path += `${i ? " L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`;
    });
    let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">`;
    svg += `<line x1="0" x2="${W}" y1="${H - padB}" y2="${H - padB}" stroke="#e3e5e9"/>`;
    // hour labels
    const startHour = new Date(t0); startHour.setMinutes(0, 0, 0);
    const span = t1 - t0, step = span > 6 * 3600e3 ? 2 * 3600e3 : 3600e3;
    for (let t = startHour.getTime() + 3600e3; t < t1; t += step) {
      if (Math.abs(x(t) - x(now)) < 34) continue;
      const lbl = new Date(t).toLocaleTimeString([], { hour: "numeric" }).replace(" ", " ").toLowerCase();
      svg += `<text x="${x(t)}" y="${H - 6}" font-size="11" fill="#6b6f78" text-anchor="middle">${lbl}</text>`;
    }
    svg += `<line x1="${x(now)}" x2="${x(now)}" y1="0" y2="${H - padB}" stroke="#c9ccd2" stroke-dasharray="3 3"/>`;
    svg += `<text x="${x(now)}" y="${H - 6}" font-size="11" font-weight="700" fill="#15171c" text-anchor="middle">Now</text>`;
    if (real.length) {
      const last = real[real.length - 1];
      path += ` L${x(now).toFixed(1)},${y(last.v).toFixed(1)}`;
      svg += `<path d="${path}" fill="none" stroke="#1f5fd6" stroke-width="2.5" stroke-linejoin="round"/>`;
      const future = Math.max(0, Math.min(cap, last.v - ratePerMin * 30));
      svg += `<line x1="${x(now)}" y1="${y(last.v)}" x2="${x(t1)}" y2="${y(future)}" stroke="#1f5fd6" stroke-width="2.5" stroke-dasharray="6 5"/>`;
      svg += `<circle cx="${x(now)}" cy="${y(last.v)}" r="5" fill="#1f5fd6"/>`;
    } else {
      svg += `<text x="${W / 2}" y="${H / 2}" font-size="13" fill="#6b6f78" text-anchor="middle">No readings yet today</text>`;
    }
    return svg + "</svg>";
  }

  // ---------- Icons ----------
  const ICON = {
    garage: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M10 16V8h3a2.5 2.5 0 0 1 0 5h-3"/></svg>`,
    clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
    user: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>`,
    lock: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`,
    trend: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="flex:none;margin-top:2px"><path d="M3 17l6-6 4 4 7-7"/><path d="M14 8h6v6"/></svg>`,
    wifi: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="19.5" r="1" fill="currentColor"/></svg>`,
    back: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M15 18l-6-6 6-6"/></svg>`,
    arrow: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>`,
  };
  function tabs(active) {
    const t = (hash, key, label, icon) => `<a href="${hash}" class="${active === key ? "on" : ""}">${icon}${label}</a>`;
    return `<nav class="tabs">${t("#/garage", "garage", "Garages", ICON.garage)}${t("#/myhold", "hold", "My hold", ICON.clock)}${t("#/account", "account", "Account", ICON.user)}</nav>`;
  }
  function livePill() {
    if (!connected) return `<span class="pill"><span class="dot off"></span>Offline</span>`;
    return `<span class="pill"><span class="dot"></span>Live · updated <span id="ago">${Math.round((Date.now() - lastStateAt) / 1000)}</span> s ago</span>`;
  }

  // ---------- Screens ----------
  function screenWelcome() {
    const best = bestLevel();
    return `<div class="screen" style="display:flex;flex-direction:column;min-height:100vh;padding-bottom:28px">
      <div class="row" style="justify-content:flex-start;gap:14px;margin-top:20px">
        <div style="width:52px;height:52px;border-radius:14px;background:var(--red);color:#fff;display:grid;place-items:center;font-weight:700;font-size:26px">P</div>
        <div style="font-size:21px;font-weight:600">Stevens Parking</div>
      </div>
      <h1 class="h1" style="margin-top:44px;font-size:38px;line-height:1.15">Know where the open spaces are before you pull in.</h1>
      <p class="muted" style="font-size:17px;line-height:1.5">Live counts from a camera at the entrance of the Babbio Center Garage.</p>
      <div class="card" style="margin-top:22px">
        <div class="row"><b style="font-weight:600">${esc(S.garageName)}</b><span class="muted small">${best ? "Level " + best.n + " best" : "Live"}</span></div>
        <div style="margin-top:14px"><span class="big">${S.open}</span><span class="of">open of ${S.capacity}</span></div>
        <div class="bar"><i style="width:${pct(S.capacity - S.open, S.capacity)}%"></i></div>
      </div>
      <div style="flex:1"></div>
      <label class="field">Your name (prototype login)
        <input type="text" id="nameInput" placeholder="e.g. Amaro" autocomplete="given-name" />
      </label>
      <button class="btn" id="loginBtn" style="margin-top:14px">${ICON.lock} Continue with Stevens login</button>
      <p class="foot">Prototype: no real Stevens SSO/Duo yet. Your name is saved on this phone only.</p>
    </div>`;
  }

  function screenGarage() {
    const tr = trendLine();
    const best = bestLevel();
    const cams = entranceCams();
    const online = cams.filter((c) => c.online).length;
    const hold = myHold();
    const rampCount = ["r12", "r23", "r34"].filter((r) => S.rampsSeen[r]).length;
    const levelRows = S.levels.map((l) => {
      if (!S.levelsTracked) {
        return `<div class="item"><b>Level ${l.n}</b><div><div class="bar thin"><i style="width:0"></i></div><div class="status muted">Not counted yet</div></div><span class="num muted">—</span><span></span></div>`;
      }
      const st = levelStatus(l.open, l.capacity);
      return `<a class="item" href="#/level/${l.n}"><b>Level ${l.n}</b><div><div class="bar thin ${st.cls}"><i style="width:${pct(l.capacity - l.open, l.capacity)}%"></i></div><div class="status ${st.cls}">${st.text}</div></div><span class="num">${l.open}</span><span class="chev">›</span></a>`;
    }).join("");

    return `<div class="screen">
      <div class="row"><h1 class="h1">Parking</h1>${livePill()}</div>
      <div class="card">
        <div class="row"><b style="font-size:18px;font-weight:600">${esc(S.garageName)}</b><span class="muted">Sinatra Dr</span></div>
        <div style="margin-top:14px"><span class="big">${S.open}</span><span class="of">open of ${S.capacity}</span></div>
        <div class="bar"><i style="width:${pct(S.capacity - S.open, S.capacity)}%"></i></div>
        <div class="trend ${tr.cls}">${ICON.trend}<span>${tr.text}</span></div>
        <span class="chip ${online ? "green" : "red"}">${online ? `Entrance camera online` : cams.length ? "Entrance camera offline" : "No entrance camera yet"}</span>
        ${hold ? `<a class="chip" href="#/myhold">Your hold · until ${timeStr(hold.expiresAt)}</a>` : ""}
      </div>

      <div class="row" style="margin-top:24px"><b style="font-weight:600;font-size:17px">By level</b><span class="muted small">${best ? "Best bet: Level " + best.n : `Needs ramp cameras (${rampCount} of 3)`}</span></div>
      <div class="list">${levelRows}</div>
      ${S.levelsTracked ? "" : `<p class="small muted" style="margin:10px 4px 0">The entrance camera counts the whole garage. Per-level counts turn on once a camera is set up on each of the 3 ramps.</p>`}

      <div class="card">
        <div class="row"><b style="font-weight:600">Open spaces today</b><span class="muted small">Dashed = trend</span></div>
        ${chart(S.history.map((h) => ({ t: h.t, v: h.open })), S.capacity, S.fillRatePerMin)}
      </div>
    </div>
    <div class="sticky">${hold
      ? `<a class="btn secondary" href="#/myhold">You're holding a space · until ${timeStr(hold.expiresAt)}</a>`
      : `<a class="btn" href="#/hold">${ICON.clock} Hold a space for 15 min</a>`}</div>
    ${tabs("garage")}`;
  }

  function screenLevel(n) {
    const l = S.levels[n - 1];
    if (!l) return screenGarage();
    const st = levelStatus(l.open, l.capacity);
    const ramps = S.cameras.filter((c) => c.location !== "entrance");
    const online = ramps.filter((c) => c.online).length;
    const lastSeen = ramps.length ? Math.round((S.serverTime - Math.max(...ramps.map((c) => c.lastSeen))) / 1000) : null;
    return `<div class="screen">
      <a class="back" href="#/garage">${ICON.back} ${esc(S.garageName)}</a>
      <h1 class="h1">Level ${l.n}</h1>
      <div style="margin-top:8px"><span class="big">${l.open}</span><span class="of">open of ${l.capacity} · ${st.text.toLowerCase()}</span></div>
      <div class="card">
        <b style="font-weight:600">Where on this level</b>
        <p class="small muted" style="margin:8px 0 0">Zones (near elevators, middle, ramp end) need cameras inside the level — planned for phase 2.</p>
      </div>
      <div class="card">
        <div class="row"><b style="font-weight:600">Open spaces today</b><span class="muted small">Dashed = trend</span></div>
        ${chart(S.history.map((h) => ({ t: h.t, v: h.levelOpen ? h.levelOpen[n - 1] : null })), l.capacity, 0)}
      </div>
      <p class="small muted row" style="justify-content:flex-start;gap:8px;margin:14px 4px">${ICON.wifi} Counted by cameras at the ramps. ${online} of ${ramps.length} online${lastSeen != null ? ` · last reading ${lastSeen} s ago` : ""}.</p>
    </div>
    <div class="sticky" style="bottom:20px"><a class="btn" href="#/hold?level=${l.n}">Hold a space on Level ${l.n}</a></div>`;
  }

  // Hold screen keeps its choices here so live updates don't reset them
  let holdLevel = 0, holdMinutes = 15, holdError = "";
  function screenHold() {
    const u = user();
    const existing = myHold();
    const lvlBtn = (n, label) => {
      const lv = S.levels[n - 1];
      const disabled = n && S.levelsTracked && lv.open <= 0;
      return `<button class="choice ${holdLevel === n ? "on" : ""}" data-level="${n}" ${disabled ? "disabled" : ""}>${label}</button>`;
    };
    const until = timeStr(Date.now() + holdMinutes * 60000);
    const where = holdLevel ? `on <b>Level ${holdLevel}</b>` : "in the garage";
    const paused = (S.noShows[u.id] || 0) >= S.maxNoShows;
    return `<div class="screen">
      <a class="back" href="#/garage">${ICON.back} Back</a>
      <h1 class="h1">Hold a space</h1>
      <div class="muted" style="font-size:17px;margin-top:4px">${esc(S.garageName)}</div>
      ${S.levelsTracked ? `<div class="card"><b style="font-weight:600">Which level</b>
        <div class="choice-grid">${lvlBtn(0, "Any level")}${S.levels.map((l) => lvlBtn(l.n, "Level " + l.n)).join("")}</div></div>` : ""}
      <div class="card"><b style="font-weight:600">I'll arrive in about</b>
        <div class="choice-grid three">${[10, 15, 20].map((m) => `<button class="choice ${holdMinutes === m ? "on" : ""}" data-min="${m}">${m} min</button>`).join("")}</div>
      </div>
      <div class="info">We'll hold one space ${where} until <b>${until}</b>. It shows as taken for everyone else. If no car arrives by then, it's released.</div>
      <label class="check">Alert me if the garage drops below ${S.lowAlert} open <input type="checkbox" id="lowAlert" ${prefs().lowAlert ? "checked" : ""}/></label>
      ${holdError ? `<div class="err">${esc(holdError)}</div>` : ""}
      ${paused ? `<div class="err">Holds are paused for your account after ${S.maxNoShows} no-shows.</div>` : ""}
      <button class="btn" id="holdBtn" ${existing || paused || S.open <= 0 ? "disabled" : ""} style="margin-top:14px">${existing ? "You already have a hold" : "Hold my space"}</button>
      <p class="foot">One hold at a time. Repeated no-shows pause holds.</p>
    </div>`;
  }

  function screenMyHold() {
    const h = myHold();
    const body = h
      ? `<div class="card">
          <div class="muted small">${esc(S.garageName)}${h.level ? " · Level " + h.level : " · any level"}</div>
          <div style="margin-top:10px"><span class="big" id="countdown">--:--</span><span class="of">left</span></div>
          <div class="bar"><i id="holdBar" style="width:0%"></i></div>
          <p class="muted" style="margin:14px 0 0">Held until <b>${timeStr(h.expiresAt)}</b>. When the entrance camera sees a car arrive, your hold is used.</p>
        </div>
        <button class="btn secondary" id="cancelHold" style="margin-top:16px">Cancel my hold</button>`
      : `<div class="card"><b style="font-weight:600">No active hold</b><p class="muted" style="margin:8px 0 0">Hold a space before you drive in, and it shows as taken for everyone else for up to 20 minutes.</p></div>
         <a class="btn" href="#/hold" style="margin-top:16px">${ICON.clock} Hold a space</a>`;
    return `<div class="screen"><div class="row"><h1 class="h1">My hold</h1>${livePill()}</div>${body}</div>${tabs("hold")}`;
  }

  function screenAccount() {
    const u = user();
    const noShows = S.noShows[u.id] || 0;
    return `<div class="screen">
      <h1 class="h1">Account</h1>
      <div class="card">
        <div class="muted small">Signed in as</div>
        <div style="font-size:22px;font-weight:600;margin-top:4px">${esc(u.name)}</div>
        <div class="muted small" style="margin-top:6px">No-shows: ${noShows} of ${S.maxNoShows}</div>
        <label class="check" style="margin:16px 0 0">Alert me below ${S.lowAlert} open spaces <input type="checkbox" id="lowAlert" ${prefs().lowAlert ? "checked" : ""}/></label>
        <button class="btn secondary small" id="notifBtn" style="margin-top:12px">Allow phone notifications</button>
      </div>
      <div class="card">
        <b style="font-weight:600">Prototype tools</b>
        <a class="btn secondary" href="/camera" style="margin-top:12px">Open camera counter</a>
        <a class="btn secondary" href="#/board" style="margin-top:10px">Garage display board</a>
        <a class="btn secondary" href="#/admin" style="margin-top:10px">Admin & calibration</a>
      </div>
      <button class="btn secondary" id="logout" style="margin-top:16px">Sign out</button>
    </div>${tabs("account")}`;
  }

  function screenBoard() {
    const cards = S.levels.map((l) => {
      if (!S.levelsTracked) return `<div class="lv gray"><div class="n">Level ${l.n}${ICON.arrow}</div><div class="count">—</div><div class="st">NOT COUNTED</div></div>`;
      const st = levelStatus(l.open, l.capacity);
      return `<div class="lv ${st.cls}"><div class="n">Level ${l.n}${ICON.arrow}</div><div class="count">${l.open}</div><div class="st">${st.board}</div></div>`;
    }).join("");
    return `<div class="board">
      <div class="top">
        <div><div class="label">BABBIO CENTER GARAGE</div><div class="total">${S.open}<span>open</span></div></div>
        <div style="text-align:right;color:#a7abb4">of ${S.capacity} spaces<br/>Live from the entrance camera</div>
      </div>
      <div class="grid">${cards}</div>
      <div class="hint">Hold a space for 15 minutes in the Stevens Parking app · <a href="#/garage" style="color:#a7abb4">exit board</a></div>
    </div>`;
  }

  function screenAdmin() {
    const cams = S.cameras.length
      ? S.cameras.map((c) => `<div class="row" style="padding:8px 0;border-top:1px solid var(--line)"><span><span class="dot ${c.online ? "" : "off"}" style="display:inline-block"></span> ${esc(c.name)}<br/><span class="small muted">${esc(c.locationLabel)}</span></span><span class="small">in ${c.inCount} · out ${c.outCount}</span></div>`).join("")
      : `<p class="muted small">No cameras yet. Open <a href="/camera">/camera</a> on the camera phone.</p>`;
    return `<div class="screen">
      <a class="back" href="#/account">${ICON.back} Back</a>
      <h1 class="h1">Admin</h1>
      <p class="muted small">For the team: calibration and demo tools.</p>

      <div class="card">
        <b style="font-weight:600">1. Calibrate the starting count</b>
        <p class="small muted">Before recording, count the cars already parked (or start when the garage is nearly empty) and enter it here.</p>
        <div class="row"><input type="number" id="occInput" min="0" max="${S.capacity}" value="${S.occupied}"/><button class="btn small" id="setOcc">Set</button></div>
        <p class="small muted">Now: ${S.occupied} cars inside · ${S.open} open · ${S.holds.length} held</p>
        ${S.levelsTracked ? S.levels.map((l) => `<div class="row" style="margin-top:8px"><span style="min-width:70px">Level ${l.n}</span><input type="number" data-lvl="${l.n}" value="${l.occupied}" min="0" max="${l.capacity}"/><button class="btn small secondary" data-setlvl="${l.n}">Set</button></div>`).join("") : ""}
      </div>

      <div class="card">
        <b style="font-weight:600">2. Simulate a car (no camera needed)</b>
        <div class="choice-grid">
          <button class="choice" data-sim="entrance:in">Car enters</button>
          <button class="choice" data-sim="entrance:out">Car leaves</button>
        </div>
        <div class="choice-grid three" style="margin-top:10px">
          ${["r12", "r23", "r34"].map((r) => `<button class="choice small" data-sim="${r}:in" style="font-size:14px">Up ${r[1]}→${r[2]}</button>`).join("")}
          ${["r12", "r23", "r34"].map((r) => `<button class="choice small" data-sim="${r}:out" style="font-size:14px">Down ${r[2]}→${r[1]}</button>`).join("")}
        </div>
        <p class="small muted">Ramp buttons turn on per-level counts once all 3 ramps have been used.</p>
      </div>

      <div class="card"><b style="font-weight:600">Cameras</b>${cams}</div>

      <div class="card"><b style="font-weight:600">Recent events</b>
        <div class="log">${S.events.map((e) => `<div>${timeStr(e.t)} — ${esc(e.text)}</div>`).join("") || '<div class="muted">Nothing yet</div>'}</div>
      </div>

      <div class="card">
        <b style="font-weight:600">Reset</b>
        <div class="choice-grid">
          <button class="choice" id="clearHolds" style="font-size:15px">Clear holds</button>
          <button class="choice" id="resetRamps" style="font-size:15px">Forget ramps</button>
        </div>
        <button class="btn secondary" id="resetAll" style="margin-top:10px;color:var(--red)">Reset everything</button>
      </div>
    </div>`;
  }

  // ---------- Router ----------
  function route() {
    const [path, query] = location.hash.replace(/^#/, "").split("?");
    const parts = path.split("/").filter(Boolean);
    return { name: parts[0] || "", arg: parts[1], query: new URLSearchParams(query || "") };
  }

  let lastRoute = "";
  function render() {
    if (!S) { app.innerHTML = `<div class="screen"><p class="muted">Connecting to the garage…</p></div>`; return; }
    const r = route();
    const routeKey = location.hash;
    if (!user() && r.name !== "board") {
      // Don't wipe what the person is typing: on live updates only refresh the card
      const input = document.getElementById("nameInput");
      const typed = input ? input.value : "";
      if (input && document.activeElement === input) return; // typing: redraw later
      app.innerHTML = screenWelcome();
      bindWelcome();
      document.getElementById("nameInput").value = typed;
      lastRoute = "";
      return;
    }
    document.body.classList.toggle("board-mode", r.name === "board");

    // Keep focus/typed values on the admin screen: don't redraw while typing
    if (r.name === "admin" && routeKey === lastRoute && document.activeElement && document.activeElement.tagName === "INPUT") return;

    if (routeKey !== lastRoute && r.name === "hold") {
      holdLevel = Number(r.query.get("level")) || 0;
      holdError = "";
    }
    const scrollY = routeKey === lastRoute ? window.scrollY : 0;
    lastRoute = routeKey;

    switch (r.name) {
      case "level": app.innerHTML = screenLevel(Number(r.arg)); break;
      case "hold": app.innerHTML = screenHold(); bindHold(); break;
      case "myhold": app.innerHTML = screenMyHold(); bindMyHold(); break;
      case "account": app.innerHTML = screenAccount(); bindAccount(); break;
      case "board": app.innerHTML = screenBoard(); break;
      case "admin": app.innerHTML = screenAdmin(); bindAdmin(); break;
      default: app.innerHTML = screenGarage();
    }
    window.scrollTo(0, scrollY);
    tick();
  }

  // ---------- Button handlers ----------
  function bindWelcome() {
    const go = () => {
      const name = document.getElementById("nameInput").value.trim() || "Student";
      localStorage.setItem("user", JSON.stringify({ id: "u-" + Math.random().toString(36).slice(2, 10), name }));
      if (!location.hash || location.hash === "#/") location.hash = "#/garage";
      render();
    };
    document.getElementById("loginBtn").onclick = go;
    document.getElementById("nameInput").onkeydown = (e) => e.key === "Enter" && go();
  }
  function bindHold() {
    app.querySelectorAll("[data-level]").forEach((b) => (b.onclick = () => { holdLevel = Number(b.dataset.level); holdError = ""; render(); }));
    app.querySelectorAll("[data-min]").forEach((b) => (b.onclick = () => { holdMinutes = Number(b.dataset.min); render(); }));
    document.getElementById("lowAlert").onchange = (e) => setPrefs({ lowAlert: e.target.checked });
    document.getElementById("holdBtn").onclick = () => {
      const u = user();
      holdError = "";
      send({ type: "hold", userId: u.id, userName: u.name, level: holdLevel, minutes: holdMinutes });
    };
  }
  function bindMyHold() {
    const c = document.getElementById("cancelHold");
    if (c) c.onclick = () => { send({ type: "cancel_hold", userId: user().id }); toast("Hold cancelled"); };
  }
  function bindAccount() {
    document.getElementById("lowAlert").onchange = (e) => setPrefs({ lowAlert: e.target.checked });
    document.getElementById("notifBtn").onclick = async () => {
      if (!("Notification" in window)) return toast("This browser doesn't support notifications — you'll still get in-app alerts.");
      const p = await Notification.requestPermission();
      toast(p === "granted" ? "Notifications on" : "Notifications not allowed — in-app alerts still work");
    };
    document.getElementById("logout").onclick = () => { localStorage.removeItem("user"); location.hash = "#/"; render(); };
  }
  function bindAdmin() {
    document.getElementById("setOcc").onclick = () => { send({ type: "admin", action: "setOccupied", value: document.getElementById("occInput").value }); document.activeElement.blur(); toast("Count updated"); };
    app.querySelectorAll("[data-setlvl]").forEach((b) => (b.onclick = () => {
      const n = b.dataset.setlvl;
      send({ type: "admin", action: "setLevel", level: n, value: app.querySelector(`[data-lvl="${n}"]`).value });
    }));
    app.querySelectorAll("[data-sim]").forEach((b) => (b.onclick = () => {
      const [location_, dir] = b.dataset.sim.split(":");
      send({ type: "admin", action: "simulate", location: location_, dir });
    }));
    document.getElementById("clearHolds").onclick = () => send({ type: "admin", action: "clearHolds" });
    document.getElementById("resetRamps").onclick = () => send({ type: "admin", action: "resetRamps" });
    document.getElementById("resetAll").onclick = () => confirm("Reset all counts, holds and history?") && send({ type: "admin", action: "reset" });
  }

  // Every second: update "updated X s ago" and the hold countdown without a full redraw
  function tick() {
    const ago = document.getElementById("ago");
    if (ago) ago.textContent = Math.round((Date.now() - lastStateAt) / 1000);
    const h = S && myHold();
    const cd = document.getElementById("countdown");
    if (h && cd) {
      const left = Math.max(0, h.expiresAt - Date.now());
      cd.textContent = `${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, "0")}`;
      document.getElementById("holdBar").style.width = pct(h.expiresAt - Date.now(), h.expiresAt - h.createdAt) + "%";
    }
  }
  setInterval(tick, 1000);

  window.addEventListener("hashchange", render);
  render();
  connect();
})();

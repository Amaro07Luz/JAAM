// Camera counter page: watches the lane, counts cars, sends each count to the server.
(() => {
  const $ = (id) => document.getElementById(id);
  const video = $("video"), overlay = $("overlay"), work = $("work");
  const octx = overlay.getContext("2d");
  const wctx = work.getContext("2d", { willReadFrequently: true });

  // ---------- Settings (saved on this phone) ----------
  const DEFAULTS = {
    camName: "Entrance phone", camLocation: "entrance", orientation: "horizontal", inDir: "AtoB",
    posA: 0.35, posB: 0.65, band: 0.1, spanStart: 0.2, spanEnd: 0.8,
    activeFraction: 0.2, pixelThreshold: 28, aiCheck: false, showMask: false,
  };
  const settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem("camSettings") || "{}") };
  const cameraId = localStorage.getItem("cameraId") || "cam-" + Math.random().toString(36).slice(2, 8);
  localStorage.setItem("cameraId", cameraId);
  const saveSettings = () => localStorage.setItem("camSettings", JSON.stringify(settings));

  const WORK_W = 160; // we analyse a small 160px-wide copy of each frame: fast, and enough to see a car
  let detector = null;

  function makeDetector(w, h) {
    detector = new TwoZoneDetector({ width: w, height: h, ...settings });
  }
  function applySettings() {
    if (detector) detector.set({ ...settings });
    $("trigA").style.left = $("trigB").style.left = settings.activeFraction * 100 + "%";
    saveSettings();
  }

  // ---------- Log ----------
  function log(text) {
    const d = document.createElement("div");
    d.textContent = new Date().toLocaleTimeString() + " — " + text;
    $("log").prepend(d);
    while ($("log").children.length > 60) $("log").lastChild.remove();
  }

  // ---------- Connection to the server ----------
  let ws = null, connected = false;
  const pending = new Map(); // counts not yet confirmed by the server (resent after reconnect)
  function connect() {
    ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host);
    ws.onopen = () => {
      connected = true;
      setConn(true);
      hello();
      for (const msg of pending.values()) ws.send(JSON.stringify(msg));
    };
    ws.onclose = () => {
      connected = false;
      setConn(false);
      setTimeout(connect, 1500);
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "count_ack") pending.delete(msg.id);
      if (msg.type === "state" && !locationsLoaded) fillLocations(msg.state.locations);
    };
  }
  function setConn(ok) {
    $("connDot").classList.toggle("off", !ok);
    $("connText").textContent = ok ? "Connected" : "Offline — retrying";
  }
  function send(msg) {
    if (connected) ws.send(JSON.stringify(msg));
  }
  function hello() {
    send({ type: "camera_hello", cameraId, name: settings.camName, location: settings.camLocation });
  }
  setInterval(() => send({ type: "heartbeat", cameraId, name: settings.camName, location: settings.camLocation }), 5000);

  let locationsLoaded = false;
  function fillLocations(locs) {
    locationsLoaded = true;
    $("camLocation").innerHTML = Object.entries(locs).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
    $("camLocation").value = settings.camLocation;
  }

  // ---------- Counting ----------
  let inCount = 0, outCount = 0;
  function count(dir, how) {
    if (dir === "in") inCount++; else outCount++;
    $("inCount").textContent = inCount;
    $("outCount").textContent = outCount;
    const msg = { type: "count", id: cameraId + "-" + Date.now(), cameraId, name: settings.camName, location: settings.camLocation, dir };
    pending.set(msg.id, msg);
    send(msg);
    log(`Car ${dir.toUpperCase()} (${how})${connected ? "" : " — saved, will send when back online"}`);
    if (navigator.vibrate) navigator.vibrate(80);
    flash = { dir, until: performance.now() + 700 };
  }
  let flash = null;

  // ---------- Optional AI check (COCO-SSD running in the browser) ----------
  let aiModel = null, aiLoading = false, aiBusy = false, lastVehicleAt = -1e9, lastBoxes = [];
  const VEHICLES = new Set(["car", "truck", "bus", "motorcycle"]);
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }
  async function loadAI() {
    if (aiModel || aiLoading) return;
    aiLoading = true;
    $("aiStatus").textContent = "loading model…";
    try {
      await loadScript("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js");
      await loadScript("https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js");
      aiModel = await cocoSsd.load({ base: "lite_mobilenet_v2" });
      $("aiStatus").textContent = "ready";
      log("AI vehicle check ready");
    } catch (e) {
      $("aiStatus").textContent = "failed to load (counting without it)";
      log("AI model failed to load: " + e);
    }
    aiLoading = false;
  }
  // Is there a vehicle overlapping our zones right now?
  async function vehicleNow() {
    if (!aiModel || aiBusy || !video.videoWidth) return false;
    aiBusy = true;
    try {
      const preds = await aiModel.detect(video, 6, 0.35);
      const zA = detector.zoneA, zB = detector.zoneB;
      const ux0 = Math.min(zA.x, zB.x), uy0 = Math.min(zA.y, zB.y);
      const ux1 = Math.max(zA.x + zA.w, zB.x + zB.w), uy1 = Math.max(zA.y + zA.h, zB.y + zB.h);
      lastBoxes = preds.filter((p) => VEHICLES.has(p.class));
      const hit = lastBoxes.some((p) => {
        const [x, y, w, h] = p.bbox;
        const bx0 = x / video.videoWidth, by0 = y / video.videoHeight;
        const bx1 = (x + w) / video.videoWidth, by1 = (y + h) / video.videoHeight;
        return bx0 < ux1 && bx1 > ux0 && by0 < uy1 && by1 > uy0;
      });
      if (hit) lastVehicleAt = performance.now();
      return hit;
    } finally {
      aiBusy = false;
    }
  }

  async function onCrossing(ev) {
    const dir = ev.dir === settings.inDir ? "in" : "out";
    if (settings.aiCheck && aiModel) {
      const recently = performance.now() - lastVehicleAt < detector.maxGapMs + 2000;
      if (!recently && !(await vehicleNow())) {
        log(`Movement ${ev.dir} ignored — AI saw no vehicle`);
        return;
      }
    }
    count(dir, "camera");
  }

  // ---------- Video sources ----------
  async function startCamera() {
    if (!window.isSecureContext) {
      alert("The browser only allows the camera on https:// pages (or localhost). Open this page through the https link from the README (cloudflared).");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      video.srcObject = stream;
      video.removeAttribute("src");
      sourceIsFile = false;
      await video.play();
      started("Camera started — keep the lane empty for 2 s");
    } catch (e) {
      alert("Could not open the camera: " + e.message);
    }
  }
  let sourceIsFile = false;
  function startFile(file) {
    if (video.srcObject) { video.srcObject.getTracks().forEach((t) => t.stop()); video.srcObject = null; }
    video.src = URL.createObjectURL(file);
    sourceIsFile = true;
    video.loop = false;
    video.play();
    started(`Playing "${file.name}"`);
    video.onended = () => log(`Video finished — counted ${inCount} in, ${outCount} out`);
  }
  let wakeLock = null;
  async function started(text) {
    $("camWrap").hidden = false;
    detector = null; // rebuilt at the right size on the next frame
    log(text);
    try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
  }

  // ---------- Main loop (~15 frames per second) ----------
  let lastProcess = 0, prevPhase = "idle";
  function loop(now) {
    requestAnimationFrame(loop);
    if (now - lastProcess < 66 || video.readyState < 2 || !video.videoWidth || video.paused) return;
    lastProcess = now;

    const W = WORK_W, H = Math.round((WORK_W * video.videoHeight) / video.videoWidth);
    if (!detector || detector.width !== W || detector.height !== H) {
      work.width = W; work.height = H;
      makeDetector(W, H);
    }
    wctx.drawImage(video, 0, 0, W, H);
    const px = wctx.getImageData(0, 0, W, H).data;
    const gray = new Uint8ClampedArray(W * H);
    for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = (px[j] * 77 + px[j + 1] * 150 + px[j + 2] * 29) >> 8;

    const t = sourceIsFile ? video.currentTime * 1000 : now;
    const ev = detector.process(gray, t);

    // When something first enters a zone, ask the AI (in the background) whether it's a vehicle
    if (settings.aiCheck && aiModel && prevPhase === "idle" && detector.phase === "armed") vehicleNow();
    prevPhase = detector.phase;
    if (ev) onCrossing(ev);

    drawOverlay(gray, W, H);
    const fa = detector.zone.A.fraction, fb = detector.zone.B.fraction;
    $("meterA").style.width = Math.min(100, fa * 100) + "%";
    $("meterB").style.width = Math.min(100, fb * 100) + "%";
    $("fracA").textContent = Math.round(fa * 100) + "%";
    $("fracB").textContent = Math.round(fb * 100) + "%";
    $("phase").textContent = detector.phase;
  }
  requestAnimationFrame(loop);

  const maskCanvas = document.createElement("canvas");
  function drawOverlay(gray, W, H) {
    overlay.width = video.videoWidth;
    overlay.height = video.videoHeight;
    const sx = overlay.width, sy = overlay.height;
    octx.clearRect(0, 0, sx, sy);

    if (settings.showMask && detector.bg) {
      maskCanvas.width = W; maskCanvas.height = H;
      const mctx = maskCanvas.getContext("2d");
      const img = mctx.createImageData(W, H);
      for (let i = 0; i < W * H; i++) {
        if (Math.abs(gray[i] - detector.bg[i]) > detector.pixelThreshold) {
          img.data[i * 4] = 255; img.data[i * 4 + 3] = 140;
        }
      }
      mctx.putImageData(img, 0, 0);
      octx.imageSmoothingEnabled = false;
      octx.drawImage(maskCanvas, 0, 0, sx, sy);
    }

    const lw = Math.max(3, sx / 250);
    for (const [name, rect] of [["A", detector.zoneA], ["B", detector.zoneB]]) {
      const on = detector.zone[name].on;
      octx.fillStyle = on ? "rgba(166,25,46,0.35)" : "rgba(31,95,214,0.12)";
      octx.strokeStyle = on ? "#ff3b55" : "#7fb0ff";
      octx.lineWidth = lw;
      octx.fillRect(rect.x * sx, rect.y * sy, rect.w * sx, rect.h * sy);
      octx.strokeRect(rect.x * sx, rect.y * sy, rect.w * sx, rect.h * sy);
      octx.fillStyle = "#fff";
      octx.font = `700 ${Math.round(sx / 22)}px Inter, sans-serif`;
      octx.fillText(name, rect.x * sx + lw * 2, rect.y * sy + sx / 20);
    }
    // Arrow showing which way counts as IN
    const a = detector.zoneA, b = detector.zoneB;
    let from = { x: (a.x + a.w / 2) * sx, y: (a.y + a.h / 2) * sy }, to = { x: (b.x + b.w / 2) * sx, y: (b.y + b.h / 2) * sy };
    if (settings.inDir === "BtoA") [from, to] = [to, from];
    octx.strokeStyle = "#fff"; octx.fillStyle = "#fff"; octx.lineWidth = lw;
    octx.beginPath(); octx.moveTo(from.x, from.y); octx.lineTo(to.x, to.y); octx.stroke();
    const ang = Math.atan2(to.y - from.y, to.x - from.x), hs = sx / 30;
    octx.beginPath();
    octx.moveTo(to.x, to.y);
    octx.lineTo(to.x - hs * Math.cos(ang - 0.4), to.y - hs * Math.sin(ang - 0.4));
    octx.lineTo(to.x - hs * Math.cos(ang + 0.4), to.y - hs * Math.sin(ang + 0.4));
    octx.fill();
    octx.font = `600 ${Math.round(sx / 30)}px Inter, sans-serif`;
    octx.fillText("IN", (from.x + to.x) / 2 + 8, (from.y + to.y) / 2 - 10);

    // Vehicle boxes from the AI check
    if (settings.aiCheck) {
      octx.strokeStyle = "#3ddc84"; octx.lineWidth = lw;
      const kx = sx / video.videoWidth, ky = sy / video.videoHeight;
      for (const p of lastBoxes) octx.strokeRect(p.bbox[0] * kx, p.bbox[1] * ky, p.bbox[2] * kx, p.bbox[3] * ky);
    }

    if (flash && performance.now() < flash.until) {
      octx.fillStyle = flash.dir === "in" ? "rgba(31,138,76,0.85)" : "rgba(166,25,46,0.85)";
      octx.fillRect(0, 0, sx, sy / 7);
      octx.fillStyle = "#fff";
      octx.font = `700 ${Math.round(sy / 12)}px Inter, sans-serif`;
      octx.fillText(flash.dir === "in" ? "CAR IN +1" : "CAR OUT −1", sx / 30, sy / 10);
    }
  }

  // ---------- Wire up the controls ----------
  $("camName").value = settings.camName;
  $("camName").oninput = (e) => { settings.camName = e.target.value || "Camera"; saveSettings(); hello(); };
  $("camLocation").onchange = (e) => { settings.camLocation = e.target.value; saveSettings(); hello(); log("Location set to " + e.target.selectedOptions[0].text); };
  for (const key of ["orientation", "inDir"]) {
    $(key).value = settings[key];
    $(key).onchange = (e) => { settings[key] = e.target.value; applySettings(); };
  }
  for (const key of ["posA", "posB", "band", "spanStart", "spanEnd", "activeFraction", "pixelThreshold"]) {
    const el = $(key), label = $(key + "Val");
    const show = () => (label.textContent = key === "pixelThreshold" ? `(${settings[key]})` : `(${Math.round(settings[key] * 100)}%)`);
    el.value = settings[key];
    show();
    el.oninput = () => { settings[key] = Number(el.value); show(); applySettings(); };
  }
  $("aiCheck").checked = settings.aiCheck;
  $("aiCheck").onchange = (e) => { settings.aiCheck = e.target.checked; saveSettings(); if (settings.aiCheck) loadAI(); else $("aiStatus").textContent = "off"; };
  if (settings.aiCheck) loadAI();
  $("showMask").checked = settings.showMask;
  $("showMask").onchange = (e) => { settings.showMask = e.target.checked; saveSettings(); };

  $("startCam").onclick = startCamera;
  $("videoFile").onchange = (e) => e.target.files[0] && startFile(e.target.files[0]);
  $("resetBg").onclick = () => { detector?.resetBackground(); log("Relearning the empty lane — keep it clear for 2 s"); };
  $("manualIn").onclick = () => count("in", "manual");
  $("manualOut").onclick = () => count("out", "manual");
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible" && video.srcObject) { try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {} }
  });

  applySettings();
  connect();
})();

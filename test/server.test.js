// Starts the server on a spare port and talks to it like a camera phone and an app phone would.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const DATA = path.join(__dirname, "..", "data.json");
const backup = fs.existsSync(DATA) ? fs.readFileSync(DATA) : null;
if (backup) fs.unlinkSync(DATA);

const { server } = require("../server.js");
const WebSocket = require("ws");

function client(port) {
  return new Promise((res) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.latest = null;
    ws.waiters = [];
    ws.on("message", (m) => {
      const msg = JSON.parse(m);
      if (msg.type === "state") ws.latest = msg.state;
      ws.waiters = ws.waiters.filter((w) => !(w.test(msg) && (w.res(msg), true)));
    });
    ws.next = (test) => new Promise((r) => ws.waiters.push({ test, res: r }));
    ws.sendJ = (o) => ws.send(JSON.stringify(o));
    ws.on("open", () => res(ws));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const cam = await client(port);
  const phone = await client(port);
  await sleep(100);
  const st = () => phone.latest;
  const steps = [];
  const check = (name, fn) => { fn(); steps.push(name); console.log("  ✓", name); };

  try {
    check("starts empty: 436 open", () => assert.strictEqual(st().open, 436));

    phone.sendJ({ type: "admin", action: "setOccupied", value: 300 });
    await sleep(100);
    check("calibrate to 300 cars → 136 open", () => assert.strictEqual(st().open, 136));

    cam.sendJ({ type: "camera_hello", cameraId: "c1", name: "Entrance phone", location: "entrance" });
    for (let i = 0; i < 5; i++) cam.sendJ({ type: "count", id: "a" + i, cameraId: "c1", location: "entrance", dir: "in" });
    cam.sendJ({ type: "count", id: "b", cameraId: "c1", location: "entrance", dir: "out" });
    await sleep(150);
    check("camera: 5 in, 1 out → 132 open, pushed live to the other phone", () => assert.strictEqual(st().open, 132));
    check("camera shows online with its counts", () => {
      const c = st().cameras.find((c) => c.id === "c1");
      assert.ok(c.online); assert.strictEqual(c.inCount, 5); assert.strictEqual(c.outCount, 1);
    });
    check("history recorded for the chart", () => assert.ok(st().history.length >= 7));
    check("filling trend detected", () => assert.ok(st().fillRatePerMin > 0));

    phone.sendJ({ type: "hold", userId: "u1", userName: "Amaro", level: 0, minutes: 15 });
    const r1 = await phone.next((m) => m.type === "hold_result");
    await sleep(50);
    check("hold accepted and space shown as taken (131 open)", () => { assert.ok(r1.ok); assert.strictEqual(st().open, 131); });

    phone.sendJ({ type: "hold", userId: "u1", userName: "Amaro", level: 0, minutes: 15 });
    const r2 = await phone.next((m) => m.type === "hold_result");
    check("second hold for same person refused", () => assert.ok(!r2.ok));

    cam.sendJ({ type: "count", id: "c", cameraId: "c1", location: "entrance", dir: "in" });
    await sleep(100);
    check("next car entering uses the hold (still 131 open, 0 holds)", () => { assert.strictEqual(st().holds.length, 0); assert.strictEqual(st().open, 131); });

    check("levels not tracked without ramp cameras", () => assert.strictEqual(st().levelsTracked, false));
    for (const r of ["r12", "r23", "r34"]) phone.sendJ({ type: "admin", action: "simulate", location: r, dir: "in" });
    await sleep(100);
    check("after all 3 ramps report, levels are tracked", () => assert.strictEqual(st().levelsTracked, true));
    check("level totals add up to garage total", () =>
      assert.strictEqual(st().levels.reduce((a, l) => a + l.occupied, 0), st().occupied));

    phone.sendJ({ type: "admin", action: "setOccupied", value: 430 });
    await sleep(100);
    check("count never goes above capacity", () => {
      for (let i = 0; i < 20; i++) cam.sendJ({ type: "count", id: "x" + i, cameraId: "c1", location: "entrance", dir: "in" });
    });
    await sleep(150);
    check("…open stays at 0, not negative", () => assert.strictEqual(st().open, 0));

    const res = await fetch(`http://127.0.0.1:${port}/`);
    check("serves the app page", () => assert.strictEqual(res.status, 200));
    const res2 = await fetch(`http://127.0.0.1:${port}/camera`);
    check("serves the camera page", () => assert.strictEqual(res2.status, 200));
    const code = await new Promise((r) => require("http").get({ host: "127.0.0.1", port, path: "/../server.js" }, (x) => r(x.statusCode)));
    check("does not serve files outside /public", () => assert.ok(code === 403 || code === 404));
    console.log("\nAll server tests passed");
  } catch (e) {
    console.log("  ✗", e.message);
    process.exitCode = 1;
  } finally {
    cam.close(); phone.close(); server.close();
    await sleep(700);
    if (fs.existsSync(DATA)) fs.unlinkSync(DATA);
    if (backup) fs.writeFileSync(DATA, backup);
    process.exit(process.exitCode || 0);
  }
})();

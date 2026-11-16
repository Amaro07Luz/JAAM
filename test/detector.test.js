// Feeds synthetic frames (a grey lane + a dark "car" rectangle) to the detector.
const assert = require("assert");
const { TwoZoneDetector } = require("../public/detector.js");

const W = 160, H = 90, FPS = 15;
let seed = 1;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

function frame({ carX = null, carW = 50, carH = 40, carY = 25, light = 0 } = {}) {
  const g = new Uint8ClampedArray(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let v = 120 + light + (rand() - 0.5) * 10; // lane + camera noise
      if (carX !== null && x >= carX && x < carX + carW && y >= carY && y < carY + carH) v = 40 + (x % 7) * 6;
      g[y * W + x] = v;
    }
  return g;
}

function run(frames, opts = {}) {
  const d = new TwoZoneDetector({ width: W, height: H, ...opts });
  const events = [];
  frames.forEach((f, i) => {
    const e = d.process(f, (i * 1000) / FPS);
    if (e) events.push(e.dir);
  });
  return events;
}

const empty = (n) => Array.from({ length: n }, () => frame());
const drive = (from, to, seconds) => {
  const n = Math.round(seconds * FPS);
  return Array.from({ length: n }, (_, i) => frame({ carX: Math.round(from + ((to - from) * i) / (n - 1)) }));
};

const tests = {
  "car driving left→right counts once as AtoB": () =>
    assert.deepStrictEqual(run([...empty(20), ...drive(-60, 170, 2.5), ...empty(20)]), ["AtoB"]),
  "car driving right→left counts once as BtoA": () =>
    assert.deepStrictEqual(run([...empty(20), ...drive(170, -60, 2.5), ...empty(20)]), ["BtoA"]),
  "slow car (6 s) still counts once": () =>
    assert.deepStrictEqual(run([...empty(20), ...drive(-60, 170, 6), ...empty(20)]), ["AtoB"]),
  "three cars in a row count three times": () =>
    assert.deepStrictEqual(
      run([...empty(20), ...drive(-60, 170, 2), ...empty(15), ...drive(-60, 170, 2), ...empty(15), ...drive(170, -60, 2), ...empty(20)]),
      ["AtoB", "AtoB", "BtoA"]
    ),
  "car that enters zone A then reverses out is not counted": () =>
    assert.deepStrictEqual(run([...empty(20), ...drive(-60, 50, 1.5), ...drive(50, -60, 1.5), ...empty(60)]), []),
  "slow lighting change is not counted": () => {
    const f = [...empty(20)];
    for (let i = 0; i < 150; i++) f.push(frame({ light: i * 0.3 }));
    assert.deepStrictEqual(run(f), []);
  },
  "vertical mode (car moving down the screen) works": () => {
    const n = 35, f = [...empty(20)];
    for (let i = 0; i < n; i++) f.push(frame({ carX: 55, carW: 50, carH: 30, carY: Math.round(-35 + (130 * i) / (n - 1)) }));
    f.push(...empty(20));
    assert.deepStrictEqual(run(f, { orientation: "vertical" }), ["AtoB"]);
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try { fn(); console.log("  ✓", name); } catch (e) { failed++; console.log("  ✗", name, "\n    ", e.message.split("\n")[0]); }
}
console.log(failed ? `\n${failed} detector test(s) failed` : "\nAll detector tests passed");
process.exitCode = failed ? 1 : 0;

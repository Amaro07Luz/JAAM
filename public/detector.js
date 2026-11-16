// Two-zone car detector — the camera version of the "two sensors 1 m apart" idea.
//
// We draw two zones (A and B) across the lane. Each frame we compare the picture
// with a learned "empty lane" background. If enough pixels inside a zone changed,
// that zone is "blocked" (like a sensor seeing a car).
//   A blocked, then B blocked  -> a car moved A→B
//   B blocked, then A blocked  -> a car moved B→A
// After a crossing we wait until both zones are clear again before counting the next car.
//
// Works in the browser (window.TwoZoneDetector) and in Node (module.exports) for tests.

(function (root) {
  class TwoZoneDetector {
    constructor(opts = {}) {
      this.width = opts.width || 160;
      this.height = opts.height || 120;
      this.set(opts);
      this.bg = null;
      this.reset();
    }

    // Change settings without losing the background
    set(opts = {}) {
      this.orientation = opts.orientation || this.orientation || "horizontal"; // cars move left↔right
      this.posA = opts.posA ?? this.posA ?? 0.35; // centre of zone A (0..1 along the travel direction)
      this.posB = opts.posB ?? this.posB ?? 0.65;
      this.band = opts.band ?? this.band ?? 0.1; // zone thickness (0..1)
      this.spanStart = opts.spanStart ?? this.spanStart ?? 0.2; // zone extent across the lane (0..1)
      this.spanEnd = opts.spanEnd ?? this.spanEnd ?? 0.8;
      this.pixelThreshold = opts.pixelThreshold ?? this.pixelThreshold ?? 28; // grey-level change that counts as "different"
      this.activeFraction = opts.activeFraction ?? this.activeFraction ?? 0.2; // share of zone pixels that must change
      this.maxGapMs = opts.maxGapMs ?? this.maxGapMs ?? 3000; // max time between A and B
      this.clearMs = opts.clearMs ?? this.clearMs ?? 400; // zone must be quiet this long to count as clear
      this.maxBlockedMs = opts.maxBlockedMs ?? this.maxBlockedMs ?? 20000; // stuck longer than this -> relearn background
      this.zoneA = this._zoneRect(this.posA);
      this.zoneB = this._zoneRect(this.posB);
    }

    // Zone rectangle in normalised 0..1 coordinates {x, y, w, h}
    _zoneRect(pos) {
      const half = this.band / 2;
      const along0 = Math.max(0, pos - half);
      const along1 = Math.min(1, pos + half);
      const s0 = Math.min(this.spanStart, this.spanEnd);
      const s1 = Math.max(this.spanStart, this.spanEnd);
      return this.orientation === "horizontal"
        ? { x: along0, y: s0, w: along1 - along0, h: s1 - s0 }
        : { x: s0, y: along0, w: s1 - s0, h: along1 - along0 };
    }

    reset() {
      this.phase = "idle"; // idle | armed | cooldown
      this.first = null;
      this.firstAt = 0;
      this.zone = {
        A: { on: false, lastActive: -1e9, onSince: 0, fraction: 0 },
        B: { on: false, lastActive: -1e9, onSince: 0, fraction: 0 },
      };
    }

    resetBackground() {
      this.bg = null;
      this.reset();
    }

    _fraction(gray, rect) {
      const W = this.width, H = this.height;
      const x0 = Math.floor(rect.x * W), x1 = Math.ceil((rect.x + rect.w) * W);
      const y0 = Math.floor(rect.y * H), y1 = Math.ceil((rect.y + rect.h) * H);
      let changed = 0, total = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * W + x;
          if (Math.abs(gray[i] - this.bg[i]) > this.pixelThreshold) changed++;
          total++;
        }
      }
      return total ? changed / total : 0;
    }

    _updateZone(z, fraction, t) {
      z.fraction = fraction;
      if (fraction >= this.activeFraction) {
        if (!z.on) z.onSince = t;
        z.on = true;
        z.lastActive = t;
      } else if (z.on && fraction < this.activeFraction * 0.5 && t - z.lastActive > this.clearMs) {
        z.on = false; // hysteresis: needs to be clearly quiet for a moment
      }
    }

    // gray: Uint8Array/Uint8ClampedArray of width*height brightness values
    // t: time in ms. Returns null or { dir: "AtoB" | "BtoA", t }
    process(gray, t) {
      const n = this.width * this.height;
      if (!this.bg) {
        this.bg = new Float32Array(n);
        for (let i = 0; i < n; i++) this.bg[i] = gray[i];
        return null;
      }

      this._updateZone(this.zone.A, this._fraction(gray, this.zoneA), t);
      this._updateZone(this.zone.B, this._fraction(gray, this.zoneB), t);
      const A = this.zone.A, B = this.zone.B;

      // Learn the empty lane slowly; almost freeze learning while something is in a zone
      const alpha = A.on || B.on ? 0.002 : 0.05;
      for (let i = 0; i < n; i++) this.bg[i] += alpha * (gray[i] - this.bg[i]);

      // Something parked in a zone for too long (or lighting changed): relearn
      if ((A.on && t - A.onSince > this.maxBlockedMs) || (B.on && t - B.onSince > this.maxBlockedMs)) {
        for (let i = 0; i < n; i++) this.bg[i] = gray[i];
        this.reset();
        return null;
      }

      let event = null;
      if (this.phase === "idle") {
        if (A.on && !B.on) { this.phase = "armed"; this.first = "A"; this.firstAt = t; }
        else if (B.on && !A.on) { this.phase = "armed"; this.first = "B"; this.firstAt = t; }
        else if (A.on && B.on) this.phase = "cooldown"; // both at once: can't tell direction, skip
      } else if (this.phase === "armed") {
        const other = this.first === "A" ? B : A;
        if (other.on) {
          event = { dir: this.first === "A" ? "AtoB" : "BtoA", t };
          this.phase = "cooldown";
        } else if (t - this.firstAt > this.maxGapMs) {
          this.phase = "idle"; // never reached the other zone (turned back, or something small passed)
        }
      } else if (this.phase === "cooldown") {
        if (!A.on && !B.on) this.phase = "idle";
      }
      return event;
    }
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { TwoZoneDetector };
  else root.TwoZoneDetector = TwoZoneDetector;
})(typeof window !== "undefined" ? window : globalThis);

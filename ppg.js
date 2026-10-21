/**
 * PPG signaalanalyse — puur rekenwerk, geen DOM-afhankelijkheden.
 * Werkt zowel in de browser (ES module) als in Node voor tests.
 */

export const FS = 30; // resample-frequentie in Hz (uniform raster voor autocorrelatie)

export const ANALYSIS = {
  minSpanSec: 6, // minimale hoeveelheid data voordat een schatting mogelijk is
  maxBufferSec: 22, // lengte van het analysevenster
  driftWindowSec: 2.2, // venster voor langzame trendverwijdering
  bpmMin: 40,
  bpmMax: 220,
  minPulseAmp: 0.3, // minimale piek-tot-piek amplitude (pixelwaarden) na detrend; lager = vlak signaal
};

/**
 * Ligt er een vingertop op de lens? Twee routes (een van beide volstaat):
 * - gemiddelde helderheid binnen een bruikbaar bereik (flits door de huid), of
 * - rood-dominant beeld (ook bij weinig licht / zonder flits, als de totale
 *   helderheid laag is maar bloed het rode kanaal duidelijk laat overheersen).
 */
export function fingerContact(r, g, b) {
  const mean = (r + g + b) / 3;
  if (mean >= 245) return false; // overbelicht: geen vinger
  if (mean > 25) return true;
  return r >= 15 && r > 1.2 * b && r >= 1.1 * g;
}

/** Verwijder langzame drift: signaal minus voortschrijdend gemiddelde. */
export function detrend(values, winSamples) {
  const n = values.length;
  const out = new Float64Array(n);
  const half = Math.floor(winSamples / 2);
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + values[i];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(n, i + half + 1);
    const mean = (prefix[b] - prefix[a]) / (b - a);
    out[i] = values[i] - mean;
  }
  return out;
}

/** Lineaire interpolatie naar een uniform raster van FS Hz. */
export function resample(timesSec, values, tStart, tEnd) {
  const n = Math.max(2, Math.floor((tEnd - tStart) * FS) + 1);
  const out = new Float64Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = tStart + i / FS;
    if (t <= timesSec[0]) { out[i] = values[0]; continue; }
    if (t >= timesSec[timesSec.length - 1]) { out[i] = values[values.length - 1]; continue; }
    while (j < timesSec.length - 1 && timesSec[j + 1] < t) j++;
    const t0 = timesSec[j], t1 = timesSec[j + 1];
    const f = (t - t0) / Math.max(1e-9, t1 - t0);
    out[i] = values[j] * (1 - f) + values[j + 1] * f;
  }
  return out;
}

/** Genormaliseerde autocorrelatie voor lags binnen [lagMin, lagMax]. */
export function autocorrelate(x, lagMin, lagMax) {
  const n = x.length;
  const lags = [];
  for (let L = lagMin; L <= lagMax && L < n - 2; L++) {
    let s0 = 0, s1 = 0, s2 = 0;
    for (let i = 0; i + L < n; i++) {
      s0 += x[i] * x[i];
      s1 += x[i + L] * x[i + L];
      s2 += x[i] * x[i + L];
    }
    const denom = Math.sqrt(s0 * s1);
    lags.push({ lag: L, r: denom > 1e-12 ? s2 / denom : 0 });
  }
  return lags;
}

/**
 * Zoek de beste hartslag uit autocorrelatiepieken.
 * Kiest de kleinste lag binnen 90% van de hoogste piek om halveren
 * (sterke piek op 2x de periode) te voorkomen; eist een lokaal maximum.
 */
export function pickPeak(lags) {
  if (lags.length < 3) return null;
  let best = null;
  for (const p of lags) if (!best || p.r > best.r) best = p;
  if (!best || best.r <= 0) return null;

  const locals = [];
  for (let i = 1; i < lags.length - 1; i++) {
    if (lags[i].r >= lags[i - 1].r && lags[i].r >= lags[i + 1].r) {
      locals.push(lags[i]);
    }
  }
  const threshold = best.r * 0.9;
  const candidates = locals.filter((p) => p.r >= threshold);
  if (candidates.length === 0) {
    // Geen binnenliggende lokale piek: als het globale maximum op de rand
    // van het zoekbereik ligt, is de autocorrelatie monotoon dalend
    // (glad driftrestant) en is er geen echte periode.
    const atBoundary = best.lag <= lags[0].lag + 0.01 || best.lag >= lags[lags.length - 1].lag - 0.01;
    if (atBoundary) return null;
    candidates.push(best);
  }
  const chosen = candidates.reduce((a, b) => (a.lag <= b.lag ? a : b));

  // Prominentie: een echte hartslag-piek steekt duidelijk boven de omgeving
  // (±3 lags) uit. Een breed, vlak dalend dak is drift/ruis, geen pols.
  {
    const i0 = Math.max(0, lags.indexOf(chosen) - 3);
    const i1 = Math.min(lags.length - 1, lags.indexOf(chosen) + 3);
    let minR = Infinity;
    for (let k = i0; k <= i1; k++) minR = Math.min(minR, lags[k].r);
    if (chosen.r - minR < 0.08) return null;
  }

  // Parabolische interpolatie voor sub-sample precisie
  const i = lags.indexOf(chosen);
  let lag = chosen.lag, r = chosen.r;
  if (i > 0 && i < lags.length - 1) {
    const y0 = lags[i - 1].r, y1 = lags[i].r, y2 = lags[i + 1].r;
    const denom = y0 - 2 * y1 + y2;
    if (Math.abs(denom) > 1e-12) {
      const shift = (0.5 * (y0 - y2)) / denom;
      if (Math.abs(shift) < 0.5) {
        lag = chosen.lag + shift;
        r = y1 - 0.25 * (y0 - y2) * shift;
      }
    }
  }
  return { lag, r };
}

/** Licht gladstrijken (3-tap) om framerruis te dempen. */
export function smooth(x) {
  const n = x.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = x[Math.max(0, i - 1)];
    const b = x[i];
    const c = x[Math.min(n - 1, i + 1)];
    out[i] = (a + 2 * b + c) / 4;
  }
  return out;
}

/**
 * Detecteer pieken (hartslagen) in een gedetrend signaal.
 */
export function findPeaks(det, minDist) {
  const n = det.length;
  const m = det.reduce((a, b) => a + b, 0) / n;
  let std = 0;
  for (const v of det) std += (v - m) * (v - m);
  std = Math.sqrt(std / n);
  const peaks = [];
  for (let i = 1; i < n - 1; i++) {
    const isMax = det[i] > det[i - 1] && det[i] >= det[i + 1] && det[i] > m + 0.5 * std;
    if (!isMax) continue;
    peaks.push(i);
  }
  // Merge pieken die dichter dan minDist bij elkaar liggen: houd de hoogste
  const merged = [];
  for (const p of peaks) {
    const q = merged[merged.length - 1];
    if (q !== undefined && p - q < minDist) {
      if (det[p] > det[q]) merged[merged.length - 1] = p;
    } else {
      merged.push(p);
    }
  }
  return merged;
}

/**
 * Analyseklasse: verzamelt (tijd, r, g, b)-monsters en schat de hartslag.
 */
export class PpgAnalyzer {
  constructor() {
    this.buf = []; // { t: s, r, g, b }
  }

  reset() {
    this.buf.length = 0;
  }

  /** t in seconden (monotone klok), r/g/b gemiddelde pixelwaarden 0-255. */
  push(t, r, g, b) {
    this.buf.push({ t, r, g, b });
    const cutoff = t - ANALYSIS.maxBufferSec;
    while (this.buf.length > 2 && this.buf[0].t < cutoff) this.buf.shift();
  }

  get spanSec() {
    return this.buf.length >= 2 ? this.buf[this.buf.length - 1].t - this.buf[0].t : 0;
  }

  /**
   * Beoordeel één kleurkanaal: autocorrelatie + kruischeck met piek-tussenpozen.
   * Geeft null bij onbruikbaar kanaal, anders een kanaalresultaat met score.
   */
  evaluateChannel(c, times, vals, tStart, tEnd, lagMin, lagMax) {
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    if (mean > 248) return null; // verzadigd (flits op huid)
    if (mean < 12) return null; // te donker / geen contact
    const grid = resample(times, vals, tStart, tEnd);
    const det = smooth(detrend(grid, Math.round(ANALYSIS.driftWindowSec * FS)));

    // Signaalsterkte: zonder zichtbare pulsatie is geen betrouwbaar getal mogelijk
    let lo = Infinity, hi = -Infinity;
    for (const v of det) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (hi - lo < ANALYSIS.minPulseAmp) return { c, det, flat: true, score: 0, peak: null, finalBpm: null, lastPeak: null };

    const lags = autocorrelate(det, lagMin, lagMax);
    const peak = pickPeak(lags);
    if (!peak) return { c, det, score: 0, peak: null, finalBpm: null, lastPeak: null };

    // Piek-tussenpozen (RR-intervallen): verankerd aan echte golfpieken
    const peaks = findPeaks(det, Math.round(0.3 * FS));
    let rrBpm = null, rrStable = false;
    if (peaks.length >= 5) {
      const intervals = [];
      for (let i = 1; i < peaks.length; i++) {
        const d = (peaks[i] - peaks[i - 1]) / FS;
        if (d > 0.25 && d < 2) intervals.push(d);
      }
      if (intervals.length >= 4) {
        intervals.sort((a, b) => a - b);
        const med = intervals[Math.floor(intervals.length / 2)];
        let mad = 0;
        for (const iv of intervals) mad += Math.abs(iv - med);
        mad /= intervals.length;
        rrStable = mad < 0.18 * med;
        const rr = 60 / med;
        if (rr >= ANALYSIS.bpmMin && rr <= ANALYSIS.bpmMax) rrBpm = rr;
      }
    }

    const bpm = (60 * FS) / peak.lag;
    let finalBpm = bpm;
    let score = peak.r;
    if (rrBpm !== null && rrStable) {
      const ratio = bpm / rrBpm;
      if (ratio > 1.3 || ratio < 0.77) {
        // Verdubbeling of halvering: de RR-schatting wint
        finalBpm = rrBpm;
        score *= 0.6; // twijfelachtig kanaal
      } else if (ratio > 0.9 && ratio < 1.12) {
        score *= 1.2; // autocorrelatie en RR bevestigen elkaar
      }
    }
    const lastPeak = peaks.length ? peaks[peaks.length - 1] : null;
    return { c, det, peak, finalBpm, score, rrBpm, lastPeak };
  }

  /**
   * Geeft { bpm, confidence, channel, quality } of { bpm: null, reason }.
   * quality: 'goed' | 'matig'
   */
  estimate() {
    const span = this.spanSec;
    if (span < ANALYSIS.minSpanSec) {
      return { bpm: null, reason: 'weinig-data', progress: span / ANALYSIS.minSpanSec };
    }
    const buf = this.buf;
    const tStart = buf[0].t, tEnd = buf[buf.length - 1].t;
    const times = buf.map((s) => s.t);
    const lagMin = Math.max(2, Math.round((60 / ANALYSIS.bpmMax) * FS));
    const lagMax = Math.round((60 / ANALYSIS.bpmMin) * FS);

    let best = null;
    for (const c of ['r', 'g', 'b']) {
      const res = this.evaluateChannel(c, times, buf.map((s) => s[c]), tStart, tEnd, lagMin, lagMax);
      if (res && (!best || res.score > best.score)) best = res;
    }
    if (!best) {
      const dark = buf.every((s) => (s.r + s.g + s.b) / 3 < 12);
      return { bpm: null, reason: dark ? 'geen-contact' : 'verzadigd' };
    }
    if (best.flat) return { bpm: null, reason: 'vlak-signaal' };
    if (!best.peak || best.peak.r < 0.35) {
      return { bpm: null, reason: 'geen-betrouwbaar-signaal', confidence: best.peak ? best.peak.r : 0 };
    }
    if (best.finalBpm < ANALYSIS.bpmMin || best.finalBpm > ANALYSIS.bpmMax) {
      return { bpm: null, reason: 'buiten-bereik' };
    }
    // Recent hartslag-activiteit vereist: anders is het contact (net) verloren
    if (best.lastPeak === null || (best.lastPeak / FS) < (tEnd - tStart) - 4) {
      return { bpm: null, reason: 'geen-contact' };
    }

    // Stationariteitscontrole: een echte pols geeft in de eerste en tweede
    // helft van het venster dezelfde hartslag. Drift- en ruisartefacten
    // verschuiven tussen de helften.
    const half = Math.floor(best.det.length / 2);
    const halfA = autocorrelate(best.det.subarray(0, half), lagMin, lagMax);
    const halfB = autocorrelate(best.det.subarray(half), lagMin, lagMax);
    const peakA = pickPeak(halfA);
    const peakB = pickPeak(halfB);
    if (!peakA || !peakB || peakA.r < 0.3 || peakB.r < 0.3) {
      return { bpm: null, reason: 'geen-betrouwbaar-signaal' };
    }
    const bpmA = (60 * FS) / peakA.lag;
    const bpmB = (60 * FS) / peakB.lag;
    if (Math.abs(bpmA - bpmB) > 0.18 * Math.max(bpmA, bpmB)) {
      return { bpm: null, reason: 'geen-betrouwbaar-signaal' };
    }

    return {
      bpm: Math.round(best.finalBpm),
      confidence: Math.min(1, best.peak.r),
      channel: best.c,
      quality: best.peak.r >= 0.55 ? 'goed' : 'matig',
      rrBpm: best.rrBpm !== null ? Math.round(best.rrBpm) : null,
    };
  }

  /** Tijdstip (s) van de meest recente gedetecteerde hartslag-piek. */
  lastBeatTime() {
    const buf = this.buf;
    if (buf.length < 10) return null;
    const vals = buf.map((s) => s.r + s.g + s.b); // som is robuuster voor piekdetectie
    const det = detrend(vals, Math.round(ANALYSIS.driftWindowSec * FS));
    const peaks = findPeaks(det, Math.round(0.35 * FS));
    return peaks.length ? buf[peaks[peaks.length - 1]].t : null;
  }
}

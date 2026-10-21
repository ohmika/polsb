/**
 * Tests voor ppg.js met synthetische PPG-signalen.
 * Draaien met: node test-ppg.mjs
 */
import { PpgAnalyzer, ANALYSIS, FS, fingerContact } from './ppg.js';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
}

/** Maak een realistische PPG-curve voor één hartslag (systolische piek + dicrotige inkeping). */
function ppgWave(phase) {
  // hoofdpiekt
  let v = 0.85 * Math.exp(-Math.pow((phase - 0.16) / 0.075, 2));
  // dicrotige inkeping (secundaire bult)
  v += 0.25 * Math.exp(-Math.pow((phase - 0.42) / 0.07, 2));
  return v;
}

/** Reproduceerbare pseudo-random generator (vaste reeks per run). */
let seed = 20261020;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

/**
 * Genereer monsters zoals een camera die levert.
 * bpm: hartslag; durationSec: lengte; opts: {noise, drift, fps, saturatedRed, dc}
 */
function makeSamples(bpm, durationSec, opts = {}) {
  const {
    noise = 0.35, // ruis in pixelwaarden
    drift = 0.08, // langzame helderheidsdrift (fractie per seconde)
    fps = 30,
    saturatedRed = true, // rode kanaal verzadigd (flits)
    dc = 150, // gemiddelde helderheid
    pulseDepth = 2.2, // pulsatiediepte in pixelwaarden
  } = opts;

  const out = [];
  let t = 0;
  // jitter op frame-tijdstippen
  while (t < durationSec) {
    const jitter = (rnd() - 0.5) * 0.012;
    const tt = t + jitter;
    const period = 60 / bpm;
    const phase = (tt % period) / period;
    const beat = ppgWave(phase);
    const driftTerm = 1 + drift * Math.sin(2 * Math.PI * 0.07 * tt + 1.3);
    const g = dc * driftTerm + pulseDepth * beat + (rnd() - 0.5) * 2 * noise;
    const b = dc * 0.55 * driftTerm + pulseDepth * 0.15 * beat + (rnd() - 0.5) * 2 * noise;
    const r = saturatedRed ? 254 + rnd() : dc * 1.35 * driftTerm + pulseDepth * 0.3 * beat + (rnd() - 0.5) * 2 * noise;
    out.push({ t: tt, r: Math.min(255, r), g: Math.max(0, Math.min(255, g)), b: Math.max(0, Math.min(255, b)) });
    t += 1 / fps + (rnd() - 0.5) * 0.004;
  }
  return out;
}

function run(bpm, durationSec = 20, opts = {}) {
  const a = new PpgAnalyzer();
  for (const s of makeSamples(bpm, durationSec, opts)) a.push(s.t, s.r, s.g, s.b);
  return a.estimate();
}

console.log('\n-- Zuivere hartslagen (met dicrotige inkeping, ruis en drift) --');
for (const bpm of [45, 60, 72, 80, 90, 100, 120, 150, 180]) {
  const res = run(bpm);
  check(`bpm=${bpm} -> ${res.bpm ?? res.reason}`, res.bpm !== null && Math.abs(res.bpm - bpm) <= 3,
    `kreeg ${JSON.stringify(res)}`);
}

console.log('\n-- Lagere fps en meer ruis --');
// 24/60fps met normale ruis zijn strikte positieve tests;
// alleen de zwaarste ruiscase mag ook geweigerd worden (nooit verkeerd)
for (const [bpm, opts, magWeigeren] of [
  [72, { fps: 24, noise: 0.8 }, false],
  [72, { fps: 60, noise: 0.5 }, false],
  [90, { fps: 30, noise: 1.2, drift: 0.2 }, true],
]) {
  const res = run(bpm, 20, opts);
  const ok = magWeigeren
    ? res.bpm === null || Math.abs(res.bpm - bpm) <= 4
    : res.bpm !== null && Math.abs(res.bpm - bpm) <= 4;
  check(`bpm=${bpm} opts=${JSON.stringify(opts)}${magWeigeren ? ' (mag weigeren)' : ''} -> ${res.bpm ?? res.reason}`, ok, `kreeg ${JSON.stringify(res)}`);
}

console.log('\n-- Drift + ruis zonder polssignaal: moet altijd geweigerd worden --');
{
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const a = new PpgAnalyzer();
  let t = 0;
  while (t < 20) {
    const driftTerm = 1 + 0.08 * Math.sin(2 * Math.PI * 0.07 * t + 1.3);
    const g = 150 * driftTerm + (rnd() - 0.5) * 2.0;
    a.push(t, 254, Math.max(0, Math.min(255, g)), 80);
    t += 1 / 30;
  }
  const res = a.estimate();
  check(`drift zonder pols -> null (${res.bpm === null ? res.reason : res.bpm + '!!'})`, res.bpm === null);
}
{
  // Zelfde drift maar zonder pulsdiepte op meerdere zaadjes
  let fp = 0;
  for (let seed = 1; seed <= 10; seed++) {
    let s = seed * 7919;
    const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
    const a = new PpgAnalyzer();
    let t = 0;
    while (t < 20) {
      const jitter = (rnd() - 0.5) * 0.012;
      const tt = t + jitter;
      const driftTerm = 1 + 0.08 * Math.sin(2 * Math.PI * 0.07 * tt + 1.3);
      const g = 150 * driftTerm + (rnd() - 0.5) * 2.0;
      a.push(tt, 254, Math.max(0, Math.min(255, g)), 80);
      t += 1 / 30 + (rnd() - 0.5) * 0.004;
    }
    if (a.estimate().bpm !== null) fp++;
  }
  check(`drift+ruis zonder pols, 10 realisaties -> 0 vals (${fp} gevonden)`, fp === 0);
}

console.log('\n-- Weinig licht, zonder flits (zwakke puls) --');
for (const [dc, pulseDepth, noise] of [[60, 1.5, 0.3], [40, 1.0, 0.3], [40, 0.6, 0.2], [25, 0.8, 0.2]]) {
  const res = run(72, 20, { saturatedRed: false, dc, pulseDepth, noise, drift: 0.02 });
  check(`dim dc=${dc} diepte=${pulseDepth} ruis=${noise} -> ${res.bpm ?? res.reason}`,
    res.bpm !== null && Math.abs(res.bpm - 72) <= 3, `kreeg ${JSON.stringify(res)}`);
}

console.log('\n-- Vingercontact-herkenning --');
check('flits op vinger (255,110,60) -> contact', fingerContact(255, 110, 60));
check('dim, rood-dominant (34,25,14) -> contact', fingerContact(34, 25, 14));
check('donker beeld (5,5,5) -> geen contact', !fingerContact(5, 5, 5));
check('dim neutraal grijs (20,20,20) -> geen contact', !fingerContact(20, 20, 20));
check('overbelicht (250,250,250) -> geen contact', !fingerContact(250, 250, 250));

console.log('\n-- Zonder verzadigd rood kanaal (geen flits) --');
{
  const res = run(72, 20, { saturatedRed: false });
  check(`bpm=72 zonder flits -> ${res.bpm ?? res.reason}`, res.bpm !== null && Math.abs(res.bpm - 72) <= 3);
}

console.log('\n-- Ongeldige signalen moeten geweigerd worden --');
{
  // Vlak signaal (geen vinger / geen pulsatie)
  const a = new PpgAnalyzer();
  for (let t = 0; t < 20; t += 1 / 30) {
    a.push(t, 254, 150 + rnd() * 0.2, 80 + rnd() * 0.2);
  }
  const res = a.estimate();
  check(`vlak signaal -> geweigerd (${res.bpm === null ? res.reason : res.bpm + '!!'})`, res.bpm === null);
}
{
  // Puur willekeurige ruis
  const a = new PpgAnalyzer();
  for (let t = 0; t < 20; t += 1 / 30) {
    a.push(t, 100 + rnd() * 40, 100 + rnd() * 40, 60 + rnd() * 40);
  }
  const res = a.estimate();
  check(`pure ruis -> geweigerd (${res.bpm === null ? res.reason : res.bpm + '!!'})`, res.bpm === null);
}
{
  // Geen contact (donker beeld)
  const a = new PpgAnalyzer();
  for (let t = 0; t < 20; t += 1 / 30) a.push(t, 3 + rnd() * 2, 4 + rnd() * 2, 2 + rnd());
  const res = a.estimate();
  check(`geen contact -> geweigerd (${res.bpm === null ? res.reason : res.bpm + '!!'})`, res.bpm === null);
}
{
  // Te weinig data
  const a = new PpgAnalyzer();
  for (const s of makeSamples(72, 4)) a.push(s.t, s.r, s.g, s.b);
  const res = a.estimate();
  check(`4s data -> 'weinig-data' (${res.reason})`, res.bpm === null && res.reason === 'weinig-data');
}

console.log('\n-- Contactverlies midden in meting --');
{
  const a = new PpgAnalyzer();
  const good = makeSamples(72, 12);
  for (const s of good) a.push(s.t, s.r, s.g, s.b);
  for (let t = 12; t < 20; t += 1 / 30) a.push(t, 254, 148 + rnd() * 0.3, 80);
  const res = a.estimate();
  check(`na contactverlies -> geweigerd (${res.bpm === null ? res.reason : res.bpm + '!!'})`, res.bpm === null);
}

console.log('\n-- Hartslag verandert tijdens meting (opwarmen) --');
{
  const a = new PpgAnalyzer();
  for (const s of makeSamples(60, 10)) a.push(s.t, s.r, s.g, s.b);
  for (const s of makeSamples(80, 12)) a.push(s.t + 10, s.r, s.g, s.b);
  const res = a.estimate();
  // Venster van 22s bevat beide. Een tussenwaarde (bv. 70) is fout: weigeren
  // (null) of de recente hartslag (80) is correct.
  check(`60->80 bpm -> geweigerd of ~80 (${res.bpm ?? res.reason})`,
    res.bpm === null || Math.abs(res.bpm - 80) <= 4);
}

console.log(`\n${pass} geslaagd, ${fail} mislukt`);
process.exit(fail ? 1 : 0);

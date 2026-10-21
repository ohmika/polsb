import { PpgAnalyzer, ANALYSIS, fingerContact } from './ppg.js';

/* ---------- Elementen ---------- */
const el = (id) => document.getElementById(id);
const bpmEl = el('bpm');
const statusEl = el('status');
const pulseDot = el('pulseDot');
const traceWrap = el('traceWrap');
const traceCanvas = el('trace');
const progress = el('progress');
const progressFill = el('progressFill');
const previewWrap = el('previewWrap');
const preview = el('preview');
const previewNote = el('previewNote');
const startBtn = el('startBtn');
const btnLabel = el('btnLabel');
const qualityEl = el('quality');
const howto = el('howto');

const MEASURE_SEC = 15; // duur van de meting nadat contact is gevonden

/* ---------- Toestand ---------- */
let state = 'idle'; // idle | start | meeting | klaar
let generation = 0; // beschermt tegen races tussen start en stop
let stream = null;
let track = null;
let torchOn = false;
let analyzer = new PpgAnalyzer();
let rafId = 0;
let vfcId = 0;
let lastMediaTime = -1;
let lastEstimate = 0;
let estimates = []; // { bpm, q }-schattingen tijdens de meetfase
let contactAt = null; // tijdstip waarop vingercontact werd gedetecteerd
let lastValidAt = null; // tijdstip van de laatste geldige schatting
let lastBeatT = null;
let resultBpm = null;
let stopCameraLink = null;
let traceRaf = 0;
let lastDraw = 0;
let wakeLock = null;
let lastStatus = '';

const traceCtx = traceCanvas.getContext('2d');
const sampleCanvas = document.createElement('canvas');
sampleCanvas.width = 32;
sampleCanvas.height = 32;
const sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });

/* ---------- Tekst ---------- */
const REASON_MSG = {
  'weinig-data': 'Signaal opbouwen… even geduld.',
  'geen-contact': 'Plaats je <strong>vingertip volledig</strong> over de camera, met de flits ertegen.',
  verzadigd: 'Te veel licht of te hard gedrukt — leg je vinger rustiger op de lens.',
  'vlak-signaal': 'Nog geen puls zichtbaar. Houd je vinger rustig en stil op de lens.',
  'geen-betrouwbaar-signaal': 'Signaal te onrustig. Blijf stil zitten en adem rustig.',
  'buiten-bereik': 'Signaal te onrustig. Houd je vinger stil op de lens.',
};

/* ---------- Camera ---------- */
const NO_TORCH_NOTE = 'Geen flits — meet in een lichte ruimte, leg je vinger rustig op de lens';
async function startCamera(gen) {
  const constraints = {
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 320 },
      height: { ideal: 240 },
      frameRate: { ideal: 30 },
    },
    audio: false,
  };
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('Camera is alleen beschikbaar via een beveiligde verbinding (https).');
  }
  let local;
  try {
    local = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    const name = err && err.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new Error('Camera-toegang geweigerd. Sta de camera toe in de instellingen van je browser en probeer opnieuw.');
    }
    if (name === 'NotReadableError' || name === 'AbortError') {
      throw new Error('De camera is in gebruik door een andere app. Sluit die eerst en probeer opnieuw.');
    }
    throw new Error('Geen camera beschikbaar op dit apparaat.');
  }

  // Gedurende de hele startpoging blijft de stream lokaal. Globale toestand
  // wordt alleen aangeraakt als die nog van deze poging is, zodat een verlopen
  // poging nooit een nieuwere camera-verbinding kan stoppen.
  const verlopen = () => gen !== generation;
  const ruimOpLokaal = () => {
    const eigenTrack = local.getVideoTracks()[0];
    if (torchOn && eigenTrack && stream === local) {
      try { eigenTrack.applyConstraints({ advanced: [{ torch: false }] }); } catch { /* ignore */ }
    }
    local.getTracks().forEach((t) => t.stop());
    if (stream === local) {
      stream = null;
      track = null;
      torchOn = false;
      previewWrap.hidden = true;
      preview.srcObject = null;
    }
  };

  if (verlopen()) { ruimOpLokaal(); return false; }

  stream = local;
  track = local.getVideoTracks()[0];
  preview.srcObject = local;
  preview.play().catch(() => { /* gedempte video mag altijd afspelen */ });
  previewWrap.hidden = false;

  // Flits aanzetten als het apparaat dat ondersteunt (PPG heeft licht nodig)
  try {
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    if (caps && caps.torch) {
      await track.applyConstraints({ advanced: [{ torch: true }] });
      if (verlopen()) { ruimOpLokaal(); return false; }
      torchOn = true;
      previewNote.textContent = 'Flits aan — licht schijnt door je vinger';
    } else {
      previewNote.textContent = NO_TORCH_NOTE;
    }
  } catch {
    previewNote.textContent = NO_TORCH_NOTE;
  }
  if (verlopen()) { ruimOpLokaal(); return false; }
  return true;
}

function stopCamera() {
  cancelAnimationFrame(rafId);
  cancelAnimationFrame(traceRaf);
  traceRaf = 0;
  unlockScreen();
  if (vfcId && preview.cancelVideoFrameCallback) {
    try { preview.cancelVideoFrameCallback(vfcId); } catch { /* ignore */ }
    vfcId = 0;
  }
  lastMediaTime = -1;
  if (track) {
    if (torchOn) {
      try { track.applyConstraints({ advanced: [{ torch: false }] }); } catch { /* ignore */ }
    }
    track.stop();
  }
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  track = null;
  torchOn = false;
  previewWrap.hidden = true;
  preview.srcObject = null;
}

/* ---------- Frame-verwerking ---------- */
function sampleFrame() {
  if (!track || track.readyState !== 'live') return;
  const w = preview.videoWidth, h = preview.videoHeight;
  if (!w || !h) return;
  sampleCtx.drawImage(preview, 0, 0, 32, 32);
  const data = sampleCtx.getImageData(0, 0, 32, 32).data;
  // Gemiddelde van het middengebied (8x8 middenstuk)
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = 12; y < 20; y++) {
    for (let x = 12; x < 20; x++) {
      const i = (y * 32 + x) * 4;
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    }
  }
  analyzer.push(performance.now() / 1000, r / n, g / n, b / n);
}

function frameLoop() {
  sampleFrame();
  rafId = requestAnimationFrame(frameLoop);
}

// Voorkeur voor requestVideoFrameCallback: telt elk camerabeeld precies één keer
function frameLoopVfc() {
  vfcId = preview.requestVideoFrameCallback((now, meta) => {
    if (meta && meta.mediaTime === lastMediaTime) {
      frameLoopVfc(); // duplicaatframe overslaan
      return;
    }
    if (meta) lastMediaTime = meta.mediaTime;
    sampleFrame();
    frameLoopVfc();
  });
}

/* ---------- Signaalgrafiek ---------- */
function traceLoop(ts) {
  traceRaf = requestAnimationFrame(traceLoop);
  if (ts - lastDraw < 50) return; // ~20 fps is genoeg voor een grafiek
  lastDraw = ts;
  drawTrace();
}

function drawTrace() {
  const buf = analyzer.buf;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(traceWrap.clientWidth * dpr);
  const h = Math.round(90 * dpr);
  if (traceCanvas.width !== w) traceCanvas.width = w; // alleen aanpassen bij verandering (reset het canvas)
  if (traceCanvas.height !== h) traceCanvas.height = h;
  traceCtx.clearRect(0, 0, w, h);
  if (buf.length < 10) return;
  const viewSec = 8;
  const cutoff = (buf[buf.length - 1].t - viewSec);
  const view = buf.filter((s) => s.t >= cutoff);
  if (view.length < 10) return;
  const vals = view.map((s) => s.g);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 2) { const m = (hi + lo) / 2; lo = m - 1; hi = m + 1; }
  const pad = h * 0.15;
  traceCtx.beginPath();
  traceCtx.strokeStyle = '#ff8296';
  traceCtx.lineWidth = Math.max(1.5, 1.5 * (window.devicePixelRatio || 1));
  traceCtx.lineJoin = 'round';
  const t0 = view[0].t, t1 = view[view.length - 1].t;
  for (let i = 0; i < view.length; i++) {
    const x = ((view[i].t - t0) / Math.max(1e-6, t1 - t0)) * w;
    const y = h - pad - ((vals[i] - lo) / (hi - lo)) * (h - 2 * pad);
    if (i === 0) traceCtx.moveTo(x, y); else traceCtx.lineTo(x, y);
  }
  traceCtx.stroke();
}

/* ---------- Puls-animatie ---------- */
function triggerBeat() {
  pulseDot.classList.remove('beat');
  void pulseDot.offsetWidth; // herstart animatie
  pulseDot.classList.add('beat');
}

/* ---------- Status ---------- */
function setStatus(html) {
  if (html === lastStatus) return; // voorkomt onnodige aankondigingen door schermlezers
  lastStatus = html;
  statusEl.innerHTML = html;
}

/* ---------- Scherm aan houden tijdens de meting ---------- */
async function lockScreen() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch { /* niet kritisch */ }
}

function unlockScreen() {
  if (wakeLock) {
    wakeLock.release().catch(() => { /* ignore */ });
    wakeLock = null;
  }
}

/* ---------- Hoofdlus ---------- */
async function tick() {
  const now = performance.now() / 1000;
  if (now - lastEstimate < 0.5) return;
  lastEstimate = now;
  if (analyzer.spanSec < 1) return;

  const res = analyzer.estimate();

  // Hartslag-piek gedetecteerd? Toon puls-animatie
  const beat = analyzer.lastBeatTime();
  if (beat !== null && beat !== lastBeatT) {
    lastBeatT = beat;
    triggerBeat();
  }

  if (state === 'meeting') {
    // Contact gedetecteerd? Start de daadwerkelijke telling
    // (bepaald over de laatste 3 seconden, niet de hele buffer)
    const recent = analyzer.buf.filter((s) => s.t > now - 3);
    let sr = 0, sg = 0, sb = 0;
    for (const s of recent) { sr += s.r; sg += s.g; sb += s.b; }
    const nRecent = recent.length;
    const contact = nRecent > 0 && fingerContact(sr / nRecent, sg / nRecent, sb / nRecent);
    if (contact) {
      if (contactAt === null) {
        contactAt = now;
        analyzer.reset(); // verse start na (her)plaatste vinger
        estimates = [];
        lastValidAt = null;
        bpmEl.textContent = '–';
        bpmEl.classList.remove('measure');
        progressFill.style.width = '0%';
        progress.setAttribute('aria-valuenow', 0);
        return; // deze tick nog geen schatting gebruiken
      }
    } else if (contactAt !== null) {
      // Vinger weg: tussenstand wissen en opnieuw laten beginnen bij terugkeer
      contactAt = null;
      estimates = [];
      lastValidAt = null;
      bpmEl.textContent = '–';
      bpmEl.classList.remove('measure');
      progressFill.style.width = '0%';
      progress.setAttribute('aria-valuenow', 0);
    }
    if (contactAt === null) {
      setStatus(REASON_MSG['geen-contact']);
      return;
    }
    const elapsed = now - contactAt;
    const pct = Math.min(100, (elapsed / MEASURE_SEC) * 100);
    progressFill.style.width = `${pct}%`;
    progress.setAttribute('aria-valuenow', Math.round(pct));
    if (res.bpm !== null) {
      lastValidAt = now;
      estimates.push({ bpm: res.bpm, q: res.quality });
      const recent2 = estimates.slice(-8);
      const live = median(recent2.map((e) => e.bpm));
      bpmEl.textContent = live;
      bpmEl.classList.add('measure');
      setStatus(`Aan het meten… <strong aria-hidden="true">${Math.ceil(MEASURE_SEC - elapsed)}</strong> s`);
    } else {
      setStatus(REASON_MSG[res.reason] ?? 'Even geduld…');
      // Signaal weg terwijl de vinger wel op de lens ligt: tussenstand laten vervallen
      if (lastValidAt !== null && now - lastValidAt > 4) {
        contactAt = null;
        estimates = [];
        lastValidAt = null;
        bpmEl.textContent = '–';
        bpmEl.classList.remove('measure');
        progressFill.style.width = '0%';
        progress.setAttribute('aria-valuenow', 0);
        return;
      }
    }
    if (elapsed >= MEASURE_SEC) finishMeasurement();
  } else if (state === 'klaar') {
    // Live bijwerken na afgeronde meting
    if (res.bpm !== null) {
      lastValidAt = now;
      resultBpm = res.bpm;
      bpmEl.textContent = resultBpm;
      bpmEl.classList.remove('stale');
      setStatus('Live meting — druk op <strong>Opnieuw meten</strong> voor een nieuwe 15-secondenmeting.');
    } else if (lastValidAt !== null && now - lastValidAt > 4) {
      // Signaal verloren: resultaat blijft staan, maar duidelijk gemarkeerd als verlopen
      bpmEl.classList.add('stale');
      qualityEl.hidden = true;
      setStatus('Signaal verloren — leg je vingertip weer op de camera om door te meten.');
    }
  }
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function finishMeasurement() {
  state = 'klaar';
  const valid = estimates.filter((e) => e.bpm >= ANALYSIS.bpmMin && e.bpm <= ANALYSIS.bpmMax);
  progressFill.style.width = '100%';
  btnLabel.textContent = 'Opnieuw meten';
  startBtn.classList.remove('stop');
  addStopLink();
  if (valid.length === 0) {
    resultBpm = null;
    bpmEl.textContent = '–';
    bpmEl.classList.remove('measure');
    setStatus('Geen betrouwbaar signaal gemeten. Probeer het opnieuw met je vingertip rustig op de lens.');
    qualityEl.hidden = false;
    qualityEl.textContent = '';
    qualityEl.classList.remove('ok');
    return;
  }
  // Alleen de laatste schattingen: die gebruiken het volledige venster en zijn het nauwkeurigst
  resultBpm = Math.round(median(valid.slice(-10).map((e) => e.bpm)));
  bpmEl.textContent = resultBpm;
  bpmEl.classList.remove('measure');
  bpmEl.classList.remove('stale');
  setStatus(`Meting voltooid — je hartslag is ongeveer <strong>${resultBpm}</strong> slagen per minuut.`);
  qualityEl.hidden = false;
  const goedCount = valid.filter((e) => e.q === 'goed').length;
  const goed = valid.length >= 8 && goedCount >= 0.6 * valid.length;
  qualityEl.textContent = goed ? 'Goed signaal' : 'Matig signaal — nog een keer meten kan nauwkeuriger';
  qualityEl.classList.toggle('ok', goed);
}

function addStopLink() {
  if (stopCameraLink) return;
  stopCameraLink = document.createElement('button');
  stopCameraLink.className = 'quality link-btn';
  stopCameraLink.textContent = 'Camera uitzetten';
  stopCameraLink.addEventListener('click', resetAll);
  qualityEl.insertAdjacentElement('afterend', stopCameraLink);
}

function removeStopLink() {
  if (stopCameraLink) {
    stopCameraLink.remove();
    stopCameraLink = null;
  }
}

/* ---------- Start/stop ---------- */
async function begin() {
  const gen = ++generation;
  state = 'start';
  btnLabel.textContent = 'Camera starten…';
  startBtn.disabled = true;
  analyzer = new PpgAnalyzer();
  estimates = [];
  contactAt = null;
  lastValidAt = null;
  lastBeatT = null;
  resultBpm = null;
  bpmEl.textContent = '–';
  bpmEl.classList.remove('measure', 'stale');
  qualityEl.hidden = true;
  qualityEl.classList.remove('ok');
  progressFill.style.width = '0%';
  progress.setAttribute('aria-valuenow', 0);
  removeStopLink();

  try {
    const gestart = await startCamera(gen);
    if (!gestart) return; // verlopen poging, al lokaal opgeruimd
  } catch (err) {
    // Bij een fout is er nog niets toegewezen: geen globale opruiming nodig
    state = 'idle';
    startBtn.disabled = false;
    btnLabel.textContent = 'Start meting';
    setStatus(err.message || 'Camera kon niet gestart worden.');
    return;
  }

  state = 'meeting';
  startBtn.disabled = false;
  btnLabel.textContent = 'Stop meting';
  startBtn.classList.add('stop');
  howto.open = false;
  setStatus('Zoek de camera even op…');
  lastEstimate = 0;
  if (typeof preview.requestVideoFrameCallback === 'function') {
    frameLoopVfc();
  } else {
    rafId = requestAnimationFrame(frameLoop);
  }
  setIntervalSafe();
  traceRaf = requestAnimationFrame(traceLoop);
  lockScreen();
}

function setIntervalSafe() {
  clearInterval(tickInterval);
  tickInterval = setInterval(tick, 250);
}
let tickInterval = 0;

function resetAll() {
  generation++; // lopende start annuleren
  clearInterval(tickInterval);
  tickInterval = 0;
  stopCamera();
  state = 'idle';
  startBtn.disabled = false;
  analyzer = new PpgAnalyzer();
  estimates = [];
  contactAt = null;
  lastValidAt = null;
  resultBpm = null;
  bpmEl.textContent = '–';
  bpmEl.classList.remove('measure', 'stale');
  qualityEl.hidden = true;
  progressFill.style.width = '0%';
  progress.setAttribute('aria-valuenow', 0);
  btnLabel.textContent = 'Start meting';
  startBtn.classList.remove('stop');
  removeStopLink();
  setStatus('Druk op start en leg je vingertip op de camera.');
  traceCtx.clearRect(0, 0, traceCanvas.width, traceCanvas.height);
}

function restartMeasurement() {
  // Camera blijft aan: direct een nieuwe meetronde
  analyzer = new PpgAnalyzer();
  estimates = [];
  contactAt = null;
  lastValidAt = null;
  lastBeatT = null;
  resultBpm = null;
  bpmEl.textContent = '–';
  bpmEl.classList.remove('measure', 'stale');
  qualityEl.hidden = true;
  progressFill.style.width = '0%';
  progress.setAttribute('aria-valuenow', 0);
  removeStopLink();
  state = 'meeting';
  btnLabel.textContent = 'Stop meting';
  startBtn.classList.add('stop');
  setStatus('Plaats je vingertip op de camera…');
}

startBtn.addEventListener('click', () => {
  if (state === 'idle') begin();
  else if (state === 'klaar') restartMeasurement();
  else if (state !== 'start') resetAll();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && state !== 'idle') resetAll();
});
window.addEventListener('pagehide', () => {
  if (state !== 'idle') resetAll();
});

/* ---------- Service worker (offline gebruik) ---------- */
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    try {
      navigator.serviceWorker.register('sw.js').catch(() => { /* offline starten is een extra, geen eis */ });
    } catch {
      // Sommige afgeschermde contexts (zoals een sandbox-iframe) blokkeren
      // service workers volledig — de app werkt dan gewoon online.
    }
  });
}

// Aksi Dana — Engine verifikasi bukti: SHA-256, dHash, OCR, dan tampilan tahapan AI
'use strict';

// =====================================================================
//  ENGINE VERIFIKASI BUKTI (berjalan di perangkat donatur)
// =====================================================================

// SHA-256 murni JS — cadangan bila Web Crypto tidak tersedia (halaman dibuka lewat http biasa)
function sha256Js(bytes) {
  const K = [], H = [];
  const frac = (x) => ((x - Math.floor(x)) * 4294967296) | 0;
  for (let n = 2, i = 0; i < 64; n++) {
    let prime = true;
    for (let d = 2; d * d <= n; d++) if (n % d === 0) { prime = false; break; }
    if (!prime) continue;
    if (i < 8) H[i] = frac(Math.sqrt(n));
    K[i++] = frac(Math.cbrt(n));
  }
  const len = bytes.length, padLen = ((len + 9 + 63) >> 6) << 6;
  const m = new Uint8Array(padLen); m.set(bytes); m[len] = 0x80;
  const dv = new DataView(m.buffer);
  dv.setUint32(padLen - 8, Math.floor((len * 8) / 4294967296));
  dv.setUint32(padLen - 4, (len * 8) >>> 0);
  const w = new Int32Array(64);
  let h = H.slice();
  for (let o = 0; o < padLen; o += 64) {
    for (let t = 0; t < 16; t++) w[t] = dv.getInt32(o + t * 4);
    for (let t = 16; t < 64; t++) {
      const x = w[t - 15], y = w[t - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (hh + S1 + ((e & f) ^ (~e & g)) + K[t] + w[t]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h = [h[0] + a, h[1] + b, h[2] + c, h[3] + d, h[4] + e, h[5] + f, h[6] + g, h[7] + hh].map((v) => v | 0);
  }
  return h.map((v) => (v >>> 0).toString(16).padStart(8, '0')).join('');
}

// Lapis 1: sidik jari kriptografis berkas
async function sha256Hex(buffer) {
  if (window.crypto && crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return sha256Js(new Uint8Array(buffer));
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Gambar tidak dapat dibaca.')); };
    img.src = url;
  });
}

function drawScaled(img, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return c;
}

// Lapis 2: perceptual dHash — grayscale 9x8, bandingkan piksel bersebelahan -> 64 bit
function dHashHex(img) {
  const px = drawScaled(img, 9, 8).getContext('2d').getImageData(0, 0, 9, 8).data;
  const gray = [];
  for (let i = 0; i < 72; i++) gray.push(0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]);
  let hex = '';
  for (let y = 0; y < 8; y++) {
    let byte = 0;
    for (let x = 0; x < 8; x++) byte = (byte << 1) | (gray[y * 9 + x] > gray[y * 9 + x + 1] ? 1 : 0);
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

function hammingHex(a, b) {
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { dist += x & 1; x >>= 1; }
  }
  return dist;
}
const similarity = (a, b) => 1 - hammingHex(a, b) / 64;

// Lapis 3: OCR
function fitCanvas(img, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  return drawScaled(img, Math.max(1, Math.round(img.naturalWidth * scale)), Math.max(1, Math.round(img.naturalHeight * scale)));
}

async function ocrText(img, onProgress) {
  if (!window.Tesseract) throw new Error('Mesin OCR tidak termuat.');
  const job = Tesseract.recognize(fitCanvas(img, 1600), 'eng', {
    logger: (m) => onProgress(m.status === 'recognizing text' ? `Membaca teks struk… ${Math.round(m.progress * 100)}%` : 'Menyiapkan mesin OCR…'),
  });
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('OCR melewati batas waktu.')), 45000));
  const { data } = await Promise.race([job, timeout]);
  return data.text || '';
}

// Semua angka nominal yang terbaca di struk (50.000 / 50,000.00 / 50000)
function amountsInText(text) {
  const out = new Set();
  const re = /\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?(?!\d)|\d+(?:[.,]\d{2})?(?!\d)/g;
  for (const token of text.match(re) || []) {
    const grouped = /^\d{1,3}(?:[.,]\d{3})+/.test(token);
    const whole = grouped ? token.replace(/[.,]\d{1,2}$/, '') : token.replace(/[.,]\d{2}$/, '');
    const n = Number(whole.replace(/[.,]/g, ''));
    if (Number.isSafeInteger(n) && n > 0) out.add(n);
  }
  return out;
}

// Nomor referensi / ID transaksi pada struk
function referenceInText(text) {
  const re = /(?:NO(?:MOR)?\.?\s*REF(?:ERENSI|ERENCE|F)?\.?|REF(?:ERENSI|ERENCE)?\.?\s*(?:NO|NUMBER|NUM|ID)?\.?|ID\s*TRANSAKSI|TRANSACTION\s*ID|NO(?:MOR)?\.?\s*TRANSAKSI|KODE\s*TRANSAKSI|TRX\s*ID|RRN)\s*[:#.\-]?\s*([A-Z0-9][A-Z0-9\-\/]{5,31})/g;
  for (const m of text.toUpperCase().matchAll(re)) {
    const ref = m[1].replace(/[^A-Z0-9]/g, '');
    if (ref.length >= 6 && (ref.match(/\d/g) || []).length >= 4) return ref.slice(0, 32);
  }
  return null;
}

// ---------- Visualisasi tahapan AI (SweetAlert2) ----------
const SCAN_STEPS = [
  ['sha', 'Lapis 1 · Sidik jari berkas (SHA-256)'],
  ['dhash', 'Lapis 2 · Kemiripan visual (dHash)'],
  ['ocr', 'Lapis 3 · Teks struk & nomor referensi (OCR)'],
  ['final', 'Pengesahan & siaran ke semua layar'],
];
function scanOpen() {
  Swal.fire({
    title: 'Verifikasi AI bukti transfer',
    html: '<ul class="scan" aria-live="polite">' + SCAN_STEPS.map(([k, label]) =>
      `<li id="scan-${k}" data-s="wait"><span class="ic" aria-hidden="true"></span><div><b>${label}</b><small>Menunggu…</small></div></li>`).join('') + '</ul>',
    allowOutsideClick: false, allowEscapeKey: false, showConfirmButton: false,
  });
}
function scanSet(key, status, detail) {
  const li = $('scan-' + key);
  if (!li) return;
  li.dataset.s = status;
  li.querySelector('small').textContent = detail || '';
}

// Aksi Dana — Konstanta, utilitas umum, dan enkripsi jalur cadangan
'use strict';

// ---------- Konstanta ----------
const MIN_NOMINAL = 1000;            // CR-001
const MAX_NOMINAL = 100_000_000_000;
const MAX_FILE = 5 * 1024 * 1024;
const DHASH_THRESHOLD = 0.9;         // kemiripan visual >= 90% dianggap duplikat
const FEED_LIMIT = 50;
const STORE_KEY = 'aksidana.host';
const PEER_PREFIX = 'aksidana-';
const RELAY_URL = 'wss://broker.emqx.io:8084/mqtt'; // jalur cadangan bila WebRTC diblokir jaringan

// ---------- Utilitas ----------
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rp = (n) => 'Rp ' + Math.round(n).toLocaleString('id-ID');
const clip = (v, max) => String(v ?? '').trim().slice(0, max);
const jam = (ts) => new Date(ts).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function uid(len = 10) {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => (b % 36).toString(36)).join('');
}

// Validasi nominal (CR-001 / ISS-01): tolak kosong, nol, negatif, bukan angka, < Rp 1.000
function parseNominal(raw) {
  const s = String(raw ?? '').trim().replace(/^rp\.?\s*/i, '');
  if (!s) return { error: 'Nominal wajib diisi.' };
  if (s.includes('-')) return { error: 'Nominal tidak boleh negatif.' };
  if (!/^\d[\d.\s]*$/.test(s)) return { error: 'Nominal harus berupa angka bulat, contoh 50.000.' };
  const n = Number(s.replace(/[.\s]/g, ''));
  if (!Number.isSafeInteger(n)) return { error: 'Nominal tidak valid.' };
  if (n === 0) return { error: 'Nominal tidak boleh nol.' };
  if (n < MIN_NOMINAL) return { error: 'Nominal minimal ' + rp(MIN_NOMINAL) + '.' };
  if (n > MAX_NOMINAL) return { error: 'Nominal terlalu besar.' };
  return { value: n };
}

// Pemisah ribuan otomatis, hanya bila isinya memang angka (agar input salah tetap terlihat & divalidasi)
function bindNominal(input) {
  input.addEventListener('input', () => {
    if (!/^[\d.]*$/.test(input.value)) return;
    const d = input.value.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
    input.value = d ? Number(d).toLocaleString('id-ID') : '';
  });
}

function fieldError(id, msg) {
  const input = $(id), err = $(id + 'Err');
  if (err) { err.textContent = msg || ''; err.hidden = !msg; }
  if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
  return !msg;
}

async function copyText(text, btn) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const t = document.createElement('textarea');
    t.value = text; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.append(t); t.select(); document.execCommand('copy'); t.remove();
  }
  const label = btn && btn.querySelector('span');
  if (label) { const old = label.textContent; label.textContent = 'Tersalin'; setTimeout(() => (label.textContent = old), 1500); }
}

const toast = (icon, title) => window.Swal
  ? Swal.fire({ toast: true, position: 'top', icon, title, timer: 2600, showConfirmButton: false })
  : alert(title);

// Parameter link: konfigurasi acara di-encode Base64 (URL-safe)
const encodeCfg = (cfg) => btoa(unescape(encodeURIComponent(JSON.stringify(cfg)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function decodeCfg(s) {
  try {
    const c = JSON.parse(decodeURIComponent(escape(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')))));
    return cleanCfg(c);
  } catch { return null; }
}
function cleanCfg(c) {
  if (!c || typeof c !== 'object') return null;
  const target = Number(c.target);
  if (!Number.isSafeInteger(target) || target < MIN_NOMINAL) return null;
  return { organizer: clip(c.organizer, 60), event: clip(c.event, 90), target, bank: clip(c.bank, 30), accNo: clip(c.accNo, 24), accName: clip(c.accName, 60) };
}

// ---------- Enkripsi jalur cadangan (broker publik hanya melihat data acak) ----------
// Kunci publik panitia ada di link. Tiap donatur membuat kunci sementara, lalu kedua pihak
// menurunkan kunci AES-GCM yang sama (ECDH). Hanya pemegang kunci privat panitia yang bisa
// membalas, sehingga pihak lain tidak dapat membaca maupun memalsukan siaran.
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const hasCrypto = () => !!(window.crypto && crypto.subtle);
function b64u(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const unb64u = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
async function deriveAes(privateKey, peerPublicRaw) {
  const pub = await crypto.subtle.importKey('raw', peerPublicRaw, ECDH, false, []);
  return crypto.subtle.deriveKey({ name: 'ECDH', public: pub }, privateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function seal(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  return { iv: b64u(iv), ct: b64u(ct) };
}
async function unseal(key, env) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(env.iv) }, key, unb64u(env.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

// Aksi Dana — Mode panitia: data sesi, keputusan verifikasi, siaran, panel kontrol
'use strict';

// =====================================================================
//  MODE HOST (PANITIA)
// =====================================================================
let state = null;       // { room, cfg, donations[], audit[] }
let bc = null;
let peer = null;
const conns = new Set();
const handled = new Set();

const baseUrl = () => location.href.split(/[?#]/)[0];
const linkFor = (s) => `${baseUrl()}?room=${s.room}&d=${encodeCfg(s.cfg)}${s.key ? '&k=' + s.key.pub : ''}`;
const shareUrl = () => linkFor(state);

function saveState() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch {
    // Penyimpanan penuh: simpan tanpa pratinjau bukti
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ ...state, audit: state.audit.map((a) => ({ ...a, thumb: null })) })); } catch {}
  }
}
function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    return s && s.room && cleanCfg(s.cfg) && Array.isArray(s.donations) && Array.isArray(s.audit) ? s : null;
  } catch { return null; }
}

function publicState() {
  return {
    room: state.room,
    cfg: state.cfg,
    total: state.donations.reduce((sum, d) => sum + d.amount, 0),
    count: state.donations.length,
    donations: state.donations.slice(-FEED_LIMIT).reverse(),
    closed: false,
  };
}

function sendAll(msg) {
  if (bc) bc.postMessage({ dir: 'h2c', ...msg });
  for (const c of conns) if (c.open) c.send(msg);
  for (const [cid, s] of relaySessions) {
    if (Date.now() - s.seen > RELAY_TTL) relaySessions.delete(cid);
    else relaySend(cid, s, msg);
  }
}

function publish() {
  saveState();
  const pub = publicState();
  render(pub);
  renderAudit();
  sendAll({ t: 'state', pub });
}

function hostBadge() {
  if (!state) return;
  const peerUp = peer && !peer.destroyed && peer.open;
  const relayUp = relay && relay.connected;
  if (!peerUp && !relayUp) return setBadge('Menyambungkan siaran… (tab browser ini tetap sinkron)', 'wait');
  let viewers = conns.size;
  for (const s of relaySessions.values()) if (Date.now() - s.seen <= RELAY_TTL) viewers++;
  setBadge(`Siaran aktif · ${viewers} perangkat terhubung`, 'live');
}

// ---------- Jalur cadangan host: broker WebSocket (MQTT), pesan terenkripsi ----------
const RELAY_TTL = 80000;            // donatur dianggap pergi bila tidak menyapa selama ini
const relaySessions = new Map();    // cid -> { epk, key, seen }
let relay = null;
let relayRoom = '';
let relaySeq = 0;

async function relaySend(cid, s, msg) {
  if (!relay || !relay.connected) return;
  relaySeq = Math.max(relaySeq + 1, Date.now());
  const topic = `aksidana/${relayRoom}/c/${cid}`;
  try { relay.publish(topic, JSON.stringify(await seal(s.key, { ...msg, n: relaySeq }))); } catch {}
}

async function startRelayHost() {
  if (!hasCrypto() || !window.mqtt || relay) return;
  // Kunci panitia dibuat sekali per acara dan disimpan bersama sesi
  if (!state.key) {
    const pair = await crypto.subtle.generateKey(ECDH, true, ['deriveKey']);
    state.key = {
      jwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
      pub: b64u(await crypto.subtle.exportKey('raw', pair.publicKey)),
    };
    saveState();
  }
  renderShare();
  const privateKey = await crypto.subtle.importKey('jwk', state.key.jwk, ECDH, false, ['deriveKey']);
  relayRoom = state.room;
  relay = mqtt.connect(RELAY_URL, { clientId: 'ad-h-' + uid(10), reconnectPeriod: 4000, keepalive: 30 });
  relay.on('connect', () => { relay.subscribe(`aksidana/${relayRoom}/h`); hostBadge(); });
  relay.on('close', hostBadge);
  relay.on('error', () => {});
  relay.on('message', async (_topic, payload) => {
    try {
      const env = JSON.parse(payload.toString());
      const cid = String(env.cid || '').replace(/[^a-z0-9]/g, '').slice(0, 16);
      if (!cid || typeof env.epk !== 'string' || env.epk.length > 100) return;
      let s = relaySessions.get(cid);
      const known = s && s.epk === env.epk;
      if (!known) s = { epk: env.epk, key: await deriveAes(privateKey, unb64u(env.epk)), seen: 0 };
      const msg = await unseal(s.key, env);         // gagal dekripsi -> pesan diabaikan
      if (!known) { if (relaySessions.size >= 500) return; relaySessions.set(cid, s); }
      s.seen = Date.now();
      const reply = handle(msg);
      if (reply) relaySend(cid, s, reply);
      hostBadge();
    } catch {}
  });
  setInterval(hostBadge, 30000);
}

function renderShare() {
  const link = shareUrl();
  $('shareLink').value = link;
  $('qr').innerHTML = '';
  try { new QRCode($('qr'), { text: link, width: 184, height: 184, correctLevel: QRCode.CorrectLevel.L }); }
  catch { $('qr').textContent = 'Kode QR tidak tersedia (butuh internet).'; }
}

function startPeer(attempt = 0) {
  if (!window.Peer) return setBadge('Tanpa internet: hanya sinkron antar-tab', 'off');
  peer = new Peer(PEER_PREFIX + state.room);
  const mine = peer;
  peer.on('open', hostBadge);
  peer.on('connection', (conn) => {
    conn.on('open', () => { conns.add(conn); conn.send({ t: 'state', pub: publicState() }); hostBadge(); });
    conn.on('data', (msg) => { const reply = handle(msg); if (reply && conn.open) conn.send(reply); });
    const drop = () => { conns.delete(conn); hostBadge(); };
    conn.on('close', drop);
    conn.on('error', drop);
  });
  peer.on('disconnected', () => { hostBadge(); setTimeout(() => { if (state && peer === mine && !mine.destroyed) mine.reconnect(); }, 2000); });
  peer.on('error', (err) => {
    hostBadge();
    // ID masih dipegang sesi sebelumnya (mis. setelah muat ulang) atau jaringan putus: coba lagi
    if (['unavailable-id', 'network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type) && attempt < 20) {
      setTimeout(() => { if (state && peer === mine) { mine.destroy(); startPeer(attempt + 1); } }, 3000);
    }
  });
}

function logAudit(entry) {
  state.audit.push({ id: uid(), ts: Date.now(), donationId: null, sha: null, dhash: null, ref: null, thumb: null, ...entry });
}

function addDonation({ name, amount, message, source }, audit) {
  const id = uid();
  const ts = Date.now();
  state.donations.push({ id, name, amount, message, ts, source });
  logAudit({ ...audit, ts, donationId: id, name, amount });
  publish();
}

// Bukti yang pernah diterima (termasuk yang kemudian dibatalkan panitia) tetap diblokir
const registry = () => state.audit.filter((a) => a.donationId && a.sha);

function mostSimilar(dhash) {
  let best = null;
  for (const a of registry()) {
    if (!a.dhash) continue;
    const sim = similarity(a.dhash, dhash);
    if (sim >= DHASH_THRESHOLD && (!best || sim > best.sim)) best = { sim, entry: a };
  }
  return best;
}

// Menangani pesan dari donatur (lewat BroadcastChannel maupun PeerJS)
function handle(msg) {
  if (!state || !msg || typeof msg !== 'object') return null;
  if (msg.t === 'hello') return { t: 'state', pub: publicState() };
  if (msg.t !== 'precheck' && msg.t !== 'donate') return null;

  const reqId = clip(msg.reqId, 24);
  if (!reqId || handled.has(reqId)) return null;   // permintaan sama dari dua kanal: proses sekali
  handled.add(reqId);
  const verdict = (v) => ({ t: 'verdict', reqId, ...v });

  const d = msg.d || {};
  const sha = /^[0-9a-f]{64}$/.test(d.sha) ? d.sha : null;
  const dhash = /^[0-9a-f]{16}$/.test(d.dhash) ? d.dhash : null;
  const name = clip(d.name, 60) || 'Hamba Allah';
  const amount = Number(d.amount);
  const base = { name, amount: Number.isSafeInteger(amount) ? amount : 0, sha, dhash };
  if (!sha || !dhash) return verdict({ ok: false, layer: 0, reason: 'Data verifikasi tidak lengkap.' });

  const reject = (layer, reason, extra = {}) => {
    logAudit({ ...base, ...extra, status: 'rejected', layer, note: reason });
    publish();
    return verdict({ ok: false, layer, reason });
  };

  // Lapis 1 — berkas identik
  if (registry().some((a) => a.sha === sha))
    return reject(1, 'Berkas bukti identik 100% dengan bukti transfer yang sudah tercatat.');

  // Lapis 2 — kemiripan visual
  const sim = mostSimilar(dhash);
  const simPct = sim ? Math.round(sim.sim * 100) : 0;

  if (msg.t === 'precheck') {
    if (sim && !sim.entry.ref)
      return reject(2, `Gambar ${simPct}% mirip dengan bukti transfer yang sudah tercatat.`);
    return verdict({ ok: true, similar: sim ? simPct : 0 });
  }

  // ---- t === 'donate' ----
  const ref = d.ref ? clip(d.ref, 32).toUpperCase().replace(/[^A-Z0-9]/g, '') : null;
  const thumb = typeof d.thumb === 'string' && d.thumb.startsWith('data:image/jpeg;base64,') && d.thumb.length < 80000 ? d.thumb : null;
  const extra = { ref, thumb };

  if (!Number.isSafeInteger(amount) || amount < MIN_NOMINAL || amount > MAX_NOMINAL)
    return reject(0, 'Nominal tidak valid (minimal ' + rp(MIN_NOMINAL) + ').', extra);

  let note = '';
  if (sim) {
    // Struk dari aplikasi bank yang sama bisa tampak mirip: hanya lolos bila nomor referensinya terbaca dan berbeda
    if (!ref || !sim.entry.ref || ref === sim.entry.ref)
      return reject(2, `Gambar ${simPct}% mirip dengan bukti transfer yang sudah tercatat.`, extra);
    note = `Mirip visual ${simPct}% dengan struk lain, tetapi nomor referensi berbeda. `;
  }

  // Lapis 3 — nomor referensi sudah pernah dipakai
  if (ref && registry().some((a) => a.ref === ref))
    return reject(3, `Nomor referensi ${ref} sudah pernah tercatat.`, extra);

  // Lapis 3 — nominal di formulir tidak ada pada struk
  if (d.ocr === 'mismatch')
    return reject(3, `Nominal ${rp(amount)} di formulir tidak cocok dengan nominal pada struk.`, extra);

  // Lapis 3 — struk tidak dapat dibaca sama sekali, jadi nominal tidak bisa dipastikan
  if (d.ocr !== 'match')
    return reject(3, 'Teks struk tidak dapat dibaca, sehingga nominal tidak bisa diperiksa.', extra);

  let status = 'valid';
  note += 'Nominal cocok dengan struk.';
  if (sim) status = 'review';
  if (!ref) note += ' No. referensi tidak terbaca.';

  addDonation({ name, amount, message: clip(d.message, 200), source: 'publik' }, { ...base, ...extra, status, layer: 0, note: note.trim() });
  return verdict({ ok: true, status, note: note.trim() });
}

// ---------- Log audit ----------
const STATUS = {
  valid: ['Valid', 'bg-emerald-100 text-emerald-900'],
  review: ['Perlu tinjauan', 'bg-amber-100 text-amber-900'],
  rejected: ['Ditolak', 'bg-red-100 text-red-900'],
  manual: ['Manual panitia', 'bg-slate-200 text-slate-800'],
  void: ['Dibatalkan', 'bg-slate-200 text-slate-800'],
};

function renderAudit() {
  const rows = state.audit.slice().reverse();
  $('auditEmpty').hidden = rows.length > 0;
  $('auditRows').innerHTML = rows.map((a) => {
    const [label, tone] = STATUS[a.status] || STATUS.manual;
    const layer = a.status === 'rejected' && a.layer ? ` · Lapis ${a.layer}` : '';
    const active = a.donationId && state.donations.some((d) => d.id === a.donationId);
    const hash = a.sha
      ? `<span class="block" title="${esc(a.sha)}">SHA ${esc(a.sha.slice(0, 12))}…</span>
         <span class="block">dHash ${esc(a.dhash || '-')}</span>
         <span class="block">Ref ${esc(a.ref || '—')}</span>`
      : '<span class="text-slate-600">—</span>';
    return `<tr class="border-b border-slate-200 align-top">
      <td class="py-2.5 pr-3 tabular-nums text-slate-700">${jam(a.ts)}</td>
      <td class="max-w-[10rem] break-words py-2.5 pr-3 font-semibold">${esc(a.name)}</td>
      <td class="whitespace-nowrap py-2.5 pr-3 font-bold tabular-nums">${a.amount ? rp(a.amount) : '—'}</td>
      <td class="py-2.5 pr-3"><span class="badge ${tone}">${label}${layer}</span>
        <span class="mt-1 block max-w-[16rem] text-xs text-slate-700">${esc(a.note || '')}</span></td>
      <td class="py-2.5 pr-3 font-mono text-xs text-slate-800">${hash}</td>
      <td class="py-2.5 pr-3">${a.thumb ? `<button type="button" class="btn btn-outline btn-sm" data-proof="${a.id}">Lihat</button>` : '<span class="text-slate-600">—</span>'}</td>
      <td class="py-2.5">${active ? `<button type="button" class="btn btn-danger btn-sm" data-void="${a.id}">Batalkan</button>` : ''}</td>
    </tr>`;
  }).join('');
}

function csvDownload() {
  const cell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;     // cegah formula injection di spreadsheet
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const lines = [['Waktu', 'Donatur', 'Nominal', 'Pesan', 'Sumber'].map(cell).join(',')];
  for (const d of state.donations)
    lines.push([new Date(d.ts).toLocaleString('id-ID'), d.name, d.amount, d.message, d.source].map(cell).join(','));
  lines.push(['', 'TOTAL', publicState().total, '', ''].map(cell).join(','));
  const url = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `rekap-donasi-${state.room}.csv` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function startHost(initial) {
  state = initial;
  $('setup').hidden = true;
  $('app').hidden = false;
  $('shareCard').hidden = false;
  $('hostPanel').hidden = false;
  $('liveText').textContent = 'Donasi live · mode panitia';

  renderShare();

  bc = new BroadcastChannel(PEER_PREFIX + state.room);
  bc.onmessage = (e) => {
    const msg = e.data || {};
    if (msg.dir === 'probe') return bc.postMessage({ dir: 'probe-ack' });
    if (msg.dir !== 'c2h') return;
    const reply = handle(msg);
    if (reply) bc.postMessage({ dir: 'h2c', ...reply });
  };
  addEventListener('pagehide', () => bc && bc.postMessage({ dir: 'h2c', t: 'bye' }));

  hostBadge();
  startPeer();
  publish();
  startRelayHost().catch(() => {});
}

async function closeSession() {
  const pub = publicState();
  const res = await Swal.fire({
    icon: 'warning',
    title: 'Tutup sesi acara?',
    html: `Total akhir <b>${rp(pub.total)}</b> dari <b>${pub.count}</b> donasi.<br>Siaran dihentikan dan seluruh data sesi dihapus dari browser ini. Tindakan ini tidak dapat dibatalkan.`,
    showCancelButton: true, confirmButtonText: 'Ya, tutup & hapus', cancelButtonText: 'Batal',
    confirmButtonColor: '#b91c1c', focusCancel: true,
  });
  if (!res.isConfirmed) return;
  sendAll({ t: 'closed', pub: { ...pub, closed: true } });
  localStorage.removeItem(STORE_KEY);
  state = null;
  setTimeout(() => { try { peer && peer.destroy(); relay && relay.end(true); } catch {} location.href = baseUrl(); }, 900);
}

function initHostUi() {
  bindNominal($('fTarget'));
  bindNominal($('mAmount'));

  $('setupForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = (id) => $(id).value.trim();
    const target = parseNominal(v('fTarget'));
    const accNo = v('fAccNo').replace(/[\s-]/g, '');
    const ok = [
      fieldError('fOrganizer', v('fOrganizer') ? '' : 'Nama pengelola wajib diisi.'),
      fieldError('fEvent', v('fEvent') ? '' : 'Nama acara wajib diisi.'),
      fieldError('fTarget', target.error ? target.error.replace('Nominal', 'Target dana') : ''),
      fieldError('fBank', v('fBank') ? '' : 'Nama bank wajib diisi.'),
      fieldError('fAccNo', /^\d{5,20}$/.test(accNo) ? '' : 'Nomor rekening harus 5–20 digit angka.'),
      fieldError('fAccName', v('fAccName') ? '' : 'Nama pemilik rekening wajib diisi.'),
    ].every(Boolean);
    if (!ok) { const bad = document.querySelector('#setupForm [aria-invalid="true"]'); if (bad) bad.focus(); return; }
    startHost({
      room: uid(8),
      cfg: cleanCfg({ organizer: v('fOrganizer'), event: v('fEvent'), target: target.value, bank: v('fBank'), accNo, accName: v('fAccName') }),
      createdAt: Date.now(), donations: [], audit: [],
    });
    scrollTo({ top: 0 });
  });

  $('copyLink').onclick = (e) => copyText($('shareLink').value, e.currentTarget);
  $('csvBtn').onclick = csvDownload;
  $('closeBtn').onclick = closeSession;

  $('manualForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const amount = parseNominal($('mAmount').value);
    if (!fieldError('mAmount', amount.error)) return $('mAmount').focus();
    addDonation(
      { name: clip($('mName').value, 60) || 'Hamba Allah', amount: amount.value, message: clip($('mMessage').value, 200), source: 'manual' },
      { status: 'manual', layer: 0, note: 'Dicatat langsung oleh panitia.' });
    e.target.reset();
    toast('success', 'Donasi dicatat dan disiarkan');
  });

  $('auditRows').addEventListener('click', async (e) => {
    const proofBtn = e.target.closest('[data-proof]');
    const voidBtn = e.target.closest('[data-void]');
    if (proofBtn) {
      const a = state.audit.find((x) => x.id === proofBtn.dataset.proof);
      if (a && a.thumb) Swal.fire({ title: 'Pratinjau bukti', text: `${a.name} · ${rp(a.amount)}`, imageUrl: a.thumb, imageAlt: 'Pratinjau bukti transfer', confirmButtonText: 'Tutup', confirmButtonColor: '#047857' });
    }
    if (voidBtn) {
      const a = state.audit.find((x) => x.id === voidBtn.dataset.void);
      if (!a) return;
      const res = await Swal.fire({
        icon: 'question', title: 'Batalkan donasi ini?', text: `${a.name} · ${rp(a.amount)} akan dikeluarkan dari total. Buktinya tetap diblokir agar tidak bisa dipakai ulang.`,
        showCancelButton: true, confirmButtonText: 'Ya, batalkan', cancelButtonText: 'Tidak', confirmButtonColor: '#b91c1c',
      });
      if (!res.isConfirmed) return;
      state.donations = state.donations.filter((d) => d.id !== a.donationId);
      a.status = 'void';
      a.note = 'Dibatalkan panitia. ' + (a.note || '');
      publish();
    }
  });
}

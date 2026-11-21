// Aksi Dana — Mode donatur: sambungan ke panitia dan formulir donasi
'use strict';

// =====================================================================
//  MODE DONATUR (CLIENT)
// =====================================================================
const client = {
  room: null, bc: null, bcAlive: false, peer: null, conn: null, retry: 0, closed: false, pending: new Map(),
  hostPub: null, relay: null, relayStarted: false, rkey: null, epk: '', cid: '', lastN: 0, relaySeen: 0,
};
const relayLive = () => Date.now() - client.relaySeen < 70000;
const directLive = () => client.bcAlive || !!(client.conn && client.conn.open);

// ---------- Jalur cadangan donatur: dipakai bila sambungan langsung tidak berhasil ----------
async function relayPost(msg) {
  const r = client.relay;
  if (!r || !r.connected || !client.rkey) return;
  try {
    const env = await seal(client.rkey, msg);
    r.publish(`aksidana/${client.room}/h`, JSON.stringify({ cid: client.cid, epk: client.epk, ...env }));
  } catch {}
}

async function startRelayClient() {
  if (client.relayStarted || client.closed || !client.hostPub || !hasCrypto() || !window.mqtt) return;
  client.relayStarted = true;
  try {
    const pair = await crypto.subtle.generateKey(ECDH, true, ['deriveKey']);
    client.rkey = await deriveAes(pair.privateKey, unb64u(client.hostPub));
    client.epk = b64u(await crypto.subtle.exportKey('raw', pair.publicKey));
    client.cid = uid(12);
  } catch { return; }
  const r = mqtt.connect(RELAY_URL, { clientId: 'ad-c-' + client.cid, reconnectPeriod: 4000, keepalive: 30 });
  client.relay = r;
  r.on('connect', () => r.subscribe(`aksidana/${client.room}/c/${client.cid}`, () => relayPost({ t: 'hello' })));
  r.on('error', () => {});
  r.on('message', async (_topic, payload) => {
    try {
      const msg = await unseal(client.rkey, JSON.parse(payload.toString()));
      client.relaySeen = Date.now();
      if (msg.t === 'state' || msg.t === 'closed') {
        if (!(msg.n > client.lastN)) return;   // abaikan siaran lama yang diputar ulang
        client.lastN = msg.n;
      }
      onHostMsg(msg);
      clientBadge();
    } catch {}
  });
  setInterval(() => { if (!client.closed) relayPost({ t: 'hello' }); clientBadge(); }, 25000);
}

function clientBadge() {
  if (client.closed) return setBadge('Sesi ditutup', 'off');
  const live = directLive() || relayLive();
  setBadge(live ? 'Terhubung live' : 'Menyambungkan ke panitia…', live ? 'live' : 'wait');
}

function onHostMsg(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'state' || msg.t === 'closed') {
    const pub = msg.pub;
    if (!pub || !cleanCfg(pub.cfg) || !Array.isArray(pub.donations)) return;
    if (msg.t === 'closed') client.closed = true;
    $('app').hidden = false;
    if (!client.closed) $('donorCard').hidden = false;
    render(pub);
    clientBadge();
  } else if (msg.t === 'verdict') {
    const done = client.pending.get(msg.reqId);
    if (done) { client.pending.delete(msg.reqId); done(msg); }
  }
}

// Kirim permintaan ke host lewat semua kanal yang tersedia; host memprosesnya sekali
function request(msg) {
  return new Promise((resolve, reject) => {
    const full = { ...msg, reqId: uid(12) };
    let sent = false;
    if (client.bcAlive) { client.bc.postMessage({ dir: 'c2h', ...full }); sent = true; }
    if (client.conn && client.conn.open) { client.conn.send(full); sent = true; }
    if (relayLive()) { relayPost(full); sent = true; }
    if (!sent) return reject(new Error('Belum terhubung ke panitia. Pastikan halaman panitia masih terbuka, lalu coba lagi.'));
    client.pending.set(full.reqId, resolve);
    setTimeout(() => {
      if (client.pending.delete(full.reqId)) reject(new Error('Panitia tidak merespons. Coba lagi sebentar lagi.'));
    }, 15000);
  });
}

function dial() {
  clearTimeout(client.retry);
  if (client.closed || !client.peer || client.peer.destroyed) return;
  if (client.peer.disconnected) { try { client.peer.reconnect(); } catch {} return redial(); }
  if (client.conn && client.conn.open) return;
  const conn = client.peer.connect(PEER_PREFIX + client.room, { reliable: true, serialization: 'json' });
  client.conn = conn;
  conn.on('open', () => { conn.send({ t: 'hello' }); clientBadge(); });
  conn.on('data', onHostMsg);
  const lost = () => { if (client.conn === conn) client.conn = null; clientBadge(); redial(); };
  conn.on('close', lost);
  conn.on('error', lost);
}
function redial() {
  clearTimeout(client.retry);
  if (!client.closed) client.retry = setTimeout(dial, 3500);
}

function startClient(room, cfgFromLink, hostPub) {
  client.room = room;
  client.hostPub = /^[A-Za-z0-9_-]{80,90}$/.test(hostPub || '') ? hostPub : null;
  // Bila sambungan langsung belum berhasil dalam 5 detik (atau putus), pakai jalur cadangan
  setInterval(() => { if (!client.closed && !directLive()) startRelayClient(); }, 5000);
  $('setup').hidden = true;
  $('app').hidden = false;

  // Tampilkan detail acara dari link sambil menunggu data live
  if (cfgFromLink) {
    $('donorCard').hidden = false;
    render({ room, cfg: cfgFromLink, total: 0, count: 0, donations: [], closed: false });
    view.known = null; // data pertama dari panitia bukan "donasi baru"
  }
  const saved = loadState();
  if (saved && saved.room === room) { $('hostHint').hidden = false; $('hostHintLink').href = baseUrl(); }
  clientBadge();

  // Kanal 1: tab lain di browser yang sama
  client.bc = new BroadcastChannel(PEER_PREFIX + room);
  client.bc.onmessage = (e) => {
    const msg = e.data || {};
    if (msg.dir !== 'h2c') return;
    if (msg.t === 'bye') { client.bcAlive = false; return clientBadge(); }
    client.bcAlive = true;
    onHostMsg(msg);
  };
  client.bc.postMessage({ dir: 'c2h', t: 'hello' });

  // Kanal 2: lintas perangkat lewat WebRTC
  if (window.Peer) {
    client.peer = new Peer();
    client.peer.on('open', dial);
    client.peer.on('disconnected', redial);
    client.peer.on('error', () => { clientBadge(); redial(); }); // mis. panitia belum online
  }
  initDonorUi();
}

async function makeThumb(img) {
  return fitCanvas(img, 240).toDataURL('image/jpeg', 0.6);
}

async function submitDonation() {
  const anon = $('dAnon').checked;
  const name = $('dName').value.trim();
  const amount = parseNominal($('dAmount').value);
  const file = $('dProof').files[0];
  let fileErr = '';
  if (!file) fileErr = 'Bukti transfer wajib diunggah.';
  else if (!['image/jpeg', 'image/png'].includes(file.type)) fileErr = 'Bukti harus berupa gambar JPG atau PNG.';
  else if (file.size > MAX_FILE) fileErr = 'Ukuran bukti maksimal 5 MB.';
  const ok = [
    fieldError('dName', anon || name ? '' : 'Isi nama, atau centang “Hamba Allah”.'),
    fieldError('dAmount', amount.error),
    fieldError('dProof', fileErr),
  ].every(Boolean);
  if (!ok) { const bad = document.querySelector('#donateForm [aria-invalid="true"]'); if (bad) bad.focus(); return; }
  if (!window.Swal) return alert('Komponen tampilan gagal dimuat. Periksa koneksi internet lalu muat ulang halaman.');

  const btn = $('dSubmit');
  btn.disabled = true;
  const started = performance.now();
  const d = { name: anon ? 'Hamba Allah' : name, amount: amount.value, message: $('dMessage').value.trim() };
  let failedStep = 'sha';
  try {
    scanOpen();

    // Lapis 1
    scanSet('sha', 'run', 'Menghitung sidik jari kriptografis…');
    d.sha = await sha256Hex(await file.arrayBuffer());

    // Lapis 2
    failedStep = 'dhash';
    scanSet('dhash', 'run', 'Menghitung sidik jari visual 9×8…');
    const img = await loadImage(file);
    d.dhash = dHashHex(img);

    const pre = await request({ t: 'precheck', d: { name: d.name, amount: d.amount, sha: d.sha, dhash: d.dhash } });
    if (!pre.ok) {
      const step = pre.layer === 1 ? 'sha' : 'dhash';
      if (step === 'dhash') scanSet('sha', 'ok', 'Berkas belum pernah diunggah.');
      else scanSet('dhash', 'wait', 'Dilewati.');
      scanSet(step, 'fail', pre.reason);
      return rejected(pre);
    }
    scanSet('sha', 'ok', `Unik · ${d.sha.slice(0, 16)}…`);
    if (pre.similar) scanSet('dhash', 'warn', `Mirip ${pre.similar}% dengan struk lain — dipastikan lewat nomor referensi.`);
    else scanSet('dhash', 'ok', `Tidak ada gambar serupa · ${d.dhash}`);

    // Lapis 3
    failedStep = 'ocr';
    scanSet('ocr', 'run', 'Menyiapkan mesin OCR…');
    try {
      const text = await ocrText(img, (label) => scanSet('ocr', 'run', label));
      d.ref = referenceInText(text);
      d.ocr = amountsInText(text).has(d.amount) ? 'match' : 'mismatch';
      scanSet('ocr', d.ocr === 'match' ? 'ok' : 'fail',
        (d.ocr === 'match' ? `Nominal ${rp(d.amount)} cocok.` : `Nominal ${rp(d.amount)} tidak ditemukan pada struk.`) +
        (d.ref ? ` Ref ${d.ref}.` : ' No. referensi tidak terbaca.'));
    } catch (ocrErr) {
      d.ref = null; d.ocr = 'unavailable';
      scanSet('ocr', 'fail', 'Teks struk tidak dapat dibaca.');
    }

    // Pengesahan
    failedStep = 'final';
    scanSet('final', 'run', 'Mengirim ke panitia…');
    d.thumb = await makeThumb(img);
    const res = await request({ t: 'donate', d });
    if (!res.ok) {
      scanSet(res.layer === 2 ? 'dhash' : res.layer === 3 ? 'ocr' : 'final', 'fail', res.reason);
      if (res.layer) scanSet('final', 'fail', 'Donasi tidak disahkan.');
      return rejected(res);
    }
    scanSet('final', 'ok', 'Disahkan dan disiarkan.');
    const secs = ((performance.now() - started) / 1000).toLocaleString('id-ID', { maximumFractionDigits: 1 });
    await new Promise((r) => setTimeout(r, 700));
    $('donateForm').reset();
    $('dName').disabled = false;
    $('dPreview').hidden = true;
    Swal.fire({
      icon: 'success',
      title: 'Donasi disahkan',
      text: `Terima kasih, ${d.name}. Donasi ${rp(d.amount)} sudah tampil di semua layar (verifikasi ${secs} detik).` +
        (res.status === 'review' ? ' Catatan: struk Anda ditandai untuk ditinjau panitia.' : ''),
      confirmButtonText: 'Selesai', confirmButtonColor: '#047857',
    });
  } catch (err) {
    scanSet(failedStep, 'fail', err.message);
    await new Promise((r) => setTimeout(r, 500));
    Swal.fire({ icon: 'error', title: 'Verifikasi tidak selesai', text: err.message, confirmButtonText: 'Tutup', confirmButtonColor: '#047857' });
  } finally {
    btn.disabled = false;
  }
}

async function rejected(v) {
  await new Promise((r) => setTimeout(r, 1200));
  return Swal.fire({
    icon: 'error',
    title: v.layer ? `Bukti ditolak · Lapis ${v.layer}` : 'Donasi ditolak',
    text: v.reason + (v.layer ? ' Unggah bukti transfer asli dari transaksi Anda sendiri, atau hubungi panitia.' : ''),
    confirmButtonText: 'Tutup', confirmButtonColor: '#047857',
  });
}

function initDonorUi() {
  bindNominal($('dAmount'));
  $('copyAcc').onclick = (e) => copyText($('accNo').textContent, e.currentTarget);
  $('dAnon').onchange = (e) => { $('dName').disabled = e.target.checked; if (e.target.checked) fieldError('dName', ''); };
  $('dProof').onchange = (e) => {
    const file = e.target.files[0];
    const img = $('dPreview');
    if (img.src) URL.revokeObjectURL(img.src);
    img.hidden = !file;
    if (file) img.src = URL.createObjectURL(file);
    fieldError('dProof', '');
  };
  $('donateForm').addEventListener('submit', (e) => { e.preventDefault(); submitDonation(); });
}

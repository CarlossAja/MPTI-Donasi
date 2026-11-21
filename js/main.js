// Aksi Dana — Titik mulai: menentukan mode panitia atau donatur
'use strict';

// =====================================================================
//  START
// =====================================================================
(async function init() {
  if (window.lucide) lucide.createIcons();
  $('homeLink').href = baseUrl();
  const params = new URLSearchParams(location.search);
  const room = (params.get('room') || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16);

  // Dibuka dari shareable link -> mode donatur
  if (room) return startClient(room, decodeCfg(params.get('d')), params.get('k'));

  initHostUi();
  const saved = loadState();
  if (!saved) { $('setup').hidden = false; return; }

  // Sesi panitia tersimpan: bila tab panitia lain masih hidup, tab ini cukup menjadi layar penonton
  const probe = new BroadcastChannel(PEER_PREFIX + saved.room);
  const alive = await new Promise((resolve) => {
    probe.onmessage = (e) => { if (e.data && e.data.dir === 'probe-ack') resolve(true); };
    probe.postMessage({ dir: 'probe' });
    setTimeout(() => resolve(false), 400);
  });
  probe.close();
  if (alive) return location.replace(linkFor(saved));
  startHost(saved);
})();

// Aksi Dana — Tampilan bersama: hero counter, progress bar, feed, lencana status
'use strict';

// =====================================================================
//  TAMPILAN BERSAMA (hero counter, progress bar, feed)
// =====================================================================
const view = { counter: null, timer: 0, known: null, pub: null };

function setCounter(total) {
  const node = $('counter');
  const finalText = rp(total);
  if (window.countUp && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    if (!view.counter) {
      view.counter = new countUp.CountUp(node, total, { duration: 1.2, separator: '.', decimal: ',', prefix: 'Rp ' });
      view.counter.start();
    } else view.counter.update(total);
  } else node.textContent = finalText;
  // Tab di latar belakang tidak menjalankan animasi: pastikan angka akhir tetap benar
  clearTimeout(view.timer);
  view.timer = setTimeout(() => { node.textContent = finalText; }, 1600);
}

function render(pub) {
  view.pub = pub;
  const { cfg } = pub;
  document.title = cfg.event + ' — Aksi Dana';
  $('evName').textContent = cfg.event;
  $('evBy').textContent = 'Diselenggarakan oleh ' + cfg.organizer;
  $('targetText').textContent = 'dari target ' + rp(cfg.target);
  $('bankName').textContent = 'Bank ' + cfg.bank;
  $('accNo').textContent = cfg.accNo;
  $('accName').textContent = cfg.accName;

  setCounter(pub.total);
  const pct = (pub.total / cfg.target) * 100;
  $('progressFill').style.width = Math.min(100, pct) + '%';
  $('progress').setAttribute('aria-valuenow', String(Math.min(100, Math.round(pct))));
  $('progress').setAttribute('aria-valuetext', `${Math.floor(pct)}% dari target, ${rp(pub.total)} terkumpul`);
  $('pct').textContent = (pct >= 10 ? Math.floor(pct) : Math.floor(pct * 10) / 10).toLocaleString('id-ID') + '%';
  $('count').textContent = pub.count.toLocaleString('id-ID');

  const first = view.known === null;
  if (first) view.known = new Set();
  const fresh = pub.donations.filter((d) => !view.known.has(d.id));
  $('feed').innerHTML = pub.donations.map((d) => `
    <li class="py-3 ${!first && !view.known.has(d.id) ? 'feed-new' : ''}">
      <div class="flex items-baseline justify-between gap-3">
        <span class="min-w-0 break-words font-bold">${esc(d.name)}</span>
        <span class="flex-none font-extrabold tabular-nums text-emerald-800">${rp(d.amount)}</span>
      </div>
      ${d.message ? `<p class="mt-0.5 break-words text-slate-800">“${esc(d.message)}”</p>` : ''}
      <p class="text-sm text-slate-600">${jam(d.ts)}</p>
    </li>`).join('');
  $('feedEmpty').hidden = pub.donations.length > 0;
  pub.donations.forEach((d) => view.known.add(d.id));

  if (!first && fresh.length) {
    const d = fresh[0];
    $('announcer').textContent = `Donasi baru ${rp(d.amount)} dari ${d.name}. Total ${rp(pub.total)}.`;
    if (window.confetti && !matchMedia('(prefers-reduced-motion: reduce)').matches)
      confetti({ particleCount: 90, spread: 75, origin: { y: 0.35 }, colors: ['#047857', '#fcd34d', '#ffffff', '#0f172a'] });
  }

  $('closedBanner').hidden = !pub.closed;
  if (pub.closed) $('donorCard').hidden = true;
}

function setBadge(text, tone) {
  const tones = { live: 'bg-emerald-100 text-emerald-900', wait: 'bg-amber-100 text-amber-900', off: 'bg-slate-200 text-slate-800' };
  const b = $('connBadge');
  b.className = 'badge ' + tones[tone];
  b.textContent = text;
  b.hidden = false;
  $('liveDot').classList.toggle('dot-live', tone === 'live');
}

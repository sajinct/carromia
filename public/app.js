import { pagesMode, remoteApi, watch } from './runtime.js';
import { prizes, timeline, massTimes, venueAddress, about, documents, goodToKnow, ruleSections, matchFormat, formatText } from './info.js';
import { groups, centres, centreTypes, idTypes } from './parishes.js';
import { registrationPdf } from './registration-pdf.js';
const route = () => pagesMode ? (location.hash.slice(1) || '/').split('?')[0] : location.pathname;
const $ = (s, root = document) => root.querySelector(s);
const app = $('#app'), modal = $('#modal');
let state, page = route(), teamSearch = '', queueFilter = 'all', offset = 0, connected = true, installPrompt;
const icons = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M15 3.13a4 4 0 0 1 0 7.75"/><circle cx="9" cy="7" r="4"/>',
  bracket: '<path d="M3 3v6h6v6H3v6m6-9h6m0-9v6h6m-6 6h6v6M15 9v6"/>',
  screen: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  settings: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  external: '<path d="M15 3h6v6m0-6L10 14M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4"/>',
  trophy: '<path d="M8 3h8v6a4 4 0 0 1-8 0V3Zm0 2H4v3a4 4 0 0 0 4 4m8-7h4v3a4 4 0 0 1-4 4m-4 1v6m-4 2h8"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  pin: '<path d="M20 10c0 6-8 11-8 11S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
  logout: '<path d="M9 4H4v16h5m5-13 5 5-5 5m-6-5h11"/>',
  play: '<path d="m8 4 12 8-12 8V4Z"/>',
  coins: '<circle cx="9" cy="9" r="6"/><path d="M15 9a6 6 0 1 1-6 6"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4m8-4v4"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z"/><path d="m9 12 2 2 4-4"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>'
};
const icon = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.grid}</svg>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const now = () => Date.now() + offset;
const team = id => state.teams.find(t => t.id === id);
const name = id => team(id)?.name || 'To be decided';
const initials = id => name(id).split(/\s+/).slice(0, 2).map(s => s[0]).join('').toUpperCase();
const time = timestamp => new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dateLabel = () => state.event.date ? new Date(`${state.event.date}T12:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }) : 'Event date to be announced';
const money = amount => `₹${Number(amount).toLocaleString('en-IN')}`;
const deadlineLabel = (options = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) => state.event.registrationDeadline ? new Date(`${state.event.registrationDeadline}T12:00:00`).toLocaleDateString('en-IN', options) : '';
// A match is played in timed rounds; the umpire decides each one and an official marks its winner.
// A match keeps the format it started with; otherwise the Event settings apply.
const format = (m = {}) => ({ rounds: m.gamesPerMatch ?? matchFormat(state.event).rounds, minutes: m.gameMinutes ?? matchFormat(state.event).minutes });
const toWin = m => Math.ceil(format(m).rounds / 2);
const formatLabel = () => { const { rounds, minutes } = format(); return rounds === 1 ? `One round · ${minutes} minutes` : `Best of ${rounds} rounds · ${minutes} minutes each`; };
// The round in play, or null between rounds (the last one has a winner and the next isn't started).
const liveRound = m => m.rounds?.at(-1)?.winner ? null : m.rounds?.at(-1) ?? null;
const timeLabel = () => state.event.startTime ? `${new Date(`2000-01-01T${state.event.startTime}`).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} onwards` : 'Time to be announced';
const active = () => state.matches.filter(m => ['called', 'playing'].includes(m.status));
const completed = () => state.matches.filter(m => m.status === 'completed' && !m.bye);
const badge = (text, kind = '') => `<span class="badge ${kind}">${esc(text)}</span>`;
function logo() { return `<a class="brand" href="/"><img src="/icon.svg" alt="" width="38" height="38"><span>CARROMIA<small>THE GAME. THE COMMUNITY.</small></span></a>`; }
async function api(path, data) {
  if (pagesMode) return remoteApi(path, data);
  const res = await fetch(`/api/${path}`, data === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const value = await res.json(); if (!res.ok) throw new Error(value.error || 'Request failed.'); return value;
}
function toast(message, error = false) { const t = $('#toast'); t.textContent = message; t.className = error ? 'show error' : 'show'; clearTimeout(toast.timer); toast.timer = setTimeout(() => t.className = '', 5000); }
// True while someone is typing, has unsaved form input (including autofill) or a dialog is open.
function busy() {
  if (modal.open || document.activeElement?.matches('input, textarea, select')) return true;
  return [...app.querySelectorAll('form input, form textarea, form select')].some(el => el.type === 'checkbox' || el.type === 'radio' ? el.checked !== el.defaultChecked : el.tagName === 'SELECT' ? [...el.options].some(o => o.selected !== o.defaultSelected) : el.value !== el.defaultValue);
}
// renderPage: true = always redraw; 'auto' = background refresh, redraw only when nobody is mid-input.
async function sync(renderPage = true) {
  try { state = await api('state'); offset = state.serverTime - Date.now(); connected = true; if (renderPage === true || (renderPage === 'auto' && !busy() && !['/register', '/admin/settings'].includes(page))) render(); }
  catch (e) { connected = false; if (!state) app.innerHTML = `<div class="error-screen"><h1>Unable to reach the tournament</h1><p>${pagesMode ? 'Check your internet connection and try again.' : 'Make sure the local server is running.'}</p><button class="btn primary" data-action="retry">Try again</button></div>`; }
  updateConnection();
}
function navigate(path) { menuOpen = false; page = path.split('?')[0]; history.pushState({}, '', pagesMode ? `#${path}` : path); render(); window.scrollTo(0, 0); }
window.addEventListener('popstate', () => { page = route(); render(); });
function updateConnection() { document.querySelectorAll('[data-connection]').forEach(el => { el.textContent = connected ? 'Live updates connected' : 'Reconnecting — data may be outdated'; el.classList.toggle('disconnected', !connected); }); }
function render() {
  if (!state) return;
  document.title = `CARROMIA ${state.event.year} · ${page.startsWith('/admin') ? 'Tournament desk' : page === '/live' ? 'Live boards' : page === '/rules' ? 'Rules' : page === '/teams' ? 'Teams' : page === '/results' ? 'Results' : 'Every coin counts'}`;
  if (page.startsWith('/admin') || page === '/checkin' || page === '/lunch') app.innerHTML = state.isAdmin ? desk() : login();
  else if (page === '/live') app.innerHTML = live();
  else if (page === '/register') app.innerHTML = registration();
  else if (page === '/rules') app.innerHTML = rulesPage();
  else if (page === '/results') app.innerHTML = publicResultsPage();
  else if (page === '/teams') { app.innerHTML = publicTeamsPage(); openTeamFromLink(); }
  else app.innerHTML = home();
  if (state.practice) app.insertAdjacentHTML('afterbegin', `<div class="practice-banner"><strong>PRACTICE MODE</strong><span>Rehearsal event for training. Devices opened with the practice link see it; the public site shows the real event.</span><button class="btn tiny" data-action="practice" data-on="false">Exit practice</button></div>`);
  if (pagesMode) {
    app.querySelectorAll('a[href^="/"]').forEach(link => link.setAttribute('href', `#${link.getAttribute('href')}`));
    app.querySelectorAll('img[src^="/"]').forEach(img => img.setAttribute('src', `.${img.getAttribute('src')}`));
    app.querySelectorAll('img[data-practice-qr]').forEach(async img => { try { img.src = (await api(`practice-qr?route=${encodeURIComponent(img.dataset.practiceQr)}`)).qr; } catch { img.hidden = true; } });
  }
  app.querySelectorAll('[data-link-qr]').forEach(showLinkQr);
  labelTables(app); updateConnection(); tick(); measureBanner();
}
// On phones the desk's top bar sticks just below the practice banner, whatever its height.
function measureBanner() { app.style.setProperty('--banner-height', `${$('.practice-banner')?.offsetHeight || 0}px`); }
window.addEventListener('resize', measureBanner);
// QR codes for public pages, such as the live screen's "scan for results". Each is made once per
// event (real or practice) and page, then reused on every redraw so the screen doesn't flicker.
const linkQrs = new Map(), linkQrsLoading = new Set();
function showLinkQr(card) {
  const route = card.dataset.linkQr, key = `${state.practice ? 'practice' : 'event'}${route}`;
  const fill = el => { const { qr, url } = linkQrs.get(key); el.querySelector('img').src = qr; el.querySelector('code').textContent = url.replace(/^https?:\/\//, ''); if (el.tagName === 'A') el.href = url; el.hidden = false; };
  if (linkQrs.has(key)) return fill(card);
  if (linkQrsLoading.has(key)) return;
  linkQrsLoading.add(key);
  api(`link-qr?route=${encodeURIComponent(route)}`).then(r => { linkQrs.set(key, r); app.querySelectorAll(`[data-link-qr="${route}"]`).forEach(fill); }, () => {}).finally(() => linkQrsLoading.delete(key));
}
function labelTables(root) {
  root.querySelectorAll('table').forEach(table => {
    const heads = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
    table.querySelectorAll('tbody tr').forEach(tr => [...tr.children].forEach((td, i) => { if (heads[i]) td.dataset.label = heads[i]; }));
  });
}
const hosts = [
  { href: 'https://www.marymathachurchvijayanagar.com/', img: '/brand/mary-matha.webp', alt: 'Mary Matha Church emblem', name: 'Mary Matha Church', place: 'Vijayanagar, Bangalore' },
  { href: 'https://www.mandyadiocese.org/', img: '/brand/diocese-mandya.webp', alt: 'Diocese of Mandya seal', name: 'Diocese of Mandya', place: 'Syro-Malabar Catholic Diocese' }
];
function publicHeader() { return `<header class="public-header">${logo()}<nav aria-label="Main navigation"><a href="/" class="${page === '/' ? 'selected' : ''}">The tournament</a><a href="/live">${icon('screen')} Live boards</a><a href="/results" class="${page === '/results' ? 'selected' : ''}">Results</a><a href="/teams" class="${page === '/teams' ? 'selected' : ''}">Teams</a><a href="/rules" class="${page === '/rules' ? 'selected' : ''}">Rules</a><a href="/admin" class="btn outline small">Tournament desk ${icon('arrow')}</a></nav>${publicMenu()}</header>`; }
// On phones the public links move into a menu at the top right.
function publicMenu() {
  const canRegister = !state.demo && state.registration?.open;
  const links = [['/', 'grid', 'The tournament'], ...(canRegister ? [['/register', 'plus', 'Register your team']] : []), ['/live', 'screen', 'Live boards'], ['/results', 'trophy', 'Results'], ['/teams', 'users', 'Teams'], ['/rules', 'check', 'Rules'], ['/admin', 'shield', 'Tournament desk']];
  return `<button class="menu-toggle" data-action="menu" aria-label="Menu" aria-controls="mobile-menu" aria-expanded="${menuOpen}">${icon('menu')}</button><div class="mobile-menu ${menuOpen ? 'open' : ''}" id="mobile-menu">${links.map(([p, i, text]) => `<a href="${p}" class="${page === p ? 'active' : ''}">${icon(i)} ${text}</a>`).join('')}</div>`;
}
function footer() { return `<footer><span>© ${esc(state.event.year)} CARROMIA · Hosted by Mary Matha Church, Vijayanagar · Diocese of Mandya</span><span class="footer-hosts">${hosts.map(h => `<a href="${h.href}" target="_blank" rel="noopener" title="${esc(h.name)}"><img src="${h.img}" alt="${esc(h.alt)}" width="26" height="26"></a>`).join('')}</span></footer>`; }
function home() {
  const closed = state.demo || !state.registration.open, e = state.event, maps = `https://www.google.com/maps/search/?api=1&amp;query=${encodeURIComponent(state.event.venue)}`;
  return `<div class="public-wrap">${publicHeader()}<main><section class="poster-hero"><div class="ph-copy"><div class="ph-presents"><span class="ph-brush">PITHRUVEDHI OF MMC</span><small>PRESENTS</small></div><h1 class="ph-title"><span class="ph-name">${esc(e.name)}</span><span class="ph-year">${esc(e.year)}</span></h1><p class="ph-tag">Small board. <em>Big dreams.</em></p><p class="ph-lead">Two players. One team. Best of three games to make your mark. The parish family of Mary Matha Church, Vijayanagar invites you to strike for victory.</p><div class="hero-actions"><a class="btn primary large" href="${closed ? '/live' : '/register'}">${closed ? 'Follow the tournament' : 'Register your team'} ${icon('arrow')}</a><a class="text-link" href="/rules">Read the rules ${icon('arrow')}</a></div></div><figure class="ph-poster"><img src="/brand/poster.webp" alt="CARROMIA 2026 poster: Pithruvedhi of MMC presents, 15 November 2026 at Mary Matha Church, Vijayanagar" width="800" height="1200"></figure><div class="ph-info"><div>${icon('calendar')}<span><strong>${esc(dateLabel())}</strong><small>${esc(timeLabel())}</small></span></div><a href="${maps}" target="_blank" rel="noopener">${icon('pin')}<span><strong>${esc(e.venue)}</strong><small>Get directions</small></span></a><div>${icon('trophy')}<span><strong>${money(prizes[0].amount)} first prize</strong><small>Cash prizes &amp; trophies for the top three</small></span></div></div><div class="ph-welcome">ALL ARE WELCOME</div></section><div class="skill-strip" aria-label="Skill, focus, strategy, win"><span>SKILL</span><i></i><span>FOCUS</span><i></i><span>STRATEGY</span><i></i><span>WIN</span></div><section class="facts"><div><span>01 — THE TEAM</span><strong>Better together.</strong><p>Open doubles, thumbing game. Exactly two players per team.</p></div><div><span>02 — THE CLOCK</span><strong>${format().rounds} rounds. ${format().minutes} minutes each.</strong><p>Every round has its own clock, and the umpire decides it.</p></div><div><span>03 — THE WIN</span><strong>First to ${toWin()} round${toWin() === 1 ? '' : 's'}.</strong><p>The umpire’s decision on each round is final.</p></div></section><section class="essentials" aria-labelledby="essentials-title"><div class="essentials-head"><div><div class="eyebrow">THE ESSENTIALS</div><h2 id="essentials-title">Everything you need to enter.</h2></div><a class="btn outline small" href="/rules">Tournament rules ${icon('arrow')}</a></div><div class="info-grid"><div><span>ENTRY FEE</span><strong>${money(e.entryFee)}</strong><p>per team</p></div><div><span>TEAM SLOTS</span><strong>${e.maxTeams}</strong><p>${closed ? 'Registration is closed' : `${state.registration.slotsLeft} still open`} · up to ${e.maxTeamsPerParish} teams per parish</p></div><div><span>REGISTER BY</span><strong>${esc(deadlineLabel({ day: 'numeric', month: 'short', year: 'numeric' }) || 'To be announced')}</strong><p>${esc(deadlineLabel({ weekday: 'long' }))}</p></div><div><span>WHO CAN PLAY</span><strong>Open doubles</strong><p>Open to all genders · age 18+</p></div></div><div class="prize-row">${prizes.map((p, i) => `<div class="prize prize-${i + 1}">${icon('trophy')}<span>${esc(p.place)}</span><strong>${money(p.amount)}</strong><small>+ trophy</small></div>`).join('')}</div></section><section class="day-plan"><div><div class="eyebrow">THE DAY</div><h2>${esc(dateLabel())}</h2><ol class="timeline">${timeline.map(([at, what]) => `<li><time>${esc(at)}</time><span>${esc(what)}</span></li>`).join('')}</ol></div><div class="day-notes"><div class="day-note">${icon('pin')}<div><strong>${esc(e.venue)}</strong><p>${esc(venueAddress)}</p><a class="text-link" href="${maps}" target="_blank" rel="noopener">Get directions ${icon('external')}</a></div></div><div class="day-note">${icon('calendar')}<div><strong>Sunday Holy Mass</strong><p>${massTimes.map(esc).join(' and ')}</p></div></div><div class="day-note">${icon('check')}<div><strong>Good to know</strong><ul>${goodToKnow.map(line => `<li>${esc(line)}</li>`).join('')}</ul></div></div><div class="day-note">${icon('shield')}<div><strong>Bring for registration verification</strong><ol>${documents.map(line => `<li>${esc(line)}</li>`).join('')}</ol></div></div></div></section><section class="hosts" aria-labelledby="hosts-title"><div><div class="eyebrow">BE A PART OF HISTORY</div><h2 id="hosts-title">A parish celebration,<br>one strike at a time.</h2><p>${esc(about)}</p></div><div class="host-cards">${hosts.map(h => `<a class="host-card" href="${h.href}" target="_blank" rel="noopener"><img src="${h.img}" alt="${esc(h.alt)}" width="64" height="64"><span><strong>${esc(h.name)}</strong><small>${esc(h.place)}</small></span>${icon('external')}</a>`).join('')}</div></section><section class="home-bottom"><div><div class="eyebrow">FROM THE FIRST STRIKE TO THE FINAL</div><h2>A place for every player.<br>A game for the whole community.</h2></div><div><p>Follow the action across four boards, see who’s up next, and cheer your team all the way through.</p><a href="/live" class="text-link">See what’s happening ${icon('arrow')}</a></div></section></main>${footer()}</div>`;
}
function registration() {
  const closed = state.demo || !state.registration.open, e = state.event;
  const bring = `<ol>${documents.map(line => `<li>${esc(line)}</li>`).join('')}</ol>`;
  return `<div class="public-wrap">${publicHeader()}<main class="registration-layout"><section><div class="eyebrow">YOUR NEXT GREAT GAME STARTS HERE</div><h1>Find your partner.<br><em>Take your shot.</em></h1><p>Register your two-player team for CARROMIA ${esc(e.year)}.</p><ul class="registration-perks"><li>${icon('users')} Open doubles. Two players, both 18 or older.</li><li>${icon('coins')} Entry fee ${money(e.entryFee)} per team.</li><li>${icon('clock')} Matches are ${esc(formatText(e))}.</li><li>${icon('check')} Your own team ID and check-in QR.</li></ul><div class="subtle-card">${icon('pin')}<strong>${esc(e.venue)}</strong><p>${esc(dateLabel())} · reporting time 9:00 AM</p></div><div class="subtle-card bring-card">${icon('shield')}<strong>Bring on the day</strong>${bring}</div>${supportCard()}</section><section class="form-card"><div class="section-heading"><h2>Team registration</h2>${badge('2 players', 'green')}</div>${closed ? `<div class="empty"><h3>${state.demo ? 'Registration is currently closed' : esc(state.registration.reason)}</h3><p>${state.demo ? 'Registration will open soon. Please check back.' : 'Follow the boards and the bracket on the live display.'}</p><a href="/live" class="btn primary">View live boards ${icon('arrow')}</a></div>` : `<div class="notice register-facts"><span><strong>${money(e.entryFee)}</strong> per team</span><span><strong>${state.registration.slotsLeft}</strong> of ${e.maxTeams} slots open</span>${e.registrationDeadline ? `<span>Register by <strong>${esc(deadlineLabel({ day: 'numeric', month: 'short' }))}</strong></span>` : ''}</div><form id="registration-form"><label>Team name<input name="name" maxlength="80" placeholder="e.g. The Strikers" required></label><div class="form-row"><label>Forane / Zone<select name="forane" required><option value="">Select forane or zone</option>${groups.map(g => `<option>${esc(g)}</option>`).join('')}</select></label><label>Parish / Centre<select name="centre" required disabled><option value="">Choose the forane first</option></select></label></div><p class="form-note">Up to ${e.maxTeamsPerParish} teams can register from one parish.</p>${playerFields(1)}${playerFields(2)}${e.paymentRequired ? paymentFields() : ''}<div class="form-row"><label>Primary contact<select name="primaryContact"><option value="0">Player one</option><option value="1">Player two</option></select></label><label>Lunch on the day<select name="lunch"><option value="0">No lunch needed</option><option value="1">Lunch for 1 player</option><option value="2">Lunch for both players</option></select></label></div><label class="checkbox-label"><input name="adults" type="checkbox" required> Both players are 18 or older</label><p class="form-note">Player names appear on tournament screens. Mobile numbers, photos and ID details are visible only to the tournament desk, which uses them to check you in. Lunch is provided only if it is booked here.</p><details class="bring-list"><summary>What to bring on the day</summary>${bring}</details><p class="form-error" role="alert"></p><button class="btn primary full" type="submit">Register team ${icon('arrow')}</button></form>`}</section></main>${footer()}</div>`;
}
// Support contacts from Event settings, with call and WhatsApp links.
const waNumber = phone => { const d = String(phone ?? '').replace(/\D/g, ''); return d.length === 10 ? `91${d}` : d.length === 11 && d.startsWith('0') ? `91${d.slice(1)}` : d; };
function supportCard() {
  const contacts = state.event.contacts || [];
  return contacts.length ? `<div class="support-card">${icon('users')}<strong>Questions? Contact us</strong><ul>${contacts.map(c => `<li><span>${esc(c.name)}</span><a href="tel:${esc(c.phone.replace(/[^\d+]/g, ''))}">${esc(c.phone)}</a><a href="https://wa.me/${waNumber(c.phone)}" target="_blank" rel="noopener">WhatsApp</a></li>`).join('')}</ul></div>` : '';
}
function paymentFields() {
  const e = state.event, upi = e.upiId ? `upi://pay?pa=${encodeURIComponent(e.upiId)}&pn=${encodeURIComponent(`${e.name} ${e.year}`)}&am=${e.entryFee}&cu=INR&tn=${encodeURIComponent(`${e.name} entry fee`)}` : '';
  return `<fieldset class="payment-fields"><legend><span>₹</span> Payment</legend><p class="form-note">Pay the entry fee of <strong>${money(e.entryFee)}</strong> to this UPI QR code, then enter the transaction number (UTR) or add a screenshot of the payment. Your registration is confirmed once the tournament desk sees the payment in the bank.</p><img class="upi-qr" src="${e.upiQr}" alt="UPI QR code for the entry fee" width="220" height="220">${e.upiId ? `<div class="upi-id"><code>${esc(e.upiId)}</code><button type="button" class="btn tiny outline" data-action="copy-link" data-link="${esc(e.upiId)}" data-copied="UPI ID copied.">Copy UPI ID</button><a class="btn tiny primary" href="${esc(upi)}">Pay with a UPI app</a></div>` : ''}<div class="form-row"><label>UPI transaction number (UTR)<input name="txnRef" maxlength="30" autocomplete="off" autocapitalize="characters" placeholder="e.g. 412356789012"></label><label>Payment screenshot<input name="paymentShot" type="file" accept="image/*"></label></div><p class="form-note">Enter the transaction number, add a screenshot, or both.</p></fieldset>`;
}
// The team's public download page, as sent on WhatsApp.
function teamLink(id) {
  const route = `/teams?team=${encodeURIComponent(id)}`;
  return pagesMode ? `${location.origin}${location.pathname}${state.practice ? '?practice=1' : ''}#${route}` : `${location.origin}${route}`;
}
function whatsappLink(t) {
  const text = `${state.event.name} ${state.event.year}: your registration for ${t.name} (${t.id}) is confirmed. Download your registration form here, using the primary player's mobile number: ${teamLink(t.id)}`;
  return `https://wa.me/${waNumber(t.players[t.primaryContact]?.mobile)}?text=${encodeURIComponent(text)}`;
}
// Public list of confirmed teams; each can download its form with the primary player's mobile.
let publicSearch = '', openedTeamLink = null;
const confirmedTeams = () => state.teams.filter(t => t.status !== 'pending');
function publicTeamCards() {
  const teams = confirmedTeams().filter(t => `${t.id} ${t.name} ${t.parish} ${t.forane || ''} ${t.players.map(p => p.name).join(' ')}`.toLowerCase().includes(publicSearch.toLowerCase()));
  return teams.length ? teams.map(t => `<article class="team-card"><div class="team-card-head"><strong>${esc(t.name)}</strong><span>${t.id}</span></div><p>${t.players.map(p => esc(p.name)).join(' &amp; ')}</p><small>${esc(t.parish)}${t.forane ? ` · ${esc(t.forane)}` : ''}</small><button class="btn small outline" data-action="team-download" data-id="${t.id}">${icon('download')} Registration form</button></article>`).join('') : `<div class="empty"><h3>${confirmedTeams().length ? 'No teams match your search' : 'No confirmed teams yet'}</h3><p>${confirmedTeams().length ? 'Try a team name, player, parish or team ID.' : 'Teams appear here once their registration is confirmed.'}</p></div>`;
}
function publicTeamsPage() {
  return `<div class="public-wrap">${publicHeader()}<main class="teams-page"><div class="rules-head"><div class="eyebrow">REGISTERED TEAMS</div><h1>The teams.<br><em>Ready to strike.</em></h1><p>${confirmedTeams().length} confirmed team${confirmedTeams().length === 1 ? '' : 's'}. To download your team’s registration form, tap it and enter the primary player’s mobile number.</p><label class="search-field">${icon('search')}<input id="public-team-search" aria-label="Search teams" placeholder="Search team, player or parish" value="${esc(publicSearch)}"></label></div><div class="team-cards" id="public-team-list">${publicTeamCards()}</div></main>${footer()}</div>`;
}
// Public results, opened from the live screen's QR code: the champions, the matches on the boards
// now, every result by round (latest round first, searchable by team) and the bracket.
let resultSearch = '';
const teamText = id => { const t = team(id); return `${id} ${name(id)} ${t?.parish || ''} ${t?.players?.map(p => p.name).join(' ') || ''}`.toLowerCase(); };
function resultRow(m, side, score) {
  const id = m[`team${side}`], won = m.winner && m.winner === id;
  return `<div class="result-team${won ? ' won' : ''}"><span>${won ? icon('trophy') : ''}<strong>${esc(name(id))}</strong><small>${esc(team(id)?.parish)}</small></span><b>${score}</b></div>`;
}
function resultCard(m) {
  const score = side => m.walkover ? (m.winner === m[`team${side}`] ? 'W/O' : '') : m[`games${side}`] ?? '–';
  return `<article class="result-card"><header><span>${m.id} · ${m.walkover ? 'Walkover' : `Board ${m.board}`}${m.corrected ? ' · Corrected' : ''}</span><time>${time(m.completedAt)}</time></header>${resultRow(m, 'A', score('A'))}${resultRow(m, 'B', score('B'))}${m.walkover ? `<small class="result-note">${esc(m.walkover)}</small>` : ''}</article>`;
}
function publicResultList() {
  const query = resultSearch.trim().toLowerCase(), done = completed().filter(m => !query || teamText(m.teamA).includes(query) || teamText(m.teamB).includes(query));
  if (!done.length) return `<div class="empty"><h3>${completed().length ? 'No results for that team yet' : 'No results yet'}</h3><p>${completed().length ? 'Try a team name, player, parish or team ID.' : 'Results appear here as soon as each match ends.'}</p></div>`;
  return [...new Set(done.map(m => m.round))].sort((a, b) => b - a).map(r => {
    const list = done.filter(m => m.round === r).sort((a, b) => b.completedAt - a.completedAt);
    return `<section class="result-round"><h2>${esc(list[0].roundName)}<small>${list.length} result${list.length === 1 ? '' : 's'}</small></h2><div class="result-cards">${list.map(resultCard).join('')}</div></section>`;
  }).join('');
}
function boardsNow() {
  const list = active().sort((a, b) => a.board - b.board);
  if (!list.length) return '';
  const card = m => {
    const playing = m.status === 'playing', round = playing && liveRound(m), n = (m.rounds?.length || 0) + (round ? 0 : 1);
    const status = !playing ? 'Players called' : round ? `Round ${n} in play` : `Round ${n} next`;
    return `<article class="result-card live"><header><span>Board ${m.board} · ${esc(m.roundName)}</span>${badge(status, playing ? 'green' : 'neutral')}</header>${resultRow(m, 'A', playing ? m.gamesA ?? 0 : '')}${resultRow(m, 'B', playing ? m.gamesB ?? 0 : '')}</article>`;
  };
  return `<section class="results-now"><div class="section-heading"><div class="heading-inline"><h2>On the boards now</h2><span class="live-dot"></span></div><a class="text-link compact" href="/live">Live boards ${icon('arrow')}</a></div><div class="result-cards">${list.map(card).join('')}</div></section>`;
}
function publicResultsPage() {
  const final = state.matches.at(-1), played = completed().length, total = state.matches.filter(m => !m.bye).length, stage = state.matches.find(m => m.status !== 'completed')?.roundName;
  const champion = final?.winner && team(final.winner), runnerUp = champion && (final.winner === final.teamA ? final.teamB : final.teamA);
  const intro = !state.matches.length ? 'The draw hasn’t been made yet. Results appear here as soon as matches are played.' : `${played} of ${total} match${total === 1 ? '' : 'es'} played${stage ? ` · Now playing: ${esc(stage)}` : ' · Tournament complete'}. This page updates by itself.`;
  return `<div class="public-wrap">${publicHeader()}<main class="results-page"><div class="rules-head"><div class="eyebrow">RESULTS · CARROMIA ${esc(state.event.year)}</div><h1>Every match.<br><em>Every winner.</em></h1><p>${intro}</p></div>${champion ? `<section class="results-champion">${icon('trophy')}<div><span>CHAMPIONS</span><h2>${esc(champion.name)}</h2><p>${champion.players.map(p => esc(p.name)).join(' &amp; ')} · ${esc(champion.parish)}</p></div>${runnerUp ? `<div class="runner-up"><span>RUNNERS-UP</span><strong>${esc(name(runnerUp))}</strong></div>` : ''}</section>` : ''}${boardsNow()}${state.matches.length ? `<section class="results-list"><div class="section-heading"><h2>Results</h2><label class="search-field">${icon('search')}<input id="public-result-search" aria-label="Find your team" placeholder="Find your team" value="${esc(resultSearch)}"></label></div><div id="public-result-list">${publicResultList()}</div></section><section class="results-bracket"><div class="section-heading"><h2>The bracket</h2><span class="muted compact">Scroll sideways to follow each round</span></div>${bracketView()}</section>` : `<div class="empty"><a class="btn outline" href="/teams">See the registered teams ${icon('arrow')}</a></div>`}</main>${footer()}</div>`;
}
function teamDownloadDialog(id) {
  const t = team(id);
  if (!t) return dialog('<h2>Team not found</h2><p>Check the team ID in your link, or find your team in the list.</p>');
  if (t.status === 'pending') return dialog(`<div class="eyebrow">${t.id}</div><h2>Payment being verified</h2><p>${esc(t.name)}’s registration form can be downloaded once the tournament desk confirms the payment.</p>`);
  dialog(`<div class="eyebrow">${t.id}</div><h2>${esc(t.name)}</h2><p>Enter the primary player’s mobile number, as given at registration, to download the registration form.</p><form id="team-form-form" data-id="${t.id}"><label>Mobile number<input name="mobile" type="tel" inputmode="tel" autocomplete="tel" required placeholder="Mobile number"></label><p class="form-error" role="alert"></p><button class="btn primary full" type="submit">${icon('download')} Download registration form</button></form>`);
}
// A WhatsApp link (/teams?team=CAR-001) opens that team's download dialog once.
function openTeamFromLink() {
  const id = new URLSearchParams(pagesMode ? location.hash.split('?')[1] : location.search).get('team');
  if (id && openedTeamLink !== id && !modal.open) { openedTeamLink = id; teamDownloadDialog(id.toUpperCase()); }
}
// The UPI QR code for Event settings: a PNG at its own size (at most 2000px), on white, so it stays
// sharp. It is saved as a file and the settings keep its address.
async function upiQrData(file) {
  if (!file?.size) return '';
  let image; try { image = await createImageBitmap(file); } catch { throw new Error('That image couldn’t be opened. Choose a PNG or JPEG picture of the QR code.'); }
  const scale = Math.min(1, 2000 / Math.max(image.width, image.height)), canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
  canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale);
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0, canvas.width, canvas.height); image.close();
  const data = canvas.toDataURL('image/png');
  if (data.length > 7000000) throw new Error('That QR image is too large. Crop it to just the QR code and try again.');
  return data;
}
function playerFields(n) {
  return `<fieldset><legend><span>0${n}</span> Player ${n === 1 ? 'one' : 'two'}</legend><div class="photo-field"><img class="photo-preview" id="photo-preview-${n}" alt="" width="64" height="64" hidden><label>Photo<input name="photo${n}" type="file" accept="image/*" required data-photo="${n}"></label></div><label>Full name<input name="player${n}" maxlength="80" ${n === 1 ? 'autocomplete="name" ' : ''}required placeholder="Player’s full name"></label><label>Mobile number<input name="mobile${n}" type="tel" pattern="[+0-9 \\(\\)\\-]{7,20}" maxlength="20" required placeholder="Mobile number"></label><div class="form-row"><label>ID proof<select name="idType${n}" required><option value="">Select ID proof</option>${idTypes.map(t => `<option>${t}</option>`).join('')}</select></label><label>Last 4 of the ID number<input name="idLast4${n}" minlength="4" maxlength="4" pattern="[A-Za-z0-9]{4}" autocapitalize="characters" autocomplete="off" required placeholder="e.g. 1234"></label></div></fieldset>`;
}
// The parishes and centres of one forane or zone, grouped by type. The value carries the type too,
// because Honnamanakatte is listed as both a mass centre and a mission centre.
function centreOptions(group) {
  return `<option value="">Select parish or centre</option>${centreTypes.map(type => { const list = centres.filter(c => c.group === group && c.type === type); return list.length ? `<optgroup label="${type}">${list.map(c => `<option value="${esc(`${c.type}|${c.name}`)}">${esc(c.name)}</option>`).join('')}</optgroup>` : ''; }).join('')}`;
}
// A picture as a JPEG: at most `size` px on the longer side. Photos and screenshots are kept at up to
// 2000px; a photo's thumbnail (320px, about 20–40 KB) is for lists and the registration form.
async function photoData(file, size = 320, limit = 200000, quality = 0.8) {
  if (!file?.size) throw new Error('Add a photo of each player.');
  let image; try { image = await createImageBitmap(file); } catch { throw new Error('That photo couldn’t be opened. Choose a JPEG or PNG picture.'); }
  for (let side = size; ; side = Math.round(side * 0.8)) {
    const scale = Math.min(1, side / Math.max(image.width, image.height)), canvas = document.createElement('canvas');
    canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale);
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL('image/jpeg', quality);
    if (data.length <= limit || side < 200) { image.close(); return data; }
  }
}
// The registration PDF. jsPDF (public/vendor) loads only when a form is downloaded.
let jsPdfLoader, lastRegistration = null;
function loadJsPdf() {
  jsPdfLoader ??= new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = `${pagesMode ? '.' : ''}/vendor/jspdf.umd.min.js`;
    script.onload = () => resolve(window.jspdf.jsPDF);
    script.onerror = () => { jsPdfLoader = null; script.remove(); reject(new Error('Couldn’t load the PDF maker. Check your connection and try again.')); };
    document.head.append(script);
  });
  return jsPdfLoader;
}
// The host emblems as PNGs for the form's header (the PDF can't embed WebP).
function pdfLogos() {
  return Promise.all(hosts.map(h => new Promise(resolve => {
    const img = new Image();
    img.onload = () => { const c = document.createElement('canvas'); c.width = c.height = 160; c.getContext('2d').drawImage(img, 0, 0, 160, 160); resolve(c.toDataURL('image/png')); };
    img.onerror = () => resolve(null); img.src = `${pagesMode ? '.' : ''}${h.img}`;
  }))).then(logos => logos.filter(Boolean));
}
const fullPhoto = file => photoData(file, 2000, 5600000, 0.9);
// A picture as a data URL, which the PDF needs; photos from the desk and the form link are links.
async function imageData(src) {
  if (!src || src.startsWith('data:')) return src || '';
  try { const blob = await (await fetch(src)).blob(); return await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => resolve(''); reader.readAsDataURL(blob); }); }
  catch { return ''; }
}
async function saveRegistrationPdf(team, qr, teamPhotos = [], lunchQr = '') {
  const [jsPDF, logos, photos] = await Promise.all([loadJsPdf(), pdfLogos(), Promise.all(teamPhotos.map(imageData))]);
  registrationPdf(jsPDF, { team, event: state.event, qr, lunchQr, photos, logos }).save(`${team.id}-registration-form.pdf`);
}
function rulesPage() {
  let number = 0;
  return `<div class="public-wrap">${publicHeader()}<main class="rules-page"><div class="rules-head"><div class="eyebrow">TOURNAMENT RULES &amp; DETAILS</div><h1>Know the rules.<br><em>Play your best.</em></h1><p>CARROMIA ${esc(state.event.year)} is an open doubles, thumbing-game knockout. Every match is ${esc(formatText(state.event))}.</p></div><div class="rules-grid">${ruleSections.map((section, i) => `<section class="rule-card"><header><span>${String(i + 1).padStart(2, '0')}</span><h2>${esc(section.title)}</h2></header><ol start="${number + 1}">${section.rules.map(rule => { number++; return `<li>${esc(rule)}</li>`; }).join('')}</ol></section>`).join('')}</div><div class="rules-extra"><section class="rule-card note-card"><header>${icon('shield')}<h2>Bring for registration verification</h2></header><p>Participants are requested to bring these documents without fail, for smoother registration verification.</p><ol>${documents.map(line => `<li>${esc(line)}</li>`).join('')}</ol></section><section class="rule-card note-card"><header>${icon('check')}<h2>Good to know</h2></header><ul><li>Entry fee for doubles is ${money(state.event.entryFee)} per team.</li>${state.event.registrationDeadline ? `<li>Last date for registration is ${esc(deadlineLabel())}.</li>` : ''}${goodToKnow.map(line => `<li>${esc(line)}</li>`).join('')}</ul></section></div></main>${footer()}</div>`;
}
function login() { return `<div class="public-wrap">${publicHeader()}<main class="login-layout"><div class="form-card login-card"><div class="login-symbol">${icon('grid')}</div><div class="eyebrow">ORGANIZER ACCESS</div><h1>Tournament desk</h1><p>A clear view of every board, team, and next move.</p><form id="login-form">${state.authMode === 'supabase' ? '<label>Email<input type="email" name="email" autocomplete="username" required placeholder="you@example.com"></label><label>Password<input type="password" name="password" autocomplete="current-password" required placeholder="Enter your password"></label>' : '<label>Desk password<input type="password" name="password" autocomplete="current-password" required placeholder="Enter your password"></label>'}${state.localDemo ? '<div class="notice">Local preview password: <strong>carromia-demo</strong></div>' : ''}<p class="form-error" role="alert"></p><button class="btn primary full" type="submit">Open tournament desk ${icon('arrow')}</button></form></div></main>${footer()}</div>`; }
const isEventAdmin = () => state.user?.role === 'admin';
// Lunch coupons on the registration form, scanned at the lunch counter: an event setting.
const lunchOn = () => Boolean(state.event.lunchCoupons);
const lunchQrFor = t => lunchOn() && t.lunch && t.checkinToken ? api(`qr?token=${encodeURIComponent(t.checkinToken)}&for=lunch`).then(r => r.qr, () => '') : '';
const canManageOfficials = () => pagesMode && isEventAdmin();
// Officials with their own account can change its password; the shared desk password is set on the server.
const ownPassword = () => state.authMode === 'supabase' && Boolean(state.user);
function accountDialog() { dialog(`<div class="eyebrow">SIGNED IN</div><h2>${esc(state.user.name)}</h2><p>${state.user.role === 'admin' ? 'Event admin' : 'Official'}</p><div class="dialog-actions"><button class="btn outline" data-action="change-password">${icon('lock')} Change password</button><button class="btn outline" data-action="logout">${icon('logout')} Sign out</button></div>`); }
function passwordDialog() { dialog(`<div class="eyebrow">YOUR ACCOUNT</div><h2>Change your password</h2><p>Use at least 8 characters. You stay signed in on this device.</p><form id="password-form"><label>Current password<input type="password" name="current" autocomplete="current-password" required></label><label>New password<input type="password" name="password" autocomplete="new-password" minlength="8" required></label><label>Repeat new password<input type="password" name="confirm" autocomplete="new-password" minlength="8" required></label><p class="form-error" role="alert"></p><button class="btn primary full">Change password ${icon('check')}</button></form>`); }
// Each item: path, icon, name, and for the ones used all day a short name for the phone's bottom bar.
// On phones the rest sit in the menu at the top right.
const navItems = () => [['/admin', 'grid', 'Match control', 'Matches'], ['/admin/teams', 'users', 'Teams & check-in', 'Teams'], ['/admin/bracket', 'bracket', 'Tournament bracket', 'Bracket'], ['/admin/results', 'trophy', 'Results', 'Results'], ['/admin/settings', 'settings', 'Event settings'], ...(canManageOfficials() ? [['/admin/officials', 'shield', 'Officials']] : [])];
let menuOpen = false;
function setMenu(open) { menuOpen = open; $('#mobile-menu')?.classList.toggle('open', open); $('.menu-toggle')?.setAttribute('aria-expanded', String(open)); }
function mobileMenu() {
  const more = navItems().filter(([, , , short]) => !short);
  return `<button class="menu-toggle ${more.some(([p]) => p === page) ? 'active' : ''}" data-action="menu" aria-label="More options" aria-controls="mobile-menu" aria-expanded="${menuOpen}">${icon('menu')}</button><div class="mobile-menu ${menuOpen ? 'open' : ''}" id="mobile-menu">${state.user ? `<div class="mobile-menu-user"><strong>${esc(state.user.name)}</strong><small>${state.user.role === 'admin' ? 'Event admin' : 'Official'}</small></div>` : ''}${more.map(([p, i, text]) => `<a href="${p}" class="${page === p ? 'active' : ''}">${icon(i)} ${text}</a>`).join('')}<a href="/live" target="_blank">${icon('screen')} Open live display</a>${ownPassword() ? `<button data-action="change-password">${icon('lock')} Change password</button>` : ''}<button data-action="logout">${icon('logout')} Sign out</button></div>`;
}
function desk() {
  let selected = navItems().find(([p]) => p === page), title = selected?.[2] || (page === '/lunch' ? 'Lunch counter' : 'QR check-in');
  return `<div class="desk"><aside class="sidebar">${logo()}${mobileMenu()}<div class="workspace-label">TOURNAMENT WORKSPACE</div><nav aria-label="Tournament navigation">${navItems().map(([p, i, text, short]) => `<a href="${p}" class="${page === p ? 'active' : ''}${short ? '' : ' more'}">${icon(i)}<span>${text}</span>${short ? `<b>${short}</b>` : ''}${p === '/admin/teams' ? `<small>${state.teams.length}</small>` : ''}</a>`).join('')}</nav><div class="sidebar-bottom"><a class="side-live" href="/live" target="_blank">${icon('screen')} Open live display ${icon('external')}</a><div class="event-mini"><span class="event-mini-icon">C</span><div>CARROMIA ${esc(state.event.year)}<small>${state.demo ? 'Sample tournament' : 'Community tournament'}</small><span class="tiny-tag">${state.matches.length ? 'DRAW CREATED' : 'REGISTRATION'}</span></div></div>${ownPassword() ? `<button class="logout" data-action="change-password">${icon('lock')} Change password</button>` : ''}<button class="logout" data-action="logout">${icon('logout')} Sign out</button></div></aside><div class="desk-main"><header class="desk-header"><div class="breadcrumb">Tournament workspace <span>/</span> <strong>${esc(title)}</strong></div><div class="header-right"><span class="connection" data-connection></span><button class="avatar" data-action="${ownPassword() ? 'account' : 'logout'}" aria-label="${ownPassword() ? 'Your account' : 'Sign out of desk'}" title="${esc(state.user ? `${state.user.name} · ${state.user.role}${ownPassword() ? '' : ' · Sign out'}` : 'Sign out of desk')}">${esc((state.user?.name || 'Tournament desk').split(/\s+/).slice(0, 2).map(s => s[0]).join('').toUpperCase())}</button></div></header><main class="desk-content">${!state.teams.length ? `<div class="setup-banner"><span>${icon('coins')} <strong>Your tournament starts here.</strong> ${state.practiceAvailable ? 'Teams appear here as they register. Try the desk safely in practice mode.' : pagesMode ? 'Teams appear here as they register.' : 'Register teams or explore with a sample draw.'}</span>${state.practiceAvailable && !state.practice ? `<button class="btn small outline" data-action="practice" data-on="true">Open practice mode ${icon('arrow')}</button>` : pagesMode && !state.practice ? '' : `<button class="btn small outline" data-action="demo">Load sample tournament ${icon('arrow')}</button>`}</div>` : state.demo && !state.practice ? '<div class="demo-strip"><span class="dot"></span> SAMPLE TOURNAMENT <span>Fictional teams · Explore freely, then start a fresh event in Settings.</span></div>' : ''}${page === '/admin/teams' ? teamsPage() : page === '/admin/bracket' ? bracketPage() : page === '/admin/results' ? resultsPage() : page === '/admin/settings' ? settingsPage() : page === '/admin/officials' && canManageOfficials() ? officialsPage() : page === '/checkin' ? qrCheckinPage() : page === '/lunch' ? lunchCounterPage() : dashboard()}</main><div class="desk-footer"><span>CARROMIA ${esc(state.event.year)} · Every coin counts.</span><span>4 boards. One community.</span></div></div></div>`;
}
// Officials: loaded from the officials Edge Function and cached; refreshed after each change.
let officials = null, officialsError = '';
async function loadOfficials() {
  try { officials = (await api('officials')).officials; officialsError = ''; } catch (error) { officialsError = error.message; }
  const list = $('#officials-list'); if (list) list.innerHTML = officialsList();
  const count = $('#officials-count'); if (count) count.textContent = officials ? String(officials.length) : '';
}
function officialsList() {
  if (officialsError) return `<div class="empty compact"><h3>Couldn’t load officials</h3><p>${esc(officialsError)}</p><button class="btn outline small" data-action="officials-reload">Try again</button></div>`;
  if (!officials) return '<p class="muted officials-loading">Loading officials…</p>';
  return officials.map(o => `<article class="official-card"><div class="official-main"><strong>${esc(o.name)}${o.you ? ' <span class="you">you</span>' : ''}</strong><small>${esc(o.email)}</small><small>${o.lastSignIn ? `Last signed in ${new Date(o.lastSignIn).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}` : 'Not signed in yet'}</small></div>${badge(o.role === 'admin' ? 'Admin' : 'Official', o.role === 'admin' ? 'green' : 'neutral')}<div class="official-actions">${o.you ? '' : `<button class="btn tiny outline" data-action="official-role" data-id="${esc(o.id)}" data-role="${o.role === 'admin' ? 'official' : 'admin'}">${o.role === 'admin' ? 'Make official' : 'Make admin'}</button>`}<button class="btn tiny outline" data-action="official-reset" data-id="${esc(o.id)}">Reset password</button>${o.you ? '' : `<button class="btn tiny danger" data-action="official-remove" data-id="${esc(o.id)}">Remove</button>`}</div></article>`).join('');
}
function officialsPage() {
  if (!officials && !officialsError) loadOfficials();
  return `${pageHeading('TOURNAMENT TEAM', 'Officials', 'Who can sign in to the desk. Officials run check-in, boards and results; admins can also change settings, create the draw and manage officials.')}<div class="officials-layout"><section class="panel"><div class="section-heading"><div class="heading-inline"><h2>Officials</h2><span class="badge neutral" id="officials-count">${officials ? officials.length : ''}</span></div><button class="btn tiny outline" data-action="officials-reload">Refresh</button></div><div id="officials-list">${officialsList()}</div></section><section class="panel form-card official-form-card"><h2>Add an official</h2><form id="official-form"><label>Full name<input name="name" required maxlength="80" autocomplete="off"></label><label>Email<input name="email" type="email" required autocomplete="off" inputmode="email"></label><label>Role<select name="role"><option value="official">Official: check-in, boards and results</option><option value="admin">Admin: also settings, draw and officials</option></select></label><label>Password <span class="muted">(optional)</span><input name="password" type="text" minlength="8" autocomplete="new-password" placeholder="Leave blank to generate one"></label><p class="form-error" role="alert"></p><button class="btn primary full">${icon('plus')} Add official</button></form><p class="form-note">If the email already has an account, they keep their password unless you set a new one here.</p></section></div>`;
}
// Shows sign-in details once, to be passed on privately.
function credentialsDialog(title, name, email, password) {
  const url = pagesMode ? `${location.origin}${location.pathname}#/admin` : `${location.origin}/admin`;
  const text = `CARROMIA tournament desk\nSign in: ${url}\nEmail: ${email}\nPassword: ${password}`;
  dialog(`<div class="eyebrow">SHARE PRIVATELY</div><h2>${esc(title)}</h2><p>Give these details to ${esc(name)}. The password is shown only now.</p><dl class="credentials"><dt>Sign in at</dt><dd>${esc(url)}</dd><dt>Email</dt><dd>${esc(email)}</dd><dt>Password</dt><dd class="mono">${esc(password)}</dd></dl><div class="dialog-actions"><button class="btn outline" data-action="copy-link" data-link="${esc(text)}">Copy details</button><button class="btn primary" data-action="close">Done</button></div>`);
}
function pageHeading(eyebrow, heading, description, actions = '') { return `<div class="page-heading"><div><div class="eyebrow">${eyebrow}</div><h1>${heading}</h1><p>${description}</p></div><div class="page-actions">${actions}</div></div>`; }
function dashboard() {
  const current = active(), finished = completed(), checked = state.teams.filter(t => t.checkedIn).length, total = state.matches.filter(m => !m.bye).length;
  return `${pageHeading('THE TOURNAMENT, AT A GLANCE', 'Match control', 'Keep the boards moving. Keep the game flowing.', `<a class="btn outline" href="/live" target="_blank">${icon('screen')} Live display ${icon('external')}</a>${state.matches.length ? '' : '<button class="btn primary" data-action="draw">Create knockout draw ' + icon('bracket') + '</button>'}`)}<section class="stats"><article><div class="stat-top">Registered teams ${icon('users')}</div><strong>${state.teams.length.toString().padStart(2, '0')}<small>teams</small></strong><div class="stat-bottom"><span class="green-text">${checked} checked in</span><span>${state.teams.length - checked} expected</span></div></article><article><div class="stat-top">Boards in use ${icon('grid')}</div><strong>${current.length.toString().padStart(2, '0')}<small>/ 04</small></strong><div class="stat-bottom"><span class="green-text">${current.filter(m => m.status === 'playing').length} playing</span><span>${current.filter(m => m.status === 'called').length} called</span></div></article><article><div class="stat-top">Matches completed ${icon('check')}</div><strong>${finished.length.toString().padStart(2, '0')}<small>/ ${total.toString().padStart(2, '0')}</small></strong><div class="mini-progress"><i data-progress="${total ? finished.length / total : 0}"></i></div></article><article class="accent-stat"><div class="stat-top">Match format ${icon('clock')}</div><strong>${format().rounds}<small>round${format().rounds === 1 ? '' : 's'}</small></strong><div class="stat-bottom"><span>${format().minutes} minutes each · first to ${toWin()}.</span>${icon('arrow')}</div></article></section><section class="boards-section"><div class="section-heading"><div class="heading-inline"><h2>The boards</h2>${badge('4 BOARDS', 'neutral')}</div><span class="muted compact">${icon('clock')} ${state.event.resetMinutes} min reset between matches</span></div><div class="boards-grid">${state.boards.map(b => boardCard(b)).join('')}</div></section><div class="dashboard-bottom"><section class="panel queue-panel"><div class="section-heading"><div class="heading-inline"><h2>Match queue</h2>${badge(String(state.matches.filter(m => m.status === 'ready').length), 'neutral')}</div><a href="/admin/bracket" class="text-link compact">View bracket ${icon('arrow')}</a></div><div class="queue-tabs"><button data-filter="all" class="${queueFilter === 'all' ? 'active' : ''}">Up next</button><button data-filter="eligible" class="${queueFilter === 'eligible' ? 'active' : ''}">Ready to play</button><span>Earlier rounds first</span></div>${queueTable()}</section><section class="panel activity-panel"><div class="section-heading"><h2>From the desk</h2><span class="live-dot"></span></div><div class="activity-list">${state.activity.slice(0, 5).map((a, i) => `<div class="activity-item"><span class="activity-icon ${i === 0 ? 'recent' : ''}">${icon(i === 0 ? 'coins' : 'check')}</span><div><p>${esc(a.message)}</p><time>${time(a.at)}</time></div></div>`).join('') || '<div class="empty compact"><p>Your tournament activity will appear here.</p></div>'}</div><div class="desk-tip"><span>GOOD TO KNOW</span><p>The umpire decides each round. Mark the winner on the board as soon as it’s decided, even before the round’s time is up. The first team to win ${toWin()} round${toWin() === 1 ? '' : 's'} wins the match.</p></div></section></div>`;
}
function lastResult(boardId) { return completed().filter(m => m.board === boardId).sort((x, y) => (y.completedAt || 0) - (x.completedAt || 0))[0]; }
function winnerPanel(m) {
  const flip = m.winner !== m.teamA, loser = flip ? m.teamA : m.teamB, [won, lost] = flip ? [m.gamesB, m.gamesA] : [m.gamesA, m.gamesB];
  const how = m.walkover ? `Walkover · ${esc(m.walkover)}` : `Rounds won · best of ${format(m).rounds}`;
  const players = team(m.winner)?.players?.map(p => esc(p.name)).join(' &amp; ') || '';
  return `<div class="board-winner"><span class="winner-eyebrow">${icon('trophy')} WINNER · ${esc(m.roundName)} · ${m.id}</span><strong class="winner-name">${esc(name(m.winner))}</strong>${players ? `<small class="winner-players">${players}</small>` : ''}${m.walkover ? '<div class="winner-score"><b>W/O</b></div>' : `<div class="winner-score"><b>${won ?? '–'}</b><span>–</span><b>${lost ?? '–'}</b></div>`}<small class="winner-how">${how} · beat ${esc(name(loser))}</small></div>`;
}
// A board: the match on it (called, or a round in play or about to start), else the last winner
// while it resets, else an empty board.
function boardCard(b, publicMode = false) {
  const m = active().find(m => m.board === b.id), resetting = !m && b.availableAt > now();
  const playing = m?.status === 'playing', round = playing ? liveRound(m) : null, { rounds, minutes } = format(m), n = playing ? (m.rounds?.length || 0) + (round ? 0 : 1) : 1, timeUp = round && now() >= round.endsAt;
  const status = !m ? resetting ? 'Resetting' : 'Available' : !playing ? 'Players called' : !round ? `Round ${n} next` : timeUp ? 'Round time up' : `Round ${n} of ${rounds}`;
  const side = (id, games, light) => `<div class="board-team"><span class="team-avatar${light ? ' light' : ''}">${esc(initials(id))}</span><div><strong>${esc(name(id))}</strong><small>${esc(team(id)?.parish)}</small></div>${playing ? `<b class="round-wins" title="Rounds won">${games ?? 0}</b>` : ''}</div>`;
  const strip = playing ? `<div class="round-strip">${Array.from({ length: rounds }, (_, i) => { const r = m.rounds?.[i]; return `<span class="${r?.winner ? 'won' : r ? 'live' : ''}"><small>R${i + 1}</small>${r?.winner ? esc(initials(r.winner)) : r ? 'Live' : '–'}</span>`; }).join('')}</div>` : '';
  const timer = !playing ? `<span>READY WHEN YOU ARE · ${esc(formatLabel().toUpperCase())}</span><strong data-timer="" data-duration="${minutes}">${String(minutes).padStart(2, '0')}:00</strong>`
    : round ? `<span data-round="ROUND ${n} OF ${rounds}">ROUND ${n} OF ${rounds} · ${timeUp ? 'TIME UP · UMPIRE DECIDING' : 'TIME REMAINING'}</span><strong data-timer="${round.endsAt}">${String(minutes).padStart(2, '0')}:00</strong>`
    : `<span>ROUND ${n} OF ${rounds} · STARTING SOON</span><strong>${m.gamesA ?? 0} – ${m.gamesB ?? 0}</strong>`;
  const decided = n - 1, undo = playing && decided > 0 ? `<button class="icon-btn" data-action="undo-round" data-id="${m.id}" aria-label="Take back round ${decided}’s winner" title="Take back round ${decided}’s winner">↩</button>` : '';
  const actions = !m ? '' : !playing ? `<button class="btn primary full small" data-action="start" data-id="${m.id}">${icon('play')} Start match</button><button class="icon-btn" data-action="unassign" data-id="${m.id}" aria-label="Return ${m.id} to queue" title="Return to queue">↩</button>`
    : round ? `<small>Round ${n} won by</small>${[m.teamA, m.teamB].map(id => `<button class="btn outline small" data-action="round-winner" data-id="${m.id}" data-winner="${id}">${icon('trophy')} ${esc(name(id))}</button>`).join('')}${undo}`
    : `<button class="btn primary full small" data-action="next-round" data-id="${m.id}">${icon('play')} Start round ${n}</button>${undo}`;
  const foot = !playing ? 'Teams, please report to this board' : round ? `First to ${toWin(m)} round${toWin(m) === 1 ? '' : 's'} wins` : 'Players change seats for the next round';
  return `<article class="board-card ${m ? m.status : 'available'}${playing && !round ? ' between' : ''}"><div class="board-card-head"><span><i class="board-number">${String(b.id).padStart(2, '0')}</i> Board ${b.id}</span>${badge(status, playing ? (timeUp ? 'orange' : 'green') : 'neutral')}</div>${m ? `<div class="match-meta">${esc(m.roundName)} <span>·</span> ${m.id}</div>${side(m.teamA, m.gamesA)}<div class="versus"><span></span>VS<span></span></div>${side(m.teamB, m.gamesB, true)}<div class="timer-area">${timer}<div class="timer-track"><i data-timer-bar="${m.id}"></i></div>${strip}</div>${publicMode ? `<div class="public-board-foot">${foot}</div>` : `<div class="board-actions${round ? ' round-actions' : ''}">${actions}</div>`}` : resetting && lastResult(b.id) ? `<div class="empty-board resetting">${winnerPanel(lastResult(b.id))}<div class="reset-line">Board resets in <strong class="reset-timer" data-timer="${b.availableAt}"></strong></div></div>${!publicMode ? `<div class="board-actions"><button class="btn primary full small" data-action="board-ready" data-board="${b.id}">${icon('check')} Board ready</button></div>` : ''}` : `<div class="empty-board"><div class="empty-board-icon">${icon('grid')}</div><h3>${resetting ? 'A moment to reset.' : 'Ready for the next game.'}</h3><p>${resetting ? 'Reset the coins and prepare the board.' : 'The next great match starts here.'}</p>${resetting ? `<strong class="reset-timer" data-timer="${b.availableAt}"></strong>` : '<span class="available-dot">Board available</span>'}</div>${!publicMode ? `<div class="board-actions">${resetting ? `<button class="btn primary full small" data-action="board-ready" data-board="${b.id}">${icon('check')} Board ready</button>` : `<button class="btn outline full small" data-action="assign-board" data-board="${b.id}">${icon('plus')} Assign a match</button>`}</div>` : ''}`}</article>`;
}
function queueTable() {
  const matches = state.matches.filter(m => m.status === 'ready' && (queueFilter !== 'eligible' || !m.blockedReason));
  if (!matches.length) return `<div class="empty"><div class="empty-icon">${icon('bracket')}</div><h3>${state.matches.length ? 'The queue is clear' : 'Your first match is waiting to happen'}</h3><p>${state.matches.length ? 'New matches appear as teams advance through the draw.' : 'Register at least two teams, then create your knockout draw.'}</p></div>`;
  return `<div class="table-wrap"><table class="queue-table"><thead><tr><th>Match</th><th>Teams</th><th>Status</th><th><span class="sr-only">Action</span></th></tr></thead><tbody>${matches.slice(0, 8).map(m => `<tr><td><strong>${m.id}</strong><small>${esc(m.roundName)}</small></td><td><strong>${esc(name(m.teamA))}</strong><span class="vs-inline">vs</span><strong>${esc(name(m.teamB))}</strong></td><td>${badge(m.blockedReason || 'Ready', m.blockedReason ? 'neutral' : 'green')}</td><td><span class="row-actions"><button class="btn outline tiny" data-action="assign-match" data-id="${m.id}" ${m.blockedReason ? 'disabled' : ''}>Assign ${icon('arrow')}</button>${canCorrect() ? `<button class="btn outline tiny" data-action="walkover" data-id="${m.id}" title="Award the match without play">Walkover</button>` : ''}</span></td></tr>`).join('')}</tbody></table></div>${matches.length > 8 ? `<p class="table-note">Showing the first 8 of ${matches.length} queued matches. All matches are visible in the bracket.</p>` : ''}`;
}
function teamsPage() { const pending = state.teams.length - confirmedTeams().length; return `${pageHeading('THE PEOPLE BEHIND THE GAME', 'Teams & check-in', `${pending ? `${pending} awaiting payment. ` : ''}${state.teams.filter(t => t.checkedIn).length} of ${state.teams.length} teams checked in and ready. ${state.teams.reduce((sum, t) => sum + (t.lunch || 0), 0)} lunches pre-booked${lunchOn() ? `, ${state.teams.reduce((sum, t) => sum + (t.lunchServed || 0), 0)} served` : ''}.`, `<a class="btn primary" href="/register">${icon('plus')} Register a team</a>`)}<section class="panel"><div class="section-heading"><h2>All teams ${badge(state.teams.length, 'neutral')}</h2><label class="search-field">${icon('search')}<input id="team-search" aria-label="Search teams" placeholder="Search team, player or parish" value="${esc(teamSearch)}"></label></div><div id="team-table">${teamTable()}</div></section>`; }
// Corrections and walkovers change the bracket, so they are for admins (anyone in practice).
const canCorrect = () => state.user?.role === 'admin' || state.practice;
const canRemoveTeams = () => !state.matches.length && (state.user?.role === 'admin' || state.practice);
// Player photos for the desk: { [team id]: [photo 1, photo 2] }. Loaded when a page shows them,
// and again when a team registered since the last load (older teams simply have none).
let photos = {}, photosFor = null, photosLoading = false;
function loadPhotos() {
  if (photosLoading || (photosFor && state.teams.every(t => photosFor.has(t.id)))) return;
  photosLoading = true; const ids = new Set(state.teams.map(t => t.id));
  api('photos').then(p => { photos = p || {}; }).catch(() => {}).finally(() => { photosFor = ids; photosLoading = false; if (['/admin/teams', '/checkin', '/lunch'].includes(page) && !busy()) render(); });
}
const nameInitials = name => String(name).split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
// A tap on a photo shows the full-size one.
const playerPhoto = (t, i) => photos[t.id]?.[i] ? `<button type="button" class="photo-button" data-action="photo-full" data-id="${t.id}" data-player="${i}" aria-label="Show ${esc(t.players[i]?.name || 'the player')}’s photo"><img class="player-photo" src="${photos[t.id][i]}" alt="" width="36" height="36"></button>` : `<span class="player-photo">${esc(nameInitials(t.players[i]?.name || '?'))}</span>`;
const idLabel = p => p.idType ? `${esc(p.idType)} ··${esc(p.idLast4)}` : '';
// Pending teams: the payment to confirm. Confirmed teams: check-in.
function lunchCell(t) {
  if (!t.lunch) return '—';
  if (!lunchOn()) return `${t.lunch} booked`;
  const served = t.lunchServed || 0;
  return `${t.lunch} booked<small>${served} served</small>${t.status !== 'pending' && served < t.lunch ? `<button class="btn tiny outline" data-action="serve-lunch" data-id="${t.id}">Serve</button>` : ''}${served ? `<button class="link-button" data-action="serve-lunch" data-id="${t.id}" data-undo="true">Undo</button>` : ''}`;
}
function checkinCell(t) {
  if (t.status !== 'pending') return `<button class="btn tiny ${t.checkedIn ? 'soft' : 'outline'}" data-action="checkin" data-id="${t.id}" data-checked="${!t.checkedIn}">${icon(t.checkedIn ? 'check' : 'plus')}${t.checkedIn ? 'Checked in' : 'Check in'}</button>`;
  return `<button class="btn tiny primary" data-action="confirm-payment" data-id="${t.id}">${icon('check')}Confirm payment</button><small class="payment-ref">${t.payment?.txnRef ? `UTR ${esc(t.payment.txnRef)}` : 'No UTR given'}</small>${t.payment?.screenshot ? `<button class="link-button" data-action="payment-proof" data-id="${t.id}">View screenshot</button>` : ''}`;
}
function formCell(t) {
  if (t.status === 'pending') return '<small class="muted">After payment</small>';
  return `<span class="row-actions"><button class="btn tiny outline" data-action="team-form" data-id="${t.id}" aria-label="Download the registration form for ${esc(t.name)}">${icon('download')}PDF</button><a class="btn tiny outline" href="${esc(whatsappLink(t))}" target="_blank" rel="noopener" aria-label="Send ${esc(t.name)} its form link on WhatsApp">WhatsApp</a></span>`;
}
// Shown instead of the form download while the desk checks the payment.
function pendingConfirmation(t) {
  return `<div class="confirmation"><span class="success-icon">${icon('clock')}</span><div class="eyebrow">REGISTRATION RECEIVED</div><h2>Payment being verified.</h2><p>${esc(t.name)} is registered and waiting for the tournament desk to confirm the payment.</p><strong class="confirmation-id">${t.id}</strong><p>${t.players.map(p => esc(p.name)).join(' & ')}<br><small>${esc(t.parish)} · ${esc(t.forane)}</small></p><div class="notice confirmation-notes"><strong>Keep your team ID: ${t.id}</strong><span>Once the payment reaches the bank, the desk confirms your registration and sends the registration form link to the primary player on WhatsApp. You can also download it from the Teams page with the primary player’s mobile number.</span>${t.payment?.txnRef ? `<span>Your UPI transaction number: ${esc(t.payment.txnRef)}</span>` : ''}</div>${supportCard()}<a class="btn outline" href="/teams">Registered teams ${icon('arrow')}</a></div>`;
}
function teamTable() {
  loadPhotos();
  const teams = state.teams.filter(t => `${t.id} ${t.name} ${t.parish} ${t.forane || ''} ${t.players.map(p => p.name).join(' ')}`.toLowerCase().includes(teamSearch.toLowerCase()));
  return teams.length ? `<div class="table-wrap"><table><thead><tr><th>Team</th><th>Players</th><th>Parish</th><th>Primary contact</th><th>Lunch</th><th>Check-in</th><th>Form</th>${canRemoveTeams() ? '<th></th>' : ''}</tr></thead><tbody>${teams.map(t => `<tr><td><strong>${esc(t.name)}</strong><small>${t.id}</small>${t.status === 'pending' ? badge('Awaiting payment', 'orange') : ''}</td><td>${t.players.map((p, i) => `<span class="player-cell">${playerPhoto(t, i)}<span>${esc(p.name)}${p.idType ? `<small>${idLabel(p)}</small>` : ''}</span></span>`).join('')}</td><td>${esc(t.parish)}${t.forane ? `<small>${esc(t.centreType)} · ${esc(t.forane)}</small>` : ''}</td><td>${esc(t.players[t.primaryContact]?.mobile)}</td><td>${lunchCell(t)}</td><td>${checkinCell(t)}</td><td>${formCell(t)}</td>${canRemoveTeams() ? `<td><button class="btn tiny danger" data-action="remove-team" data-id="${t.id}" aria-label="Remove ${esc(t.name)}">Remove</button></td>` : ''}</tr>`).join('')}</tbody></table></div>` : '<div class="empty"><h3>No teams found</h3><p>Register your first team or try another search.</p></div>';
}
function bracketPage() {
  return `${pageHeading('THE ROAD TO THE TROPHY', 'Tournament bracket', 'Single elimination. One winner moves forward.', state.matches.length ? badge(`${state.teams.length} teams`, 'green') : '<button class="btn primary" data-action="draw">Create knockout draw ' + icon('bracket') + '</button>')}${state.matches.length ? bracketView() : '<section class="panel empty"><h3>Every great tournament starts with a draw.</h3><p>Add your teams, then create a randomized knockout bracket. Byes are handled automatically.</p></section>'}`;
}
// The bracket, for the desk and the public results page.
function bracketView() {
  const rounds = [...new Set(state.matches.map(m => m.round))];
  return `<div class="bracket-scroll"><div class="bracket">${rounds.map(r => `<section class="bracket-round"><div class="round-title">${esc(state.matches.find(m => m.round === r).roundName)}<small>${state.matches.filter(m => m.round === r).length} matches</small></div><div class="round-matches">${state.matches.filter(m => m.round === r).map(m => `<article class="bracket-match"><header><span>${m.id}</span>${badge(m.bye ? 'Bye' : m.status, m.status === 'completed' ? 'green' : 'neutral')}</header>${['A', 'B'].map((side, i) => `<div class="bracket-team ${m.winner && m.winner === m['team' + side] ? 'winner' : ''}"><span>${m['team' + side] ? esc(name(m['team' + side])) : m.sources.length ? (state.matches.find(source => source.id === m.sources[i])?.winner ? esc(name(state.matches.find(source => source.id === m.sources[i]).winner)) : `Winner of ${m.sources[i]}`) : 'Bye'}</span><strong>${m['games' + side] ?? (m.winner === m['team' + side] && m.winner ? '✓' : '—')}</strong></div>`).join('')}</article>`).join('')}</div></section>`).join('')}<section class="champion"><div>${icon('trophy')}</div><span>CHAMPION</span><h2>${state.matches.at(-1)?.winner ? esc(name(state.matches.at(-1).winner)) : 'Who will take the crown?'}</h2></section></div></div>`;
}
function resultsPage() { const matches = completed().sort((a, b) => b.completedAt - a.completedAt); return `${pageHeading('EVERY MATCH HAS A STORY', 'Match results', 'Official results, recorded by the tournament desk.', `<button class="btn outline" data-action="export">${icon('download')} Export results</button>`)}<section class="panel">${matches.length ? `<div class="table-wrap"><table><thead><tr><th>Match</th><th>Teams</th><th>Score</th><th>Winner</th><th>Recorded</th>${canCorrect() ? '<th><span class="sr-only">Actions</span></th>' : ''}</tr></thead><tbody>${matches.map(m => `<tr><td><strong>${m.id}</strong><small>${esc(m.roundName)} · ${m.walkover ? 'Not played' : `Board ${m.board}`}</small></td><td>${esc(name(m.teamA))}<small>vs ${esc(name(m.teamB))}</small></td><td>${m.walkover ? `<strong>Walkover</strong><small>${esc(m.walkover)}</small>` : `<strong>${m.gamesA ?? '–'} – ${m.gamesB ?? '–'}</strong><small>Rounds won</small>${m.corrected ? '<small>Corrected</small>' : ''}`}</td><td><span class="winner-label">${icon('trophy')} ${esc(name(m.winner))}</span></td><td>${time(m.completedAt)}<small>${esc(m.official)}</small></td>${canCorrect() ? `<td><button class="btn tiny outline" data-action="${m.walkover ? 'undo-walkover' : 'correct-result'}" data-id="${m.id}">${m.walkover ? 'Undo walkover' : 'Correct'}</button></td>` : ''}</tr>`).join('')}</tbody></table></div>` : '<div class="empty"><div class="empty-icon">' + icon('trophy') + '</div><h3>The best is yet to come.</h3><p>Completed match results will appear here.</p></div>'}</section>`; }
function settingsPage() { const e = state.event; return `${pageHeading('SET THE STAGE', 'Event settings', 'The details that keep your tournament running smoothly.')}<div class="settings-grid"><section class="panel settings-panel"><h2>Event details & timing</h2><form id="settings-form"><div class="form-row"><label>Event name<input name="name" required value="${esc(e.name)}"></label><label>Year<input name="year" required value="${esc(e.year)}"></label></div><label>Venue<input name="venue" required value="${esc(e.venue)}"></label><div class="form-row"><label>Event date<input name="date" type="date" value="${esc(e.date)}"></label><label>Start time<input name="startTime" type="time" value="${esc(e.startTime || '')}"></label></div><div class="form-row"><label>Rounds per match<select name="gamesPerMatch">${[1, 3, 5].map(n => `<option value="${n}" ${format().rounds === n ? 'selected' : ''}>${n === 1 ? '1 round' : `Best of ${n} rounds`}</option>`).join('')}</select></label><label>Round (minutes)<input name="gameMinutes" type="number" min="1" max="30" required value="${format().minutes}"></label></div><div class="form-row"><label>Board reset (minutes)<input name="resetMinutes" type="number" min="0" max="30" required value="${e.resetMinutes}"></label><label>Team rest (minutes)<input name="restMinutes" type="number" min="0" max="60" required value="${e.restMinutes}"></label></div><p class="form-note">The umpire decides each round and an official marks its winner on the board; the first team to win most of the rounds wins the match. Format changes apply to matches started from now on. Reset and rest periods affect board availability and the queue.</p><div class="form-row"><label>Team slots<input name="maxTeams" type="number" min="2" max="128" required value="${e.maxTeams}"></label><label>Teams per parish<input name="maxTeamsPerParish" type="number" min="1" max="128" required value="${e.maxTeamsPerParish}"></label></div><div class="form-row"><label>Registration deadline<input name="registrationDeadline" type="date" value="${esc(e.registrationDeadline)}"></label><label>Entry fee per team (₹)<input name="entryFee" type="number" min="0" max="100000" required value="${e.entryFee}"></label></div><p class="form-note">Registration closes at the end of the deadline day, when every slot is taken, or when the draw is created. The deadline does not apply in practice mode.</p><label class="checkbox-label"><input name="registrationOpen" type="checkbox" ${e.registrationOpen ? 'checked' : ''} ${state.matches.length ? 'disabled' : ''}> Registration open</label>${state.matches.length ? '<p class="form-note">Registration is locked after the draw is created.</p>' : ''}<h2 class="settings-subhead">Payment</h2><label class="checkbox-label"><input name="paymentRequired" type="checkbox" ${e.paymentRequired ? 'checked' : ''}> Collect the entry fee by UPI at registration</label><p class="form-note">Teams pay to this UPI QR code and give the transaction number or a screenshot. Their registration stays pending, without a form to download, until an official confirms the payment in Teams.</p><div class="upi-setting"><img id="upi-qr-preview" class="upi-qr" ${e.upiQr ? `src="${e.upiQr}"` : 'hidden'} alt="UPI QR code" width="140" height="140"><div><label>UPI QR code<input name="upiQrFile" type="file" accept="image/*"></label><input type="hidden" name="upiQr" value="${esc(e.upiQr || '')}"><button type="button" class="btn tiny outline" data-action="remove-upi-qr" ${e.upiQr ? '' : 'hidden'}>Remove QR code</button></div></div><label>UPI ID (optional, for a “Pay with a UPI app” button on phones)<input name="upiId" maxlength="100" value="${esc(e.upiId || '')}" placeholder="e.g. parish@okaxis"></label><h2 class="settings-subhead">Lunch</h2><label class="checkbox-label"><input name="lunchCoupons" type="checkbox" ${e.lunchCoupons ? 'checked' : ''}> Print lunch coupons on the registration form and scan them at the lunch counter</label><p class="form-note">Each team gets a tear-off coupon for every lunch it booked, with a QR code. At the lunch counter an official scans the coupon and marks the lunch as served, so each coupon is used once.</p><h2 class="settings-subhead">Support</h2><p class="form-note">Support contacts appear on the registration page and on each team’s registration form.</p>${[1, 2, 3].map(n => `<div class="form-row"><label>Contact ${n} name<input name="contactName${n}" maxlength="60" value="${esc(e.contacts?.[n - 1]?.name || '')}"></label><label>Phone<input name="contactPhone${n}" type="tel" maxlength="20" value="${esc(e.contacts?.[n - 1]?.phone || '')}"></label></div>`).join('')}<p class="form-error" role="alert"></p><button class="btn primary" type="submit">Save settings ${icon('check')}</button></form></section><aside><section class="panel settings-panel"><div class="eyebrow">THE RULES OF PLAY</div><h2>Simple. Fair. Clear.</h2><ul class="rules-list"><li>Open doubles, thumbing game only</li><li>${format().rounds === 1 ? 'One round' : `Best of ${format().rounds} rounds; win ${toWin()}`}</li><li>${format().minutes} minutes per round</li><li>The umpire decides each round</li><li>Officials mark each round’s winner</li><li>Single-elimination knockout</li></ul><a class="text-link" href="/rules" target="_blank">All tournament rules ${icon('external')}</a></section><section class="panel settings-panel"><h2>Take the app with you</h2><p>Install CARROMIA from your browser’s app menu when supported.</p><button class="btn outline" data-action="install">${icon('download')} Install app</button></section>${pagesMode && e.practiceOff && !state.practice ? `<section class="panel settings-panel practice-panel"><h2>Practice mode</h2><p>Practice mode is turned off. No device can open it, and practice links open the real event.</p>${isEventAdmin() ? `<button class="btn primary small" data-action="practice-mode" data-on="true">Turn practice mode back on</button>` : ''}</section>` : ''}${state.practiceAvailable ? `<section class="panel settings-panel practice-panel"><h2>Practice mode</h2><p>${state.practice ? 'This device is in practice mode. Everything here uses the practice event; the real event and its registrations are never touched.' : 'Rehearse the whole event on a separate practice tournament, on this and other devices. The public site and real registrations are never affected.'}</p>${state.practice ? `<div class="practice-links"><p class="form-note">Open these on other devices. They stay in practice mode until someone taps <strong>Exit practice</strong>.</p><div class="practice-link"><img data-practice-qr="/live" alt="QR code: TV / big screen" width="96" height="96"><div><strong>TV / big screen</strong><small>Live boards and winners</small><code>${esc(state.practiceLinks.live)}</code><button class="btn tiny outline" data-action="copy-link" data-link="${esc(state.practiceLinks.live)}">Copy link</button></div></div><div class="practice-link"><img data-practice-qr="/register" alt="QR code: Phones: registration" width="96" height="96"><div><strong>Phones: registration</strong><small>Players register practice teams</small><code>${esc(state.practiceLinks.register)}</code><button class="btn tiny outline" data-action="copy-link" data-link="${esc(state.practiceLinks.register)}">Copy link</button></div></div><div class="practice-link"><img data-practice-qr="/admin" alt="QR code: Official phones: desk" width="96" height="96"><div><strong>Official phones: desk</strong><small>Sign in, then check in, start and score</small><code>${esc(state.practiceLinks.desk)}</code><button class="btn tiny outline" data-action="copy-link" data-link="${esc(state.practiceLinks.desk)}">Copy link</button></div></div></div><div class="practice-actions"><button class="btn outline small" data-action="reset">Start empty practice (registration open)</button><button class="btn outline small" data-action="demo">Load sample tournament</button></div>` : ''}<button class="btn ${state.practice ? 'danger' : 'primary'} small" data-action="practice" data-on="${!state.practice}">${state.practice ? 'Exit practice mode' : 'Open practice mode'}</button>${isEventAdmin() && !state.practice ? `<button class="btn outline small" data-action="practice-mode" data-on="false">Turn off for all devices</button>` : ''}</section>` : ''}${state.practice ? '' : '<section class="panel settings-panel danger-zone"><h2>Start a fresh event</h2><p>Clear all teams, matches, and results. Event details are kept and registration reopens. Download a backup first.</p><button class="btn outline small" data-action="backup">Download backup</button><button class="btn danger small" data-action="reset">Reset event</button></section>'}</aside></div>`; }
function qrCheckinPage() { const token = new URLSearchParams(pagesMode ? location.hash.split('?')[1] : location.search).get('token'); return `${pageHeading('WELCOME TO THE TOURNAMENT', 'QR check-in', 'Confirm this team’s arrival at the tournament desk.')}<section class="panel empty">${icon('users')}<h2>Check in this team</h2>${checkinTeam(token)}<button class="btn primary" data-action="qr-checkin" data-token="${esc(token || '')}">Confirm team check-in ${icon('check')}</button></section>`; }
// The lunch counter: a scanned lunch coupon's team, and how many of its lunches are still to be served.
function lunchCounterPage() {
  const token = new URLSearchParams(pagesMode ? location.hash.split('?')[1] : location.search).get('token'), t = token && state.teams.find(t => t.checkinToken === token);
  const heading = pageHeading('ENJOY YOUR MEAL', 'Lunch counter', 'Scan a team’s lunch coupon and serve each booked lunch once.');
  if (!lunchOn()) return `${heading}<section class="panel empty">${icon('coins')}<h2>Lunch coupons are turned off</h2><p>An event admin can turn them on in Event settings.</p></section>`;
  if (!t) return `${heading}<section class="panel empty">${icon('coins')}<h2>Coupon not recognised</h2><p>This QR code doesn’t match a registered team. Find the team ID printed on the coupon in Teams.</p></section>`;
  loadPhotos();
  const served = t.lunchServed || 0, left = (t.lunch || 0) - served;
  const serve = n => `<button class="btn primary" data-action="serve-lunch" data-token="${esc(token)}" data-count="${n}">${icon('check')} ${n === 2 ? 'Serve both lunches' : 'Serve 1 lunch'}</button>`;
  const status = !t.lunch ? '<div class="notice">No lunch was booked for this team.</div>'
    : t.status === 'pending' ? '<div class="notice">Payment not confirmed yet. Confirm it in Teams before serving lunch.</div>'
    : `<p class="lunch-count"><strong>${served} of ${t.lunch}</strong> lunch${t.lunch > 1 ? 'es' : ''} served</p>${left ? `<div class="lunch-actions">${serve(1)}${left > 1 ? serve(2) : ''}</div>` : '<div class="notice">Every lunch booked for this team has been served.</div>'}`;
  return `${heading}<section class="panel empty"><p><strong>${esc(t.name)}</strong> · ${t.id}<br>${esc(t.parish)}</p><div class="checkin-players">${t.players.map((p, i) => `<div>${playerPhoto(t, i).replace('player-photo', 'player-photo large').replace('width="36" height="36"', 'width="96" height="96"')}<strong>${esc(p.name)}</strong></div>`).join('')}</div>${status}</section>`;
}
// The scanned team, with photos and ID details to compare with the players and IDs at the desk.
function checkinTeam(token) {
  const t = token && state.teams.find(t => t.checkinToken === token);
  if (!t) return '<p>The QR token will be verified against the registered teams.</p>';
  loadPhotos();
  return `${t.status === 'pending' ? `<div class="notice">Payment not confirmed yet. Confirm it in Teams before checking this team in.</div>` : ''}<p><strong>${esc(t.name)}</strong> · ${t.id}${t.checkedIn ? ' · already checked in' : ''}<br>${esc(t.parish)}${t.forane ? ` · ${esc(t.forane)}` : ''}</p><div class="checkin-players">${t.players.map((p, i) => `<div>${playerPhoto(t, i).replace('player-photo', 'player-photo large').replace('width="36" height="36"', 'width="96" height="96"')}<strong>${esc(p.name)}</strong><small>${idLabel(p) || 'No ID details'}</small></div>`).join('')}</div><p class="form-note">Check each player’s face and ID proof, and the attested registration form.</p>`;
}
function live() {
  const ready = state.matches.filter(m => m.status === 'ready').slice(0, 4), final = state.matches.at(-1);
  return `<div class="live-screen"><header class="live-header">${logo()}<div class="live-title">${esc(state.event.venue)}<small>THE COMMUNITY CARROM TOURNAMENT · ${esc(state.event.year)}</small></div><div>${state.practice ? badge('PRACTICE', 'orange') : badge('LIVE TOURNAMENT', 'green')}<span class="connection" data-connection></span></div></header><main><div class="live-heading"><div><div class="eyebrow">EVERY COIN COUNTS</div><h1>${final?.winner ? 'We have a champion.' : 'Four boards. All the action.'}</h1><p>${final?.winner ? `Congratulations, ${esc(name(final.winner))}!` : 'Find your team. Follow the game. Cheer them on.'}</p></div><a class="live-qr" data-link-qr="/results" hidden><img alt="QR code: results on your phone" width="132" height="132"><div><span>ON YOUR PHONE</span><strong class="qr-scan">Scan for results</strong><strong class="qr-tap">Open live results ›</strong><small>Every result and the bracket, updated live.</small><code></code></div></a></div><div class="boards-grid live-boards">${state.boards.map(b => boardCard(b, true)).join('')}</div><section class="live-next"><div><span class="eyebrow">GET READY</span><h2>Up next</h2></div>${ready.length ? ready.map(m => `<article><span>${m.id} · ${esc(m.roundName)}</span><strong>${esc(name(m.teamA))}<small>vs</small>${esc(name(m.teamB))}</strong><p>${esc(m.blockedReason || 'Please stay near the playing area')}</p></article>`).join('') : '<p>Next matches will appear as the tournament progresses.</p>'}</section></main><footer><span>${esc(formatLabel())}</span><span class="live-foot-links">${pagesMode && (state.practice || !state.event.practiceOff) ? `<button class="practice-switch" data-action="practice" data-on="${!state.practice}">${state.practice ? 'Exit practice mode' : 'Switch to practice mode'}</button>` : ''}<a href="/results">Results ${icon('arrow')}</a><a href="/">Back to tournament ${icon('arrow')}</a></span></footer></div>`;
}
function dialog(content) { modal.innerHTML = `<button class="modal-close" data-action="close" aria-label="Close dialog">×</button>${content}`; modal.showModal(); }
function assignDialog(matchId, boardId) {
  const free = state.boards.filter(b => b.availableAt <= now() && !active().some(m => m.board === b.id));
  const ready = state.matches.filter(m => m.status === 'ready' && !m.blockedReason);
  dialog(`<div class="eyebrow">LET’S GET THE NEXT GAME GOING</div><h2>Assign a match</h2><p>Both teams must be checked in and available.</p>${free.length && ready.length ? `<form id="assign-form"><label>Match<select name="id">${ready.filter(m => !matchId || m.id === matchId).map(m => `<option value="${m.id}">${m.id} · ${esc(name(m.teamA))} vs ${esc(name(m.teamB))}</option>`).join('')}</select></label><label>Board<select name="board">${free.filter(b => !boardId || b.id === Number(boardId)).map(b => `<option value="${b.id}">Board ${b.id}</option>`).join('')}</select></label><p class="form-error" role="alert"></p><button class="btn primary full">Call teams to board ${icon('arrow')}</button></form>` : '<div class="notice">' + (!free.length ? 'All boards are occupied or resetting. A board must be available before assigning a match.' : 'No eligible matches yet. Check in both teams and allow any rest period to finish.') + '</div>'}`);
}
function teamOptions(m, selected = '') { return [m.teamA, m.teamB].map(id => `<option value="${id}" ${id === selected ? 'selected' : ''}>${esc(name(id))}</option>`).join(''); }
function walkoverDialog(id) {
  const m = state.matches.find(m => m.id === id);
  dialog(`<div class="eyebrow">${m.id} · ${esc(m.roundName)}</div><h2>Award a walkover</h2><p>The match is not played. The team you choose advances as if it had won; the other team is out of the tournament.</p><form id="walkover-form" data-id="${m.id}"><label>Team that advances<select name="winner" required><option value="">Choose the team</option>${teamOptions(m)}</select></label><label>Reason<input name="reason" maxlength="300" placeholder="Opponent did not show" autocomplete="off"></label><p class="form-error" role="alert"></p><button class="btn danger full">Award walkover ${icon('check')}</button></form>`);
}
function correctDialog(id) {
  const m = state.matches.find(m => m.id === id);
  dialog(`<div class="eyebrow">${m.id} · ${esc(m.roundName)}</div><h2>Correct the result</h2><p>Choose who won each round, in order, up to the round that decided the match. The winner is worked out again and later rounds are updated. This is possible only until the winner’s next match is called.</p><form id="correct-form" data-id="${m.id}">${Array.from({ length: format(m).rounds }, (_, i) => `<label>Round ${i + 1} winner<select name="round${i + 1}"><option value="">Not played</option>${teamOptions(m, m.rounds?.[i]?.winner)}</select></label>`).join('')}<p class="form-error" role="alert"></p><button class="btn primary full">Save corrected result ${icon('check')}</button></form>`);
}
// Asks before marking a round, since the deciding round also ends the match.
function roundWinnerDialog(id, winner) {
  const m = state.matches.find(m => m.id === id), n = m.rounds.length, a = m.gamesA + (winner === m.teamA), b = m.gamesB + (winner === m.teamB), ends = Math.max(a, b) >= toWin(m);
  dialog(`<div class="eyebrow">${m.id} · BOARD ${m.board} · ROUND ${n}</div><h2>${esc(name(winner))} won round ${n}?</h2><p>${ends ? `That makes it ${Math.max(a, b)} – ${Math.min(a, b)} in rounds. <strong>This ends the match</strong> and ${esc(name(winner))} advances.` : `The score becomes ${esc(name(m.teamA))} ${a} – ${b} ${esc(name(m.teamB))}. Start round ${n + 1} when the players are ready.`}</p><div class="dialog-actions"><button class="btn outline" data-action="close">Cancel</button><button class="btn primary" data-action="confirm-round-winner" data-id="${m.id}" data-winner="${esc(winner)}">${icon('check')} ${ends ? 'Confirm and end match' : 'Confirm round winner'}</button></div>`);
}
function undoRoundDialog(id) {
  const m = state.matches.find(m => m.id === id), running = Boolean(liveRound(m)), n = m.rounds.length - (running ? 1 : 0);
  dialog(`<div class="eyebrow">${m.id} · BOARD ${m.board}</div><h2>Take back round ${n}’s winner?</h2><p>Round ${n} goes back into play on its own timer${running ? `, and round ${n + 1} is cancelled` : ''}. Then mark the right winner.</p><div class="dialog-actions"><button class="btn outline" data-action="close">Keep</button><button class="btn danger" data-action="confirm-undo-round" data-id="${m.id}">Take back</button></div>`);
}
function download(filename, content, mime = 'application/json') { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([content], { type: mime })); a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
document.addEventListener('keydown', event => { if (event.key === 'Escape' && menuOpen) setMenu(false); });
document.addEventListener('click', async event => {
  if (menuOpen && !event.target.closest('.menu-toggle')) setMenu(false);
  const link = event.target.closest('a'); if (link && link.origin === location.origin && !link.target && !link.download && !event.ctrlKey && !event.metaKey) { event.preventDefault(); navigate(pagesMode ? link.hash.slice(1) || '/' : link.pathname + link.search); return; }
  const filter = event.target.closest('[data-filter]'); if (filter) { queueFilter = filter.dataset.filter; render(); return; }
  const b = event.target.closest('[data-action]'); if (!b) return; const { action, id } = b.dataset;
  try {
    if (action === 'close') return modal.close();
    if (action === 'retry') return sync();
    if (action === 'menu') return setMenu(!menuOpen);
    if (action === 'account') return accountDialog();
    if (action === 'change-password') return passwordDialog();
    if (action === 'assign-board') return assignDialog(null, b.dataset.board);
    if (action === 'assign-match') return assignDialog(id);
    if (action === 'round-winner') return roundWinnerDialog(id, b.dataset.winner);
    if (action === 'undo-round') return undoRoundDialog(id);
    if (action === 'practice-mode' && b.dataset.on === 'false') return dialog(`<h2>Turn off practice mode for all devices?</h2><p>No one can open practice mode, and devices in it now (a TV, phones, the desk) go back to the real event. Practice links and QR codes open the real event. Practice data is kept, and you can turn practice mode back on here.</p><div class="dialog-actions"><button class="btn outline" data-action="close">Keep it on</button><button class="btn danger" data-action="confirm-practice-mode">Turn off practice mode</button></div>`);
    if (action === 'walkover') return walkoverDialog(id);
    if (action === 'correct-result') return correctDialog(id);
    if (action === 'undo-walkover') return dialog(`<h2>Undo the walkover for ${esc(id)}?</h2><p>The match returns to the queue and later rounds are updated.</p><div class="dialog-actions"><button class="btn outline" data-action="close">Keep</button><button class="btn danger" data-action="confirm-undo-walkover" data-id="${esc(id)}">Undo walkover</button></div>`);
    if (action === 'draw') return dialog(`<div class="eyebrow">THE ROAD TO THE FINAL</div><h2>Create the knockout draw?</h2><p>${confirmedTeams().length} confirmed teams will be randomly placed into a single-elimination bracket. Byes advance automatically. Registration closes once the draw is created.</p>${state.teams.length > confirmedTeams().length ? `<p class="form-note"><strong>${state.teams.length - confirmedTeams().length} team(s) awaiting payment will be left out.</strong> Confirm their payments first if they should play.</p>` : ''}<p class="form-note">Check your team list first. Changing the draw requires starting a fresh event.</p><button class="btn primary full" data-action="confirm-draw" ${confirmedTeams().length < 2 ? 'disabled' : ''}>Create draw for ${confirmedTeams().length} teams ${icon('bracket')}</button>`);
    if (action === 'reset') return dialog((state.practice ? '<h2>Start an empty practice event?</h2><p>All practice teams, matches and results are cleared and practice registration opens, so you can rehearse the full flow. The real event is not affected.</p>' : '<h2>Start a fresh event?</h2><p>This clears all teams, matches and results. Event settings are kept. Download a backup from Settings before continuing.</p>') + '<form id="reset-form"><label>Type RESET to confirm<input name="confirm" required pattern="RESET" autocomplete="off"></label><p class="form-error" role="alert"></p><button class="btn danger full">Clear tournament data</button></form>');
    if (action === 'backup') { const data = await api('backup'); download('carromia-backup.json', JSON.stringify(data, null, 2)); return toast('Backup downloaded. Contains team contact details.'); }
    if (action === 'export') { download('carromia-results.json', JSON.stringify(completed().map(m => ({ ...m, teamAName: name(m.teamA), teamBName: name(m.teamB), winnerName: name(m.winner) })), null, 2)); return; }
    if (action === 'install') { if (installPrompt) { await installPrompt.prompt(); installPrompt = null; } else toast('Use your browser’s menu → Install app or Add to Home Screen.'); return; }
    b.disabled = true;
    if (action === 'team-download') { b.disabled = false; return teamDownloadDialog(id); }
    if (action === 'remove-upi-qr') { b.disabled = false; $('#settings-form [name=upiQr]').value = ''; $('#upi-qr-preview').hidden = true; b.hidden = true; return; }
    if (action === 'photo-full') { const t = team(id), p = Number(b.dataset.player), { url } = await api(`photo-full?team=${encodeURIComponent(id)}&player=${p}`); b.disabled = false; return dialog(`<div class="eyebrow">${esc(id)} · ${esc(t?.name)}</div><h2>${esc(t?.players[p]?.name || 'Player photo')}</h2><img class="payment-proof" src="${url}" alt="Photo of ${esc(t?.players[p]?.name || 'the player')}">`); }
    if (action === 'payment-proof') { const proofs = await api('payment-proofs'); b.disabled = false; return dialog(proofs[id] ? `<div class="eyebrow">${esc(id)}</div><h2>Payment screenshot</h2><img class="payment-proof" src="${proofs[id]}" alt="Payment screenshot for ${esc(id)}">` : '<h2>No screenshot</h2><p>This team gave only a transaction number.</p>'); }
    if (action === 'confirm-payment') { const t = team(id); b.disabled = false; return dialog(`<div class="eyebrow">${esc(id)} · ${money(t.payment?.amount ?? state.event.entryFee)}</div><h2>Confirm ${esc(t.name)}’s payment?</h2><p>Check that the payment has reached the bank${t.payment?.txnRef ? `: UTR <strong>${esc(t.payment.txnRef)}</strong>` : ''}. The team can then download its registration form and check in.</p><div class="dialog-actions"><button class="btn outline" data-action="close">Not yet</button><button class="btn primary" data-action="confirm-payment-yes" data-id="${esc(id)}">${icon('check')} Payment received</button></div>`); }
    if (action === 'confirm-payment-yes') { await api('confirm-payment', { id }); modal.close(); toast('Payment confirmed. Send the team its form on WhatsApp.'); await sync(); return; }
    if (action === 'registration-pdf') { const r = lastRegistration; await saveRegistrationPdf(r.team, r.qr, r.photos, r.lunchQr); b.disabled = false; return; }
    if (action === 'team-form') {
      const t = team(id), [qr, all, lunchQr] = await Promise.all([t.checkinToken ? api(`qr?token=${encodeURIComponent(t.checkinToken)}`).then(r => r.qr, () => '') : '', api('photos').catch(() => ({})), lunchQrFor(t)]);
      await saveRegistrationPdf(t, qr, all[t.id] || [], lunchQr); b.disabled = false; return;
    }
    if (action === 'logout') { await api('logout', {}); if (modal.open) modal.close(); await sync(false); navigate('/admin'); return; }
    if (action === 'demo') await api('demo', {});
    if (action === 'confirm-draw') { await api('draw', {}); modal.close(); }
    if (action === 'start') await api('start', { id });
    if (action === 'next-round') await api('next-round', { id });
    if (action === 'confirm-round-winner') { await api('round-winner', { id, winner: b.dataset.winner }); modal.close(); toast('Round winner marked.'); }
    if (action === 'confirm-undo-round') { await api('undo-round', { id }); modal.close(); toast('Round winner taken back. The round is in play again.'); }
    if (action === 'unassign') await api('unassign', { id });
    if (action === 'officials-reload') { officials = null; officialsError = ''; render(); return; }
    if (action === 'official-role') { await api('official-update', { id, role: b.dataset.role }); toast(b.dataset.role === 'admin' ? 'They are now an admin.' : 'They are now an official.'); await loadOfficials(); return; }
    if (action === 'official-reset') { const o = officials?.find(o => o.id === id); return dialog(`<h2>Reset ${esc(o?.name)}’s password?</h2><p>A new temporary password is created and their current one stops working.</p><div class="dialog-actions"><button class="btn outline" data-action="close">Cancel</button><button class="btn danger" data-action="confirm-official-reset" data-id="${esc(id)}">Reset password</button></div>`); }
    if (action === 'confirm-official-reset') { const o = officials?.find(o => o.id === id), { password } = await api('official-reset', { id }); credentialsDialog('New password', o?.name || 'the official', o?.email || '', password); return; }
    if (action === 'official-remove') { const o = officials?.find(o => o.id === id); return dialog(`<div class="eyebrow">${esc(o?.email)}</div><h2>Remove ${esc(o?.name)}?</h2><p>Their account is deleted and they can no longer sign in. Their past actions stay in the audit log.</p><div class="dialog-actions"><button class="btn outline" data-action="close">Keep</button><button class="btn danger" data-action="confirm-official-remove" data-id="${esc(id)}">Remove official</button></div>`); }
    if (action === 'confirm-official-remove') { await api('official-remove', { id }); modal.close(); toast('Official removed.'); await loadOfficials(); return; }
    if (action === 'remove-team') { const t = team(id); return dialog(`<div class="eyebrow">${esc(id)}</div><h2>Remove ${esc(t?.name)}?</h2><p>The team and its players’ contact details are deleted from the event. This can’t be undone. Their team ID won’t be reused.</p><div class="dialog-actions"><button class="btn outline" data-action="close">Keep team</button><button class="btn danger" data-action="confirm-remove" data-id="${esc(id)}">Remove team</button></div>`); }
    if (action === 'confirm-undo-walkover') { await api('undo-walkover', { id }); modal.close(); toast('Walkover undone. The match is back in the queue.'); }
    if (action === 'confirm-remove') { await api('remove-team', { id }); modal.close(); toast('Team removed.'); }
    if (action === 'practice-mode') { await api('practice-mode', { on: true }); toast('Practice mode is on again.'); }
    if (action === 'confirm-practice-mode') { await api('practice-mode', { on: false }); modal.close(); toast('Practice mode is off for all devices.'); }
    if (action === 'practice') {
      await api('practice', { on: b.dataset.on === 'true' });
      // Drop ?practice=1 from the address so a reload doesn't switch practice back on.
      if (pagesMode && location.search) history.replaceState({}, '', location.pathname + location.hash);
      toast(b.dataset.on === 'true' ? 'Practice mode on. The real event is untouched.' : 'Back to the real event.');
    }
    if (action === 'copy-link') { try { await navigator.clipboard.writeText(b.dataset.link); toast(b.dataset.copied || 'Link copied.'); } catch { toast(b.dataset.link); } b.disabled = false; return; }
    if (action === 'board-ready') { await api('board-ready', { board: b.dataset.board }); toast(`Board ${b.dataset.board} is ready for the next match.`); }
    if (action === 'checkin') await api('checkin', { id, checkedIn: b.dataset.checked === 'true' });
    if (action === 'serve-lunch') {
      const undo = b.dataset.undo === 'true', t = id ? team(id) : state.teams.find(t => t.checkinToken === b.dataset.token);
      await api('serve-lunch', { id: id || undefined, token: b.dataset.token, count: Number(b.dataset.count) || 1, undo });
      toast(undo ? 'One lunch marked as not served.' : `Lunch served for ${t?.name ?? 'the team'}.`);
    }
    if (action === 'qr-checkin') { await api('checkin', { token: b.dataset.token }); toast('Team checked in. Welcome to CARROMIA!'); }
    await sync();
  } catch (error) { toast(error.message, true); b.disabled = false; }
});
document.addEventListener('input', event => { if (event.target.id === 'public-result-search') { resultSearch = event.target.value; $('#public-result-list').innerHTML = publicResultList(); } if (event.target.id === 'public-team-search') { publicSearch = event.target.value; $('#public-team-list').innerHTML = publicTeamCards(); } if (event.target.id === 'team-search') { teamSearch = event.target.value; $('#team-table').innerHTML = teamTable(); labelTables($('#team-table')); } });
document.addEventListener('change', async event => {
  const el = event.target;
  if (el.name === 'forane' && el.form?.id === 'registration-form') { const centre = el.form.elements.centre; centre.innerHTML = el.value ? centreOptions(el.value) : '<option value="">Choose the forane first</option>'; centre.disabled = !el.value; }
  if (el.name === 'upiQrFile') {
    try { const data = await upiQrData(el.files[0]); if (data) { const { url } = await api('upi-qr', { image: data }); $('#settings-form [name=upiQr]').value = url; const preview = $('#upi-qr-preview'); preview.src = data; preview.hidden = false; $('[data-action=remove-upi-qr]').hidden = false; toast('QR code uploaded. Save settings to use it.'); } }
    catch (error) { el.value = ''; toast(error.message, true); }
  }
  if (el.dataset?.photo) {
    const preview = $(`#photo-preview-${el.dataset.photo}`);
    try { preview.src = await photoData(el.files[0]); preview.hidden = false; } catch (error) { preview.hidden = true; if (el.files.length) { el.value = ''; toast(error.message, true); } }
  }
});
document.addEventListener('submit', async event => {
  event.preventDefault(); const form = event.target, fields = Object.fromEntries(new FormData(form)); const button = $('button[type="submit"], button:not([type])', form), errorEl = $('.form-error', form); if (button) button.disabled = true; if (errorEl) errorEl.textContent = '';
  try {
    if (form.getAttribute('id') === 'official-form') {
      const added = await api('official-add', fields); form.reset(); await loadOfficials();
      if (added.password) credentialsDialog('Official added', added.official.name, added.official.email, added.password); else toast(`${added.official.name} added. They keep their existing password.`);
      return;
    }
    if (form.getAttribute('id') === 'password-form') {
      if (fields.password !== fields.confirm) throw new Error('The two new passwords don’t match.');
      await api('change-password', { current: fields.current, password: fields.password }); modal.close(); toast('Password changed. Use the new one next time you sign in.'); return;
    }
    if (form.getAttribute('id') === 'login-form') { await api('login', fields); await sync(); return; }
    if (form.getAttribute('id') === 'registration-form') {
      if (state.event.paymentRequired && !String(fields.txnRef || '').trim() && !fields.paymentShot?.size) throw new Error('Enter the UPI transaction number or add a payment screenshot.');
      const [centreType, ...parish] = String(fields.centre || '').split('|'), [photos, thumbs] = await Promise.all([Promise.all([fullPhoto(fields.photo1), fullPhoto(fields.photo2)]), Promise.all([photoData(fields.photo1), photoData(fields.photo2)])]);
      const payment = state.event.paymentRequired ? { txnRef: fields.txnRef, screenshot: fields.paymentShot?.size ? await fullPhoto(fields.paymentShot) : '' } : undefined;
      const player = n => ({ name: fields[`player${n}`], mobile: fields[`mobile${n}`], idType: fields[`idType${n}`], idLast4: fields[`idLast4${n}`], photo: photos[n - 1], thumb: thumbs[n - 1] });
      const { team: t } = await api('register', { name: fields.name, forane: fields.forane, parish: parish.join('|'), centreType, primaryContact: fields.primaryContact, lunch: Number(fields.lunch) || 0, adults: fields.adults === 'on', players: [player(1), player(2)], payment });
      if (t.status === 'pending') { form.closest('.form-card').innerHTML = pendingConfirmation(t); return; }
      let qr = ''; try { qr = (await api(`qr?token=${t.checkinToken}`)).qr; } catch {}
      lastRegistration = { team: t, qr, photos: thumbs, lunchQr: await lunchQrFor(t) };
      form.closest('.form-card').innerHTML = `<div class="confirmation"><span class="success-icon">${icon('check')}</span><div class="eyebrow">YOU’RE ON THE TEAM SHEET</div><h2>See you at the board.</h2><p>${esc(t.name)} is registered.</p><strong class="confirmation-id">${t.id}</strong><p>${t.players.map(p => esc(p.name)).join(' & ')}<br><small>${esc(t.parish)} · ${esc(t.forane)}</small></p>${qr ? `<img class="qr" src="${qr}" width="220" height="220" alt="Check-in QR code for ${t.id}">` : ''}<p class="form-note">Save your team ID${qr ? ' and QR code' : ''} for check-in at the tournament desk. Reporting time is 9:00 AM.</p><button class="btn primary" type="button" data-action="registration-pdf">${icon('download')} Download registration form (PDF)</button><div class="notice confirmation-notes"><strong>Entry fee ${money(state.event.entryFee)} per team${t.lunch ? ` · lunch booked for ${t.lunch === 2 ? 'both players' : '1 player'}` : ''}</strong><span>Print the registration form. Both players sign it, and your Parish Priest attests it with the parish seal. The rules are included.</span>${lunchOn() && t.lunch ? `<span>Tear off the lunch coupon${t.lunch > 1 ? 's' : ''} at the bottom of the form and bring ${t.lunch > 1 ? 'them' : 'it'} to the lunch counter, where ${t.lunch > 1 ? 'each is' : 'it is'} scanned.</span>` : ''}<span>Bring on the day:</span><ol>${documents.map(line => `<li>${esc(line)}</li>`).join('')}</ol></div>${qr ? `<a class="btn outline" href="${qr}" download="${t.id}-checkin.png">${icon('download')} Save QR code</a>` : ''}<a class="btn outline" href="/live">View live boards ${icon('arrow')}</a></div>`; return;
    }
    if (form.getAttribute('id') === 'assign-form') await api('assign', fields);
    if (form.getAttribute('id') === 'walkover-form') { await api('walkover', { id: form.dataset.id, ...fields }); toast('Walkover recorded. The team advances.'); }
    if (form.getAttribute('id') === 'correct-form') { await api('correct-result', { id: form.dataset.id, ...fields }); toast('Result corrected. Later rounds updated.'); }
    if (form.getAttribute('id') === 'settings-form') {
      const contacts = [1, 2, 3].map(n => ({ name: fields[`contactName${n}`], phone: fields[`contactPhone${n}`] }));
      await api('settings', { name: fields.name, year: fields.year, venue: fields.venue, date: fields.date, startTime: fields.startTime, gamesPerMatch: fields.gamesPerMatch, gameMinutes: fields.gameMinutes, resetMinutes: fields.resetMinutes, restMinutes: fields.restMinutes, maxTeams: fields.maxTeams, maxTeamsPerParish: fields.maxTeamsPerParish, registrationDeadline: fields.registrationDeadline, entryFee: fields.entryFee, registrationOpen: fields.registrationOpen === 'on', paymentRequired: fields.paymentRequired === 'on', lunchCoupons: fields.lunchCoupons === 'on', upiQr: fields.upiQr, upiId: fields.upiId, contacts }); toast('Event settings saved.');
    }
    if (form.getAttribute('id') === 'team-form-form') { const r = await api('team-form', { id: form.dataset.id, mobile: fields.mobile }); await saveRegistrationPdf(r.team, r.qr, r.photos, r.lunchQr); modal.close(); toast('Registration form downloaded.'); return; }
    if (form.getAttribute('id') === 'reset-form') { await api('reset', fields); page = '/admin'; history.pushState({}, '', pagesMode ? `#${page}` : page); }
    modal.close(); await sync();
  } catch (error) { if (errorEl) errorEl.textContent = error.message; else toast(error.message, true); }
  finally { if (button) button.disabled = false; }
});
function tick() {
  if (!state) return;
  if (!modal.open && !document.activeElement?.matches('input, textarea, select') && [...document.querySelectorAll('.reset-timer')].some(el => Number(el.dataset.timer) <= now())) render();
  document.querySelectorAll('[data-timer]').forEach(el => { const end = Number(el.dataset.timer), seconds = end ? Math.max(0, Math.ceil((end - now()) / 1000)) : Number(el.dataset.duration || 10) * 60; el.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; el.classList.toggle('time-up', Boolean(end && seconds === 0)); });
  document.querySelectorAll('.board-card.playing').forEach(card => {
    const timer = card.querySelector('[data-timer]'), label = card.querySelector('[data-round]'), status = card.querySelector('.board-card-head .badge');
    if (timer && label && Number(timer.dataset.timer) <= now()) {
      status.textContent = 'Round time up'; status.classList.replace('green', 'orange');
      label.textContent = `${label.dataset.round} · TIME UP · UMPIRE DECIDING`;
    }
  });
  document.querySelectorAll('[data-progress]').forEach(el => el.style.width = `${Number(el.dataset.progress) * 100}%`);
  document.querySelectorAll('[data-timer-bar]').forEach(el => { const m = state.matches.find(m => m.id === el.dataset.timerBar); const r = m?.status === 'playing' && liveRound(m); el.style.width = `${r ? Math.max(0, (r.endsAt - now()) / (r.endsAt - r.startedAt) * 100) : 100}%`; });
}
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; });
await sync();
if (pagesMode) {
  watch(() => sync('auto'));
} else {
  const events = new EventSource('/api/events');
  events.onmessage = () => sync('auto');
  events.onopen = () => { connected = true; updateConnection(); };
  events.onerror = () => { connected = false; updateConnection(); };
}
setInterval(tick, 1000);
setInterval(() => sync('auto'), 15000);
if ('serviceWorker' in navigator) navigator.serviceWorker.register(pagesMode ? './sw.js' : '/sw.js').catch(() => {});

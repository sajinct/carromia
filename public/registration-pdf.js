// The printable registration form a team downloads after registering: its details, the check-in QR
// code, a declaration, the Parish Priest's attestation and the rule book. The desk can make the same
// PDF again from the saved team. jsPDF is passed in (the browser loads it only when needed).
import { prizes, timeline, documents, goodToKnow, ruleSections, formatText } from './info.js';

const green = [25, 62, 53], lime = [222, 237, 185], ink = [36, 51, 46], muted = [110, 118, 108], line = [210, 216, 204], soft = [243, 246, 238];
const W = 210, H = 297, M = 16, bottom = H - 18;
// The standard PDF fonts cover Western European text; the rupee sign is written as "Rs.".
const money = amount => `Rs. ${Number(amount).toLocaleString('en-IN')}`;
const longDate = date => date ? new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : 'To be announced';
const clock = time => time ? new Date(`2000-01-01T${time}`).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';

// Returns the jsPDF document; call .save(name) or .output('blob') on it.
// logos: optional PNG/JPEG data URLs (the Mary Matha Church and Diocese of Mandya emblems).
export function registrationPdf(jsPDF, { team, event, qr = '', photos = [], logos = [] }) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  doc.setProperties({ title: `CARROMIA ${event.year} registration ${team.id}`, subject: `${team.name} - ${team.parish}`, creator: 'CARROMIA' });
  const color = (c, kind = 'text') => kind === 'text' ? doc.setTextColor(...c) : kind === 'fill' ? doc.setFillColor(...c) : doc.setDrawColor(...c);
  const font = (size, style = 'normal', c = ink) => { doc.setFont('helvetica', style); doc.setFontSize(size); color(c); };
  const text = (value, x, y, options) => doc.text(Array.isArray(value) ? value : String(value ?? ''), x, y, options);
  const label = (value, x, y) => { font(7, 'bold', muted); text(value.toUpperCase(), x, y, { charSpace: 0.4 }); };
  const heading = (value, y) => { color(green, 'fill'); doc.rect(M, y - 4.2, 1.4, 5.6, 'F'); font(11, 'bold', green); text(value, M + 4, y); return y + 5; };
  const box = (x, y, w, h, fill) => { color(line, 'draw'); doc.setLineWidth(0.3); if (fill) { color(fill, 'fill'); doc.rect(x, y, w, h, 'FD'); } else doc.rect(x, y, w, h); };
  const fit = (data, x, y, w, h, format) => {
    try { const { width, height } = doc.getImageProperties(data), s = Math.min(w / width, h / height); doc.addImage(data, format, x + (w - width * s) / 2, y + (h - height * s) / 2, width * s, height * s); return true; }
    catch { return false; }
  };

  // Page 1: the registration form.
  color(green, 'fill'); doc.rect(0, 0, W, 36, 'F');
  logos.slice(0, 2).forEach((logo, i) => { const x = i ? W - M - 18 : M; color([255, 255, 255], 'fill'); doc.circle(x + 9, 18, 9.5, 'F'); fit(logo, x + 1.5, 10.5, 15, 15); });
  const mid = W / 2;
  font(7, 'bold', lime); text('PITHRUVEDHI OF MMC PRESENTS', mid, 11, { align: 'center', charSpace: 0.8 });
  font(22, 'bold', [255, 255, 255]); text(`${event.name || 'CARROMIA'} ${event.year || ''}`.trim(), mid, 21, { align: 'center', charSpace: 1 });
  font(8.5, 'normal', lime); text('Diocesan Carrom Tournament  |  Diocese of Mandya', mid, 27.5, { align: 'center' });
  font(7.5, 'bold', [255, 255, 255]); text('TEAM REGISTRATION FORM', mid, 32.5, { align: 'center', charSpace: 0.8 });

  let y = 43;
  font(8.5, 'normal', muted);
  text(`${longDate(event.date)}  |  Reporting time ${event.startTime ? clock(event.startTime) : '9:00 AM'}  |  ${event.venue}`, mid, y, { align: 'center', maxWidth: W - 2 * M });

  // Team and check-in QR code.
  y = 48; const qrSize = 38;
  box(M, y, W - 2 * M, 45, soft);
  label('Team ID', M + 6, y + 7); font(24, 'bold', green); text(team.id, M + 6, y + 17);
  label('Team name', M + 6, y + 25); font(13, 'bold'); if (doc.splitTextToSize(team.name, 108).length > 1) { font(9.5, 'bold'); text(doc.splitTextToSize(team.name, 108).slice(0, 2), M + 6, y + 29.5, { lineHeightFactor: 1.1 }); } else text(team.name, M + 6, y + 31);
  label('Registered on', M + 6, y + 37.5); font(9); text(team.registeredAt ? new Date(team.registeredAt).toLocaleString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '-', M + 6, y + 42);
  const qrX = W - M - qrSize - 6;
  if (qr && fit(qr, qrX, y + 2, qrSize, qrSize, 'PNG')) { font(6.5, 'bold', green); text('SHOW AT THE TOURNAMENT DESK', qrX + qrSize / 2, y + 42.5, { align: 'center' }); }
  else { box(qrX, y + 2, qrSize, qrSize); font(8, 'normal', muted); text('Check-in QR code', qrX + qrSize / 2, y + 21, { align: 'center' }); }

  // Parish / centre.
  y = 101; y = heading('Parish / Centre', y) + 1;
  const pairs = [['Forane / Zone', team.forane || '-'], ['Parish / Centre', team.parish || '-'], ['Type', team.centreType || '-']];
  const colW = (W - 2 * M) / 3;
  pairs.forEach(([k, v], i) => { const x = M + i * colW; box(x, y, colW, 14); label(k, x + 3, y + 4.6); font(9, 'bold'); const lines = doc.splitTextToSize(v, colW - 6);
    if (lines.length > 1) font(8, 'bold');
    text(doc.splitTextToSize(v, colW - 6).slice(0, 2), x + 3, y + 8.6, { lineHeightFactor: 1.05 });
  });

  // Players.
  y += 21; y = heading('Players', y) + 1;
  const cols = [[M, 26, 'Photo'], [M + 26, 62, 'Player'], [M + 88, 40, 'ID proof'], [M + 128, W - 2 * M - 128, 'Signature']];
  cols.forEach(([x, w, name]) => { box(x, y, w, 6, green); font(7.5, 'bold', [255, 255, 255]); text(name, x + 2.5, y + 4.2); });
  y += 6; const rowH = 25;
  team.players.forEach((p, i) => {
    cols.forEach(([x, w]) => box(x, y, w, rowH));
    if (!photos[i] || !fit(photos[i], M + 2, y + 2, 22, rowH - 4, 'JPEG')) { font(7, 'normal', muted); text('Photo', M + 13, y + rowH / 2 + 1, { align: 'center' }); }
    font(7, 'bold', muted); text(`PLAYER ${i + 1}${team.primaryContact === i ? '  |  PRIMARY CONTACT' : ''}`, M + 28.5, y + 6);
    font(10, 'bold'); text(doc.splitTextToSize(p.name, 57).slice(0, 2), M + 28.5, y + 12);
    font(8.5, 'normal', muted); if (p.mobile) text(`Mobile ${p.mobile}`, M + 28.5, y + 21.5);
    font(9, 'bold'); text(p.idType || '-', M + 90.5, y + 12); font(8.5, 'normal', muted); text(p.idLast4 ? `Ends in ${p.idLast4}` : '', M + 90.5, y + 17.5);
    y += rowH;
  });

  // Lunch and fee.
  y += 5.5; font(8.5, 'normal');
  const paid = team.payment ? `${money(team.payment.amount)} paid online${team.payment.txnRef ? ` (UTR ${team.payment.txnRef})` : ''}, confirmed` : `${money(event.entryFee ?? 500)} per team, paid at the tournament desk`;
  text(`Lunch booked: ${team.lunch ? `${team.lunch === 2 ? 'both players' : '1 player'}` : 'none'}     |     Entry fee: ${paid}`, M, y);
  const contacts = (event.contacts || []).map(c => `${c.name} ${c.phone}`).join('   |   ');
  if (contacts) { y += 4.8; font(8.5, 'normal', muted); text(`For queries: ${contacts}`, M, y); }

  // Declaration.
  y += 7.5; y = heading('Declaration by the players', y);
  font(8.5); const declaration = doc.splitTextToSize(`We, the players named above, are 18 years of age or older and are members of ${team.parish || 'the parish / centre named above'}. The details given in this form are true. We have read the tournament rules attached to this form and agree to abide by them and by the decisions of the umpires and the organisers.`, W - 2 * M);
  text(declaration, M, y + 1); y += declaration.length * 3.8 + 2;

  // Attestation by the Parish Priest.
  y += 3; y = heading('Attestation by the Parish Priest', y) + 1;
  const sealW = 40, attH = contacts ? 31 : 35;
  box(M, y, W - 2 * M, attH);
  font(8.5); text(doc.splitTextToSize(`I certify that the players named above are members of ${team.parish || 'this parish / centre'}.`, W - 2 * M - sealW - 12), M + 4, y + 6);
  const lineAt = (name, ly, w = 88) => { font(8, 'normal', muted); text(name, M + 4, ly); color(ink, 'draw'); doc.setLineWidth(0.2); doc.line(M + 40, ly + 0.6, M + 40 + w, ly + 0.6); };
  lineAt('Name of Parish Priest', y + attH * 0.44); lineAt('Signature', y + attH * 0.67); lineAt('Date', y + attH * 0.89, 40);
  const sealX = W - M - sealW - 4; doc.setLineDashPattern([1.2, 1.2], 0); color(muted, 'draw'); doc.roundedRect(sealX, y + 3, sealW, attH - 6, 2, 2); doc.setLineDashPattern([], 0);
  font(8, 'normal', muted); text('Parish seal', sealX + sealW / 2, y + attH / 2 + 1, { align: 'center' });
  y += attH + 4;

  // For office use.
  box(M, y, W - 2 * M, 11, soft); font(7, 'bold', muted); text('FOR OFFICE USE', M + 3, y + 6.8);
  [['Checked in', 45], ['Fee received', 77], ['ID verified', 111]].forEach(([name, x]) => { box(M + x, y + 3.3, 4, 4); font(8); text(name, M + x + 6, y + 6.8); });
  font(8); text('Official', M + 142, y + 6.8); color(ink, 'draw'); doc.line(M + 155, y + 7.3, W - M - 3, y + 7.3);

  // Rule book.
  doc.addPage(); y = pageTop('Rule book');
  font(9, 'normal', muted);
  const intro = doc.splitTextToSize(`CARROMIA ${event.year || ''} is an open doubles, thumbing-game knockout. Every match is ${formatText(event)}.`, W - 2 * M);
  text(intro, M, y); y += intro.length * 4 + 4;
  let number = 0;
  for (const section of ruleSections) {
    need(14); y = heading(section.title, y + 2) + 1;
    for (const rule of section.rules) { number++; y = numbered(`${number}.`, rule, y); }
  }
  const list = (title, lines, marker = i => `${i + 1}.`) => { need(14); y = heading(title, y + 4) + 1; lines.forEach((line, i) => { y = numbered(marker(i), line, y); }); };
  list('Bring for registration verification', documents);
  list('Good to know', [`Entry fee is ${money(event.entryFee ?? 500)} per team.`, ...(event.registrationDeadline ? [`Last date for registration is ${longDate(event.registrationDeadline)}.`] : []), `Up to ${event.maxTeamsPerParish ?? 4} teams can register from one parish.`, ...goodToKnow], () => '-');
  list('The day', timeline.map(([at, what]) => `${at}   ${what}`), () => '-');
  list('Prizes', prizes.map(p => `${p.place}: ${money(p.amount)} and a trophy`), () => '-');

  // Footer on every page.
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i); color(line, 'draw'); doc.setLineWidth(0.3); doc.line(M, H - 12, W - M, H - 12);
    font(7.5, 'normal', muted); text(`${event.name || 'CARROMIA'} ${event.year || ''}  |  Team ${team.id}  |  ${team.name}`, M, H - 7.5); text(`Page ${i} of ${pages}`, W - M, H - 7.5, { align: 'right' });
  }
  return doc;

  function pageTop(title) {
    color(green, 'fill'); doc.rect(0, 0, W, 16, 'F');
    font(12, 'bold', [255, 255, 255]); text(`${event.name || 'CARROMIA'} ${event.year || ''}`, M, 10.5);
    font(8, 'bold', lime); text(title.toUpperCase(), W - M, 10.5, { align: 'right' });
    return 26;
  }
  function need(h) { if (y + h > bottom) { doc.addPage(); y = pageTop('Rule book (continued)'); } }
  function numbered(marker, value, at) {
    font(9); const lines = doc.splitTextToSize(value, W - 2 * M - 8);
    if (at + lines.length * 4 > bottom) { doc.addPage(); y = at = pageTop('Rule book (continued)'); font(9); }
    font(9, 'bold', green); text(marker, M + 1, at); font(9); text(lines, M + 8, at);
    return at + lines.length * 4 + 1.6;
  }
}

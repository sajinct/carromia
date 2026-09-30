import test from 'node:test';
import assert from 'node:assert/strict';
import { jsPDF } from 'jspdf';
import QRCode from 'qrcode';
import { registrationPdf } from '../public/registration-pdf.js';
import { ruleSections } from '../public/info.js';
import { seedDemo, defaults } from '../lib/tournament.mjs';
import { photo } from './registration-fixture.mjs';

test('registration PDF: team details, check-in QR, attestation and the rule book', async () => {
  const team = seedDemo().teams[0], qr = await QRCode.toDataURL('https://example.org/checkin?token=abc');
  const doc = registrationPdf(jsPDF, { team, event: defaults, qr, photos: [photo, photo] });
  const pdf = doc.output();
  assert.ok(pdf.startsWith('%PDF-')); assert.ok(doc.getNumberOfPages() >= 2, 'the rule book follows the form');
  for (const text of [team.id, team.name, team.parish, team.forane, team.players[0].name, `Ends in ${team.players[0].idLast4}`, 'Attestation by the Parish Priest', 'Parish seal', 'FOR OFFICE USE', ruleSections[0].title, ruleSections.at(-1).title]) assert.ok(pdf.includes(text), `the PDF shows "${text}"`);
  // The QR code and the player photo (the two test photos are identical, so the PDF stores it once).
  assert.equal((pdf.match(/\/Subtype \/Image/g) || []).length, 2);
  // Paid online, with support contacts.
  const paid = registrationPdf(jsPDF, { team: { ...team, status: 'confirmed', payment: { amount: 500, txnRef: '412356789012', screenshot: false } }, event: { ...defaults, contacts: [{ name: 'Fr. Joseph', phone: '9876543210' }] }, qr }).output();
  assert.ok(paid.includes('Rs. 500 paid online') && paid.includes('UTR 412356789012')); assert.ok(paid.includes('For queries: Fr. Joseph 9876543210'));
  // Without a QR code or photos (a team registered earlier) the form still has room for them.
  const plain = registrationPdf(jsPDF, { team: { ...team, forane: undefined, centreType: undefined }, event: defaults }).output();
  assert.ok(plain.includes('Check-in QR code')); assert.ok(!plain.includes('/Subtype /Image'));
});
test('registration PDF: tear-off lunch coupons with the lunch-counter QR code, when the event has them on', async () => {
  const team = { ...seedDemo().teams[0], lunch: 2 }, qr = await QRCode.toDataURL('https://example.org/checkin?token=abc'), lunchQr = await QRCode.toDataURL('https://example.org/lunch?token=abc');
  const event = { ...defaults, lunchCoupons: true, contacts: [{ name: 'Fr. Joseph', phone: '9876543210' }] };
  const doc = registrationPdf(jsPDF, { team, event, qr, lunchQr, photos: [photo, photo] }), pdf = doc.output();
  for (const text of ['LUNCH COUPON', '1 of 2', '2 of 2', `${team.id}-L1`, `${team.id}-L2`, 'Scan at the lunch counter', 'CUT ALONG THE DOTTED LINE', 'FOR OFFICE USE', 'Parish seal']) assert.ok(pdf.includes(text), `the PDF shows "${text}"`);
  assert.equal((pdf.match(/\/Subtype \/Image/g) || []).length, 3, 'check-in QR, lunch QR (stored once) and photo');
  assert.ok(doc.carromia.formBottom <= doc.carromia.stripTop - 3, 'the form ends above the coupons');
  const one = registrationPdf(jsPDF, { team: { ...team, lunch: 1 }, event, lunchQr }).output();
  assert.ok(one.includes('1 of 1') && !one.includes(`${team.id}-L2`));
  for (const [what, t, e] of [['no lunch booked', { ...team, lunch: 0 }, event], ['coupons turned off', team, defaults]]) {
    const off = registrationPdf(jsPDF, { team: t, event: e, qr, lunchQr });
    assert.ok(!off.output().includes('LUNCH COUPON'), what); assert.equal(off.carromia.stripTop, null, what);
  }
});

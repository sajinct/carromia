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
  // Without a QR code or photos (a team registered earlier) the form still has room for them.
  const plain = registrationPdf(jsPDF, { team: { ...team, forane: undefined, centreType: undefined }, event: defaults }).output();
  assert.ok(plain.includes('Check-in QR code')); assert.ok(!plain.includes('/Subtype /Image'));
});

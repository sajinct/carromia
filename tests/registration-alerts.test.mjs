import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { emptyState, updateSettings, publicState, publicEvent, seedDemo } from '../lib/tournament.mjs';
import { sendRegistrationEmail, registrationEmailConfig } from '../supabase/functions/registration/email.mjs';

const base = { resetMinutes: 5, restMinutes: 0, registrationOpen: true };

test('registration alerts validate, deduplicate and preserve multiple recipients', () => {
  const state = emptyState();
  updateSettings(state, { ...base, registrationAlerts: { enabled: true, recipients: [' FIRST@example.org ', 'second@example.org', 'first@example.org'] } });
  assert.deepEqual(state.event.registrationAlerts, { enabled: true, recipients: ['first@example.org', 'second@example.org'] });
  updateSettings(state, { ...base, name: 'Updated' });
  assert.equal(state.event.registrationAlerts.recipients.length, 2, 'older clients keep alert settings');
  for (const registrationAlerts of [null, {}, { enabled: true, recipients: [] }, { enabled: 'false', recipients: [] }, { enabled: true, recipients: ['bad'] }, { enabled: true, recipients: ['a@example.org\r\nBcc:b@example.org'] }, { enabled: true, recipients: Array.from({ length: 11 }, (_, i) => `user${i}@example.org`) }]) {
    assert.throws(() => updateSettings(emptyState(), { ...base, registrationAlerts }), /email|registration alert/i);
  }
  updateSettings(state, { ...base, registrationAlerts: { enabled: false, recipients: state.event.registrationAlerts.recipients } });
  assert.equal(state.event.registrationAlerts.enabled, false);
  assert.equal(state.event.registrationAlerts.recipients.length, 2, 'turning alerts off keeps the list');
});

const alerts = { enabled: true, recipients: ['first@example.org', 'second@example.org'] };
const emailConfig = { apiKey: 're_test', from: 'CARROMIA <alerts@example.org>', publicUrl: 'https://event.example.org/carromia/' };
const registered = (extra = {}) => ({ id: 'CAR-001', registeredAt: 1791200000000, status: 'confirmed', name: 'Private team', players: [{ name: 'Private player', mobile: '9111111111' }], ...extra });

test('email sender uses multiple saved recipients and keeps participant details in the desk', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url, init, body: JSON.parse(init.body) }); return new Response('{"id":"email-1"}', { status: 200 }); };
  assert.deepEqual(await sendRegistrationEmail([registered()], 'main', alerts, emailConfig, fetchImpl), { status: 'sent' });
  const mail = sent[0];
  assert.equal(mail.url, 'https://api.resend.com/emails');
  assert.deepEqual(mail.body.to, alerts.recipients);
  assert.equal(mail.init.headers.Authorization, 'Bearer re_test');
  assert.match(mail.body.text, /https:\/\/event.example.org\/carromia\/#\/admin\/teams/);
  assert.ok(!JSON.stringify(mail.body).includes('Private'));
  assert.ok(!JSON.stringify(mail.body).includes('9111111111'));
  assert.ok(!JSON.stringify(mail.body).includes('CAR-001'));
  assert.deepEqual(registrationEmailConfig(name => ({ RESEND_API_KEY: 'key', REGISTRATION_EMAIL_FROM: 'from@example.org' })[name]), {
    apiKey: 'key', from: 'from@example.org', publicUrl: 'https://carromia.marymathachurchvijayanagar.com'
  });
});

test('email sender skips practice and disabled alerts; group submissions send one payment reminder', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push(JSON.parse(init.body)); return new Response('{}'); };
  for (const [teams, event, settings] of [[[registered()], 'practice', alerts], [[registered()], 'main', { ...alerts, enabled: false }], [[], 'main', alerts], [[registered()], 'main', undefined]]) {
    assert.deepEqual(await sendRegistrationEmail(teams, event, settings, emailConfig, fetchImpl), { status: 'skipped' });
  }
  assert.equal(sent.length, 0);
  await sendRegistrationEmail([registered({ status: 'pending' }), registered({ id: 'CAR-002', status: 'pending' })], 'main', alerts, emailConfig, fetchImpl);
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /2 new team registrations/);
  assert.match(sent[0].text, /2 teams need payment verification/);
});

test('email sender retries temporary failures with the same key, without duplicates', async () => {
  const sent = [], delays = [], reports = [];
  const fetchImpl = async (url, init) => {
    sent.push(init);
    if (sent.length === 1) throw new Error('network down');
    return new Response('{}', { status: sent.length === 2 ? 429 : 200, headers: { 'Retry-After': '2' } });
  };
  assert.deepEqual(await sendRegistrationEmail([registered()], 'main', alerts, emailConfig, fetchImpl, message => reports.push(message), async ms => delays.push(ms)), { status: 'sent' });
  assert.equal(sent.length, 3);
  assert.equal(new Set(sent.map(init => init.headers['Idempotency-Key'])).size, 1);
  assert.equal(new Set(sent.map(init => init.body)).size, 1);
  assert.deepEqual(delays, [500, 2000]);
  assert.equal(reports.length, 0);
  const firstKey = sent[0].headers['Idempotency-Key'];
  await sendRegistrationEmail([registered({ registeredAt: 1791300000000 })], 'main', alerts, emailConfig, fetchImpl);
  assert.notEqual(sent.at(-1).headers['Idempotency-Key'], firstKey, 'a new event using the same team ID gets a new alert');
});

test('email failures are bounded, report no secrets and do not escape to registration', async () => {
  const reports = [];
  for (const code of [401, 500]) {
    let calls = 0;
    const result = await sendRegistrationEmail([registered()], 'main', alerts, emailConfig, async () => { calls++; return new Response('private provider response', { status: code }); }, message => reports.push(message), async () => {});
    assert.equal(result.status, 'failed');
    assert.equal(calls, code === 401 ? 1 : 3);
  }
  let calls = 0;
  for (const [settings, config] of [[alerts, {}], [{ enabled: true, recipients: ['bad\r\naddress'] }, emailConfig]]) {
    const result = await sendRegistrationEmail([registered()], 'main', settings, config, async () => { calls++; }, message => reports.push(message));
    assert.equal(result.status, 'failed');
  }
  assert.equal(calls, 0);
  assert.ok(!reports.join(' ').includes('re_test'));
  assert.ok(!reports.join(' ').includes('private provider response'));
});

test('public event and state never expose alert recipients', () => {
  const state = emptyState();
  state.event.registrationAlerts = { enabled: true, recipients: ['private@example.org'] };
  assert.equal(publicEvent(state.event).registrationAlerts, undefined);
  assert.equal(publicState(state).event.registrationAlerts, undefined);
  assert.ok(!JSON.stringify(publicState(state)).includes('private@example.org'));
  assert.equal(state.event.registrationAlerts.recipients[0], 'private@example.org', 'filtering does not alter desk settings');
});

test('database public copy removes alert settings and preserves existing privacy filters', async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`
    create table public.tournament (id text primary key, version bigint, state jsonb);
    create table public.tournament_public (id text primary key, version bigint, state jsonb, updated_at timestamptz default now());
    create function public.media_public_copy(p_media jsonb) returns jsonb language sql immutable as $$ select p_media $$;
  `);
  const state = seedDemo();
  state.event.registrationAlerts = { enabled: true, recipients: ['private@example.org'] };
  state.teams[0].payment = { txnRef: 'PRIVATE' };
  await db.query('insert into public.tournament values ($1, 1, $2)', ['main', state]);
  const migration = readFileSync(new URL('../supabase/migrations/20261015000000_carromia_registration_alerts.sql', import.meta.url), 'utf8');
  await db.exec(migration);
  await db.exec(migration);
  const published = (await db.query('select state from public.tournament_public')).rows[0].state;
  assert.deepEqual(published, publicState(state));
  assert.equal(published.event.registrationAlerts, undefined);
  assert.equal(published.teams[0].payment, undefined);
  assert.equal(published.teams[0].checkinToken, undefined);
  assert.equal(published.teams[0].players[0].mobile, undefined);
});

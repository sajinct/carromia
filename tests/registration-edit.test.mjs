import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { emptyState, addTeams, confirmPayment, createDraw, actions, refusal } from '../lib/tournament.mjs';
import { updateRegistration } from '../public/registration-update.js';
import { registrationEditor } from '../public/registration-editor.js';
import { fileStore } from '../lib/store.mjs';
import { centre, player, photo } from './registration-fixture.mjs';

function fixture() {
  const state = emptyState(); Object.assign(state.event, { registrationDeadline: '', paymentRequired: true });
  const teams = addTeams(state, { ...centre(0), adults: true, coordinator: { name: 'Coordinator', mobile: '9900000000' }, payment: { txnRef: 'UTR123456', screenshot: photo },
    teams: ['Alpha', 'Beta'].map((name, i) => ({ name, players: [player(`${name} One`, `911111111${i}`), player(`${name} Two`, `922222222${i}`)], lunch: 2 })) });
  confirmPayment(state, teams[0].id, 1000, 'Official');
  addTeams(state, { ...centre(1), adults: true, payment: { txnRef: 'OTHER123' }, teams: [{ name: 'Other', players: [player('Other One'), player('Other Two')] }] });
  return state;
}
const edit = team => ({ id: team.id, expectedVersion: team.registrationVersion || 0, name: team.name, forane: team.forane, parish: team.parish, centreType: team.centreType,
  players: structuredClone(team.players), primaryContact: team.primaryContact, lunch: team.lunch, coordinator: structuredClone(team.group?.coordinator), payment: { txnRef: team.payment?.txnRef || '' } });

test('registration corrections preserve confirmed payments, attendance, QR codes, draw and results', () => {
  const state = fixture(), team = state.teams[0]; team.checkedIn = true; createDraw(state, false);
  const matches = structuredClone(state.matches), token = team.checkinToken, status = team.status;
  const input = { ...edit(team), name: 'Corrected team', players: team.players.map(p => ({ ...p, name: `${p.name} corrected` })), primaryContact: 1, lunch: 1 };
  updateRegistration(state, input);
  assert.equal(team.name, 'Corrected team'); assert.equal(team.primaryContact, 1); assert.equal(team.registrationVersion, 1);
  assert.equal(team.checkedIn, true); assert.equal(team.checkinToken, token); assert.equal(team.status, status); assert.equal(team.confirmedBy, 'Official');
  assert.deepEqual(state.matches, matches); assert.equal(state.teams[1].name, 'Beta');
  assert.throws(() => updateRegistration(state, input), /changed while you were editing/);
});

test('parish, coordinator, UTR and replacement proof changes propagate only within the registration group', () => {
  const state = fixture(), other = structuredClone(state.teams[2]);
  const input = { ...edit(state.teams[0]), ...centre(2), coordinator: { name: 'New coordinator', mobile: '9888888888' }, payment: { txnRef: 'utr 654321', screenshot: photo } };
  updateRegistration(state, input);
  for (const t of state.teams.slice(0, 2)) {
    assert.equal(t.parish, centre(2).parish); assert.equal(t.group.coordinator.mobile, '9888888888'); assert.equal(t.payment.txnRef, 'UTR654321'); assert.equal(t.registrationVersion, 1); assert.equal(t.status, 'confirmed');
  }
  assert.deepEqual(state.teams[2], other);
});

test('invalid edits do not mutate data; lunches already served and parish limits are respected', () => {
  const state = fixture(); state.teams[0].lunchServed = 2;
  for (const change of [
    { name: 'Beta' }, { players: [] }, { lunch: 1 }, { primaryContact: 4 }, { parish: 'Unknown' },
    { players: [player('One'), { ...player('Two'), idLast4: 'bad' }] }, { payment: { txnRef: 'bad!' } }, { coordinator: { name: '', mobile: '' } }
  ]) {
    const before = structuredClone(state);
    assert.throws(() => updateRegistration(state, { ...edit(state.teams[0]), ...change })); assert.deepEqual(state, before);
  }
  state.event.maxTeamsPerParish = 2;
  assert.throws(() => updateRegistration(state, { ...edit(state.teams[0]), ...centre(1) }), /parish would exceed/);
  assert.equal(refusal(actions['update-registration'], { role: 'official' }), '');
  for (const role of ['checkin', 'lunch', 'umpire', 'media']) assert.ok(refusal(actions['update-registration'], { role }));
});

test('local file metadata rolls back when a registration save fails and leaves old files available', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'carromia-registration-edit-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = fileStore(dir), state = fixture();
  await store.save(state); await store.savePhotos('CAR-001', ['old-1.jpg', 'old-2.jpg']);
  for (const id of ['CAR-001', 'CAR-002']) await store.savePaymentProof(id, 'old-payment.jpg');
  const original = store.save; store.save = async () => { throw new Error('disk failed'); };
  await assert.rejects(store.saveRegistration(state, { id: 'CAR-001', photos: { 0: 'new-1.jpg' }, payment: 'new-payment.jpg' }), /disk failed/);
  assert.deepEqual((await store.loadPhotos())['CAR-001'], ['old-1.jpg', 'old-2.jpg']);
  assert.deepEqual(await store.loadPaymentProofs(), { 'CAR-001': 'old-payment.jpg', 'CAR-002': 'old-payment.jpg' });
  store.save = original; await store.saveRegistration(state, { id: 'CAR-001', photos: { 1: 'new-2.jpg' }, payment: 'new-payment.jpg' });
  assert.deepEqual((await store.loadPhotos())['CAR-001'], ['old-1.jpg', 'new-2.jpg']);
  assert.deepEqual(await store.loadPaymentProofs(), { 'CAR-001': 'new-payment.jpg', 'CAR-002': 'new-payment.jpg' });
});

test('editor escapes saved details and offers optional file replacements without editable status or QR fields', () => {
  const state = fixture(); state.teams[0].name = '<script>unsafe()</script>';
  const html = registrationEditor(state.teams[0], ['https://example.org/photo.jpg']);
  assert.match(html, /&lt;script&gt;/); assert.match(html, /Replace photo \(optional\)/); assert.match(html, /Replace payment screenshot/);
  assert.match(html, /every team in this group/); assert.doesNotMatch(html, /<script>|name="status"|name="checkedIn"|name="checkinToken"/);
});

async function database(t) {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth; create schema storage;
    create function auth.role() returns text language sql as $$ select current_setting('request.jwt.claim.role',true) $$;
    create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create table officials(user_id uuid primary key,name text,role text,boards int[] default '{}');
    create table tournament(id text primary key,version bigint,state jsonb,updated_at timestamptz default now());
    create table tournament_public(id text primary key,version bigint,state jsonb,updated_at timestamptz default now());
    create table audit_log(actor_id uuid,actor_name text,action text,detail jsonb);
    create table player_photos(event text,team_id text,player int,path text,primary key(event,team_id,player));
    create table payment_proofs(event text,team_id text,path text,primary key(event,team_id));
    create table storage.objects(bucket_id text,name text);
    create function official_role() returns text language sql as $$ select role from public.officials where user_id=auth.uid() $$;
    create function team_ids(s jsonb) returns text language sql as $$ select string_agg(t->>'id',',' order by t->>'id') from jsonb_array_elements(s->'teams') t $$;
    create function teams_without(t jsonb,k text[]) returns jsonb language sql as $$ select jsonb_agg(x-k) from jsonb_array_elements(t) x $$;
    create function media_public_copy(m jsonb) returns jsonb language sql as $$ select m $$;
    create function parish_key(t text) returns text language sql as $$ select trim(regexp_replace(regexp_replace(lower(t),'[^a-z0-9]+',' ','g'),'\\m(church|parish)\\M','','g')) $$;
    insert into officials(user_id,name,role) values('00000000-0000-0000-0000-000000000001','Official','official');
    select set_config('request.jwt.claim.role','authenticated',false),set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);`);
  const migration = name => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
  const staff = migration('20261010000000_carromia_staff_roles.sql'); await db.exec(staff.slice(staff.indexOf('create or replace function public.save_tournament')));
  await db.exec(migration('20261015000000_carromia_registration_alerts.sql'));
  await db.exec(migration('20261112000000_carromia_registration_edit.sql')); await db.exec(migration('20261112000000_carromia_registration_edit.sql'));
  await db.query('insert into tournament(id,version,state) values($1,$2,$3)', ['main', 1, fixture()]);
  return db;
}
async function candidate(db, input = {}) {
  const row = (await db.query("select state,version from tournament where id='main'")).rows[0];
  const next = structuredClone(row.state), patch = { ...edit(next.teams[0]), ...input }; updateRegistration(next, patch);
  return { next, version: row.version, patch };
}
const save = (db, c, photos = {}, payment = '', expected = c.patch.expectedVersion) => db.query('select save_registration($1,$2,$3,$4,$5,$6,$7)', [c.version, c.next, c.patch.id, photos, payment, { expectedVersion: expected }, 'main']);

test('PostgreSQL commits corrected group details, public data and replacement file references atomically', async t => {
  const db = await database(t), folder = 'main/00000000-0000-0000-0000-000000000009';
  for (const name of ['player-1.jpg', 'player-1-thumb.jpg', 'payment.jpg']) await db.query('insert into storage.objects values($1,$2)', ['team-files', `${folder}/${name}`]);
  const c = await candidate(db, { name: 'Updated Alpha', ...centre(2), payment: { txnRef: 'NEW123456', screenshot: photo } });
  await save(db, c, { 0: `${folder}/player-1.jpg` }, `${folder}/payment.jpg`);
  const row = (await db.query("select state,version from tournament where id='main'")).rows[0];
  assert.equal(row.version, 2); assert.equal(row.state.teams[0].name, 'Updated Alpha'); assert.equal(row.state.teams[1].payment.txnRef, 'NEW123456');
  assert.equal((await db.query('select * from player_photos')).rows[0].path, `${folder}/player-1.jpg`);
  assert.equal((await db.query('select * from payment_proofs')).rows.length, 2);
  const publicData = JSON.stringify((await db.query('select state from tournament_public')).rows[0].state);
  assert.ok(publicData.includes('Updated Alpha')); assert.ok(!publicData.includes('NEW123456')); assert.ok(!publicData.includes('9111111110'));
  assert.equal((await db.query('select action from audit_log')).rows[0].action, 'update-registration');
});

test('PostgreSQL rejects missing files, stale forms, status changes, match changes and restricted roles without committing', async t => {
  const db = await database(t), c = await candidate(db, { name: 'Updated Alpha' });
  await assert.rejects(save(db, c, { 0: 'main/00000000-0000-0000-0000-000000000009/player-1.jpg' }), /full photo and thumbnail/);
  assert.equal((await db.query('select version from tournament')).rows[0].version, 1);
  for (const mutate of [s => { s.teams[0].status = 'pending'; }, s => { s.event.entryFee = 1; }, s => { s.matches.push({ id: 'FORGED' }); }, s => { s.teams[2].name = 'Unrelated'; }, s => { s.teams[0].payment.amount = 1; }]) {
    const invalid = { ...c, next: structuredClone(c.next) }; mutate(invalid.next); await assert.rejects(save(db, invalid));
  }
  await save(db, c);
  const fresh = await candidate(db, { name: 'Another correction' }); await assert.rejects(save(db, fresh, {}, '', 0), /changed while you were editing/);
  for (const role of ['checkin', 'lunch', 'umpire', 'media']) {
    await db.query('update officials set role=$1', [role]); await assert.rejects(save(db, fresh), /Only event admins and officials/);
  }
  assert.equal((await db.query('select version from tournament')).rows[0].version, 2);
});

test('PostgreSQL permits a single pending-team correction and isolates practice edits', async t => {
  const db = await database(t);
  const row = (await db.query("select state,version from tournament where id='main'")).rows[0];
  const next = structuredClone(row.state), patch = { ...edit(next.teams[2]), name: 'Corrected pending team' };
  updateRegistration(next, patch);
  await save(db, { next, patch, version: row.version });
  assert.equal((await db.query("select state from tournament where id='main'")).rows[0].state.teams[2].status, 'pending');
  const practice = structuredClone(next); practice.practice = true;
  await db.query('insert into tournament(id,version,state) values($1,$2,$3)', ['practice', 1, practice]);
  const rehearsal = { ...edit(practice.teams[2]), name: 'Practice correction' }; updateRegistration(practice, rehearsal);
  await db.query('select save_registration($1,$2,$3,$4,$5,$6,$7)', [1, practice, rehearsal.id, {}, '', { expectedVersion: rehearsal.expectedVersion }, 'practice']);
  assert.equal((await db.query("select state from tournament where id='main'")).rows[0].state.teams[2].name, 'Corrected pending team');
});

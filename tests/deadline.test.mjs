import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { emptyState, registrationStatus, updateSettings } from '../lib/tournament.mjs';
import { registrationCutoff, registrationDeadlineText } from '../public/event-deadline.js';

test('registration closes exactly at the configured India time, with legacy defaults and practice exemption', () => {
  const state = emptyState(), cutoff = Date.parse('2026-11-10T18:30:00Z');
  assert.equal(registrationCutoff(state.event), cutoff);
  assert.equal(registrationStatus(state, cutoff - 1).open, true);
  assert.equal(registrationStatus(state, cutoff).open, false);
  assert.equal(registrationStatus(state, cutoff + 1).open, false);
  assert.equal(registrationStatus({ ...state, practice: true }, cutoff).open, true);
  assert.equal(registrationDeadlineText(state.event), 'Tuesday, 10 November 2026');
  assert.equal(registrationStatus(state, Date.parse('2026-11-10T15:30:00Z')).open, true, 'registration remains open after 9 PM');
  delete state.event.registrationDeadlineTime;
  assert.equal(registrationStatus(state, cutoff).open, false, 'events without a saved closing time use the end of the deadline day');
  updateSettings(state, { resetMinutes: 5, restMinutes: 0, registrationOpen: true, registrationDeadlineTime: '18:30' });
  assert.equal(registrationStatus(state, Date.parse('2026-11-10T12:59:59.999Z')).open, true);
  assert.equal(registrationStatus(state, Date.parse('2026-11-10T13:00:00Z')).open, false);
  for (const value of ['', '9 PM', '25:00', '21:60']) {
    assert.throws(() => updateSettings(emptyState(), { resetMinutes: 5, restMinutes: 0, registrationDeadlineTime: value }), /registration closing time/);
  }
  state.event.registrationDeadline = '';
  assert.equal(registrationStatus(state, cutoff).open, true);
  assert.equal(registrationDeadlineText(state.event), '');
});

test('hosted SQL enforces the same cutoff, preserves existing teams and can be safely rerun', async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`
    create table public.tournament (id text primary key, version bigint, state jsonb, updated_at timestamptz default now());
    create table public.tournament_public (id text primary key, version bigint, state jsonb, updated_at timestamptz default now());
    create function public.public_copy(p_state jsonb) returns jsonb language sql as $$ select p_state $$;
  `);
  const state = emptyState();
  state.event.registrationDeadline = '2000-11-10';
  delete state.event.registrationDeadlineTime;
  state.teams = [{ id: 'CAR-001', name: 'Existing team', lunch: 2, payment: { amount: 500 } }];
  await db.query('insert into public.tournament(id,version,state) values ($1,1,$2),($3,1,$2)', ['main', state, 'practice']);
  await db.query('insert into public.tournament_public(id,version,state) values ($1,1,$2)', ['main', state]);
  const migration = readFileSync(new URL('../supabase/migrations/20261014000000_carromia_deadline_time.sql', import.meta.url), 'utf8');
  await db.exec(migration); await db.exec(migration);
  const row = (await db.query("select version,state from public.tournament where id='main'")).rows[0];
  assert.equal(Number(row.version), 2);
  assert.equal(row.state.event.registrationDeadlineTime, '24:00');
  assert.deepEqual(row.state.teams, state.teams);
  assert.deepEqual((await db.query("select state from public.tournament_public where id='main'")).rows[0].state, row.state);
  const settings = emptyState().event;
  const timestamp = (await db.query('select public.registration_cutoff($1) as cutoff', [settings])).rows[0].cutoff;
  assert.equal(new Date(timestamp).getTime(), registrationCutoff(settings));
  const custom = { ...settings, registrationDeadlineTime: '18:30' };
  assert.equal(new Date((await db.query('select public.registration_cutoff($1) as cutoff', [custom])).rows[0].cutoff).getTime(), registrationCutoff(custom));
  assert.equal((await db.query('select public.registration_cutoff($1) as cutoff', [{ ...settings, registrationDeadline: '' }])).rows[0].cutoff, null);
  const register = event => db.query('select public.register_teams($1,$2,$3,$4,$5,true)', [event, 'Forane', 'Parish', 'Parish', []]);
  await assert.rejects(register('main'), /Registration closed on 10 November 2000\./);
  await assert.rejects(register('practice'), /Add at least one team/, 'practice gets past the cutoff check');
});

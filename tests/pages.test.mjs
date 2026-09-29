import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const root = join(import.meta.dirname, '..');
test('Pages build is portable to a repository subpath and contains only static assets', () => {
  execFileSync(process.execPath, ['scripts/build-pages.mjs'], { cwd: root });
  const html = readFileSync(join(root, 'dist/index.html'), 'utf8');
  assert.ok(html.includes('src="./app.js"')); assert.ok(!/(href|src)="\//.test(html));
  const manifest = JSON.parse(readFileSync(join(root, 'dist/manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.start_url, './'); assert.equal(manifest.scope, './');
  for (const icon of manifest.icons) assert.ok(existsSync(join(root, 'dist', icon.src)));
  assert.ok(!readFileSync(join(root, 'dist/tournament-browser.js'), 'utf8').includes('node:crypto'));
  assert.ok(!readdirSync(join(root, 'dist')).includes('data'));
});
test('Pages adapter supports demo operations but rejects real registration', async () => {
  const memory = new Map(); globalThis.localStorage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
  const { demoApi } = await import('../dist/runtime.js');
  let state = await demoApi('state'); assert.equal(state.demo, true); assert.equal(state.isAdmin, true); assert.equal(state.teams.length, 16);
  await demoApi('unassign', { id: 'M01' }); await demoApi('assign', { id: 'M05', board: 1 }); await demoApi('start', { id: 'M05' });
  state = await demoApi('state'); assert.equal(state.matches.find(m => m.id === 'M05').status, 'playing');
  await assert.rejects(demoApi('register', { name: 'Real team' }), /public demo/);
  await demoApi('reset', { confirm: 'RESET' }); state = await demoApi('state'); assert.equal(state.matches[0].status, 'called'); assert.equal(state.event.durationMinutes, 10);
  delete globalThis.localStorage;
});

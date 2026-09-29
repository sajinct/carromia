// Copies a local tournament file into Supabase.
// Usage: npm run import:supabase -- [path/to/tournament.json] [--replace]
// Refuses to overwrite an existing Supabase event unless --replace is given.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { supabaseStore } from '../lib/store.mjs';

const args = process.argv.slice(2), replace = args.includes('--replace');
const path = args.find(a => !a.startsWith('--')) || join(import.meta.dirname, '..', 'data', 'tournament.json');
const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) throw new Error('Set SUPABASE_URL and SUPABASE_SECRET_KEY (see .env.example).');
const state = JSON.parse(readFileSync(path, 'utf8'));
if (state.version !== 1 || !Array.isArray(state.teams) || !Array.isArray(state.matches)) throw new Error(`${path} is not a CARROMIA tournament file.`);
const store = supabaseStore(SUPABASE_URL, SUPABASE_SECRET_KEY);
if (await store.load() && !replace) { console.error('Supabase already holds an event. Re-run with --replace to overwrite it (download a backup first).'); process.exit(1); }
await store.save(state);
console.log(`Imported ${state.teams.length} teams and ${state.matches.length} matches from ${path}.`);

import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const output = join(root, 'dist');
mkdirSync(output, { recursive: true });
cpSync(join(root, 'public'), output, { recursive: true });
const read = p => readFileSync(join(root, p), 'utf8');
const write = (p, text) => writeFileSync(join(output, p), text);
// Fails the build when a source edit leaves a substitution with nothing to replace.
const swap = (p, pairs) => pairs.reduce((text, [from, to]) => {
  if (!text.includes(from)) throw new Error(`Pages build: "${from.slice(0, 60)}" not found in ${p}. Update scripts/build-pages.mjs.`);
  return text.replaceAll(from, to);
}, read(p));

write('runtime.js', read('scripts/pages-runtime.js'));
write('app.js', swap('public/app.js', [
  ['Start a fresh event', 'Reset sample tournament'],
  ['Clear all teams, matches, and results from this local event. Download a backup first.', 'Restore the original fictional teams and clear this browser’s demo results.'],
  ['The sample tournament is active. The organizer can start a fresh event from Settings.', 'This public demo does not accept real registrations. A hosted backend is required before registration can open.'],
  ['You’re viewing a sample tournament. All teams are fictional. Open the tournament desk to explore, or start a fresh event in Settings.', 'Explore the tournament desk with fictional teams. Changes stay in this browser; this is not a shared live event.'],
  ['Fictional teams · Explore freely, then start a fresh event in Settings.', 'Fictional teams · Browser-local demo · No shared event data.'],
  ['This clears all teams, matches and results. Event settings are kept. Download a backup from Settings before continuing.', 'This restores the original sample tournament and clears demo changes in this browser.']
]));
write('tournament-browser.js', swap('lib/tournament.mjs', [["import { randomUUID, randomInt } from 'node:crypto';", `const randomUUID = () => crypto.randomUUID();
function randomInt(max) { const limit = Math.floor(0x100000000 / max) * max; let n; do { n = crypto.getRandomValues(new Uint32Array(1))[0]; } while (n >= limit); return n % max; }`]]));
write('index.html', swap('public/index.html', [['href="/', 'href="./'], ['src="/', 'src="./']]));
const manifest = JSON.parse(read('public/manifest.webmanifest'));
manifest.id = './'; manifest.start_url = './'; manifest.scope = './'; manifest.name = 'CARROMIA Demo';
manifest.icons.forEach(icon => icon.src = `.${icon.src}`);
write('manifest.webmanifest', JSON.stringify(manifest));
write('offline.html', swap('public/offline.html', [['href="/"', 'href="./"']]));
write('sw.js', swap('public/sw.js', [["'/offline.html'", "'./offline.html'"], ["'/icon.svg'", "'./icon.svg'"], ['carromia-shell-v1', 'carromia-pages-shell-v1']]));
write('.nojekyll', '');
console.log('Built GitHub Pages demo in dist/. No local event data or server secrets are included.');

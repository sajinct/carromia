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
write('tournament-browser.js', swap('lib/tournament.mjs', [["import { randomUUID, randomInt } from 'node:crypto';", `const randomUUID = () => crypto.randomUUID();
function randomInt(max) { const limit = Math.floor(0x100000000 / max) * max; let n; do { n = crypto.getRandomValues(new Uint32Array(1))[0]; } while (n >= limit); return n % max; }`]]));
write('index.html', swap('public/index.html', [['href="/', 'href="./'], ['src="/', 'src="./']]));
const manifest = JSON.parse(read('public/manifest.webmanifest'));
manifest.id = './'; manifest.start_url = './'; manifest.scope = './'; manifest.name = 'CARROMIA 2026';
manifest.icons.forEach(icon => icon.src = `.${icon.src}`);
write('manifest.webmanifest', JSON.stringify(manifest));
write('offline.html', swap('public/offline.html', [['href="/"', 'href="./"']]));
write('sw.js', swap('public/sw.js', [["'/offline.html'", "'./offline.html'"], ["'/icon.svg'", "'./icon.svg'"], ['carromia-shell-v1', 'carromia-pages-shell-v1']]));
write('.nojekyll', '');
console.log('Built the live GitHub Pages site in dist/. It reads and saves the event through Supabase; no local data or secret keys are included.');

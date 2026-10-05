// Creates (or updates) a tournament official in Supabase.
// Usage: npm run add-official -- <email> "<Full name>" <admin|official|checkin|lunch|umpire|media> [assigned boards, e.g. 1,3]
// A new account gets a generated password, printed once. Existing accounts keep their password.
import { randomBytes } from 'node:crypto';
import { supabaseStore } from '../lib/store.mjs';

const [email, name, role, boardList = ''] = process.argv.slice(2);
const boards = ['umpire', 'media'].includes(role) ? [...new Set(boardList.split(',').filter(Boolean).map(Number))].sort((a, b) => a - b) : [];
const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) throw new Error('Set SUPABASE_URL and SUPABASE_SECRET_KEY (see .env.example).');
if (!email?.includes('@') || !name?.trim() || !['admin', 'official', 'checkin', 'lunch', 'umpire', 'media'].includes(role) || (['umpire', 'media'].includes(role) && (!boards.length || boards.some(b => ![1, 2, 3, 4].includes(b))))) {
  console.error('Usage: npm run add-official -- <email> "<Full name>" <admin|official|checkin|lunch|umpire|media> [assigned boards, e.g. 1,3]'); process.exit(1);
}
const { call } = supabaseStore(SUPABASE_URL, SUPABASE_SECRET_KEY);
const address = email.trim().toLowerCase();

let user, password;
const { users } = await call('/auth/v1/admin/users?page=1&per_page=1000');
user = users.find(u => u.email?.toLowerCase() === address);
if (!user) {
  password = randomBytes(12).toString('base64url');
  user = await call('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ email: address, password, email_confirm: true }) });
}
await call('/rest/v1/officials?on_conflict=user_id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ user_id: user.id, name: name.trim(), role, boards }) });
console.log(`${name.trim()} <${address}> is now a tournament ${role}${boards.length ? ` on board${boards.length > 1 ? 's' : ''} ${boards.join(', ')}` : ''}.`);
if (password) console.log(`Temporary password (shown once, share privately): ${password}`);

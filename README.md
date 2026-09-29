# CARROMIA 2026

A responsive tournament website and installable web app for CARROMIA 2026, the four-board, two-player-team carrom tournament presented by Pithruvedhi of Mary Matha Church, Vijayanagar.

## Live site (GitHub Pages + Supabase)

https://sajinct.github.io/carromia/ is the live event site. The static app talks to Supabase directly: every visitor sees the same boards and bracket, updated within a few seconds, and officials run the desk from any phone or laptop.

- **Visitors** read `tournament_public`, a copy without mobile numbers, check-in tokens or desk activity.
- **Officials** sign in with their Supabase email and password. Their browser applies the tournament rules and saves through `save_tournament()`, which checks they are an official, rejects a save if someone else saved first (the app reloads and retries automatically), updates both copies together and writes the audit log.
- **Registration** goes through `register_team()`, which enforces the same rules as the app. It stays closed while the sample tournament is loaded.

### One-time setup

1. In the Supabase dashboard open **SQL Editor** and run, in order:
   `supabase/migrations/20260929000000_carromia_init.sql`, then `supabase/migrations/20260929010000_carromia_live.sql`.
   The second file also loads the 16-team sample tournament (it never overwrites an existing event, and is safe to re-run).
2. **Authentication → Users → Add user**: create an account for each official (tick *Auto confirm*).
3. Make them officials in the SQL Editor (`admin` can change settings, create the draw and clear data; `official` runs check-in, boards and results):

   ```sql
   insert into public.officials (user_id, name, role)
   select id, 'Your Name', 'admin' from auth.users where email = 'you@example.org';
   ```
4. Recommended: **Authentication → Sign In / Providers → turn off "Allow new users to sign up"**, so only accounts you create exist.

### Before the real event: clear the sample data

Sign in as an admin → **Settings → Start a fresh event** → **Download backup** (optional) → type `RESET`. This removes the sample teams, matches and results, keeps the event details (date, time, venue, timings) and reopens registration.

### Preview the build locally

```powershell
npm run build:pages
node scripts/preview-pages.mjs
```

Preview at http://localhost:3001/carromia/ (it uses the live Supabase data). Hash routes such as `#/admin` and `#/live` support direct links and reloads. The GitHub Actions workflow tests and publishes the site on every push to `main`. If the database layout changes, edit `scripts/write-live-migration.mjs` and run it to regenerate the migration.

## Run locally

Requires Node.js 22.9 or newer.

```powershell
npm install
npm start
```

Open http://localhost:3000. The tournament desk is at http://localhost:3000/admin. The local preview password is `carromia-demo`. To set your own password before starting:

```powershell
$env:ADMIN_PASSWORD = 'your-private-password'
npm start
```

The server binds to **127.0.0.1 only** unless `HOST` is set. It is a local first version, not a publicly deployed service. Open multiple browser tabs to test realtime updates. Live connections are capped at 200 (`MAX_STREAMS`); extra viewers fall back to refreshing every 15 seconds.

## Included

- Public event page and exactly-two-player registration.
- Unique team IDs, downloadable check-in QR codes, and a mobile-friendly confirmation.
- Password-protected desk with check-in, searchable teams, and contact details.
- Randomized single-elimination draw for 2–128 teams with automatic byes.
- Four boards, official-controlled assignment, countdowns, board reset and team rest periods.
- Remaining-coin results (0–9), explicit tie-break decisions, and winner advancement.
- Public `/live` screen, bracket, result export, and event settings.
- Local JSON persistence, realtime server events, full backup download.
- Web app manifest, install icons, and an offline notice. Match operations require a connection.

The empty initial event has no fictional registrations. Use **Load sample tournament** in the desk to explore 16 fictional teams; your event details and timings are kept. Sample mode blocks public registrations. Start a fresh event in Settings to use real data.

## Event workflow

1. Set event details; confirm the proposed knockout format with the committee.
2. Register teams through `/register` and check them in at the desk.
3. Review the team list, then create the draw. This closes registration.
4. Assign eligible matches to free boards and press Start match when players are ready.
5. When the timer ends, record each team's remaining coins. If a team clears all its coins before time, press **Coins cleared · End match** and enter 0 for that team; it wins immediately.
6. Equal counts keep the board occupied until an official resolves the tie and records the method.
7. Winners advance automatically. Boards become available after their reset period.

Existing match timers keep the duration set at their start. Settings affect future starts. The default is 10 minutes playing, 5 minutes board reset, and no mandatory team rest until the committee confirms one. For quick local testing, set matches to 1 minute and board reset to 0; restore event settings afterward.

QR URLs use `PUBLIC_URL` if provided, otherwise `http://localhost:3000`. A phone cannot reach this local preview via its own localhost. Configure an HTTPS public origin and production hosting before distributing codes to players. A QR opens a check-in confirmation for a signed-in official; scanning alone never changes attendance.

## Supabase (shared storage and named officials)

When `SUPABASE_URL` and `SUPABASE_SECRET_KEY` are set, the server stores the event in Supabase instead of the local file, and officials sign in with their own email and password. Without them, the app keeps its local file and single desk password.

1. **Create the tables.** In the Supabase dashboard open **SQL Editor**, paste `supabase/migrations/20260929000000_carromia_init.sql`, and run it. (With the Supabase CLI: `supabase link --project-ref vzxcqpgwvknonkhjinuk` then `supabase db push`.)
2. **Add your keys.** Copy `.env.example` to `.env` and paste the **Secret key** from Project Settings → API Keys. `.env` is git-ignored; never commit it or put the secret key in browser code.
3. **Add officials.** Admins can change settings, create the draw, reset and download backups. Officials can check in teams, run boards and record results.

   ```powershell
   npm run add-official -- asha@example.org "Asha Admin" admin
   npm run add-official -- omar@example.org "Omar Official" official
   ```

   New accounts get a temporary password printed once; officials can change it through Supabase's password reset. Re-running the command changes the name or role of an existing official.
4. **Optionally import local data:** `npm run import:supabase` copies `data/tournament.json` (it refuses to overwrite an existing Supabase event unless you add `--replace`).
5. `npm start`. The startup message confirms Supabase storage.

How it works: the event is one row in `public.tournament` with a version number. Every save must match the version the server last loaded, so two servers or a stale process can never overwrite each other; the losing request gets "please try again" and a refreshed view. Every sign-in, registration and desk action is written to `public.audit_log` with the official's name, and recorded results show who entered them. Row level security blocks all browser access to these tables; only the server's secret key can read them.

Run a single server instance. A second instance cannot overwrite data, but it shows stale screens until one of its own saves is rejected and it reloads.

## Data and backups

Without Supabase, data lives in `data/tournament.json` (or the `DATA_DIR` environment variable). Keep that directory private and backed up. **Settings → Download backup** includes contacts and QR tokens. To restore, stop the server, replace `data/tournament.json` with a compatible backup, and restart. Reset requires typing RESET and clears teams, matches, and results.

## Validation

```powershell
npm test
```

Tests cover bracket completion for every team count from 2–128, byes, check-in and occupancy guards, timing, rest periods, invalid scores, ties, winner dependencies, API access control, private contact filtering, persistence, and QR generation.

## Before a real event

This release is a local functional prototype. Production setup remains: HTTPS hosting, abuse protection beyond the basic per-connection registration limit (30 per 10 minutes), and backup/restore operations. Supabase storage and named officials are available (see above); desk sign-ins are held in server memory, so a restart signs officials out. It does not support concurrent server instances, result corrections after advancement, no-show forfeits, or draw editing.

Confirm event date, deadlines, fees, team capacity, tie-break/queen/foul/no-show rules, and rest policy. No payment collection or unconfirmed rules are implemented. The public information page describes the confirmed 10-minute rule; if the committee changes that rule, update the copy as well as the timer setting.

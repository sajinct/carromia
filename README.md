# CARROMIA 2026

A responsive tournament website and installable web app for CARROMIA 2026, the four-board, two-player-team carrom tournament presented by Pithruvedhi of Mary Matha Church, Vijayanagar.

## Live site (GitHub Pages + Supabase)

https://sajinct.github.io/carromia/ is the live event site. The static app talks to Supabase directly: every visitor sees the same boards and bracket, updated within a second or two over Supabase Realtime, and officials run the desk from any phone or laptop.

- **Visitors** read `tournament_public`, a copy without mobile numbers, check-in tokens or desk activity.
- **Officials** sign in with their Supabase email and password. Their browser applies the tournament rules and saves through `save_tournament()`, which checks they are an official, rejects a save if someone else saved first (the app reloads and retries automatically), updates both copies together and writes the audit log.
- **Registration** goes through the `registration` Edge Function, which uploads the players' photos and any payment screenshot to Supabase Storage and then calls `register_team()`, which enforces the same rules as the app. It stays closed while the sample tournament is loaded.
- **Pictures** are files in Supabase Storage, not in the database. Player photos (up to 2000px, with a 320px thumbnail for lists and the registration form) and payment screenshots go in the private `team-files` bucket, which only officials can open (through links that expire after an hour). The UPI QR code is in the public `event-assets` bucket at its full resolution. The database keeps only each file's path.

### One-time setup

1. In the Supabase dashboard open **SQL Editor** and run, in order:
   `supabase/migrations/20260929000000_carromia_init.sql`, `supabase/migrations/20260929010000_carromia_live.sql`, `supabase/migrations/20260930000000_carromia_practice.sql`, then `supabase/migrations/20260930010000_carromia_practice_devices.sql`, then `supabase/migrations/20261001000000_carromia_harden_save.sql` (the database derives the public copy itself and refuses non-admin changes to settings, teams and the draw on the real event), then `supabase/migrations/20261002000000_carromia_rules.sql` (registration enforces the team slots, teams per parish and deadline, records lunch bookings, and an event still on 10-minute matches moves to 30), then `supabase/migrations/20261003000000_carromia_registration_details.sql` (forane and parish from the diocese register, player ID proofs, and player photos only officials can see), then `supabase/migrations/20261004000000_carromia_payments.sql` (optional UPI payment at registration with pending teams the desk confirms, and the registration-form download checked against the primary player's mobile number), then `supabase/migrations/20261005000000_carromia_storage.sql` (the Storage buckets for photos, payment screenshots and the UPI QR code; registration then needs the `registration` Edge Function from step 5).
   Together they load the 16-team sample tournament into **practice mode** and open registration on the real event (existing real events are never overwritten; each file is safe to re-run).
2. **Authentication → Users → Add user**: create an account for each official (tick *Auto confirm*).
3. Make them officials in the SQL Editor (`admin` can change settings, create the draw and clear data; `official` runs check-in, boards and results):

   ```sql
   insert into public.officials (user_id, name, role)
   select id, 'Your Name', 'admin' from auth.users where email = 'you@example.org';
   ```
4. **Manage officials from the app (recommended):** Dashboard → **Edge Functions** → **Deploy a new function** → **Via editor**. Name it `officials`, replace the sample code with the contents of `supabase/functions/officials/index.ts`, and deploy. Then open the function's **Details** and turn **off** *Enforce JWT verification* (the function checks the caller itself). Admins then get an **Officials** page in the desk to add officials (a temporary password is generated and shown once), change roles, reset passwords and remove accounts. It refuses anyone who is not an admin, and admins can't remove themselves or their own admin role. Steps 2–3 are only needed for your first admin.
   Every official can change their own password: tap the initials at the top right of the desk (or **Change password** in the sidebar), enter the current password and the new one (at least 8 characters). They stay signed in on that device. An official who has forgotten their password asks an admin to reset it.
5. **Registration Edge Function (required):** deploy `supabase/functions/registration/index.ts` the same way as `officials`, named `registration`, and turn **off** *Enforce JWT verification* (visitors registering are not signed in). It holds the service key for the private `team-files` bucket: it uploads a registration's photos and screenshot, gives the registration-form download short-lived links to the photos, and deletes files nothing uses any more after a team is removed or the event is reset.
6. **Moving pictures saved before Storage was used** (once, only if teams registered before `20261005000000_carromia_storage.sql`): with `SUPABASE_URL` and `SUPABASE_SECRET_KEY` in `.env`, run `npm run move:images`. It copies each old photo, screenshot and UPI QR code into Storage and records its path (old photos keep their original small size). When it reports nothing left to move, run `supabase/migrations/20261006000000_carromia_storage_cleanup.sql` to drop the old picture columns.
   Deploy order for an existing site: the storage migration, then the `registration` function, then the new site build, then `npm run move:images`, then the cleanup migration.
7. **Live updates:** run `supabase/migrations/20261008000000_carromia_realtime.sql` (after `20261007000000_carromia_group_registration.sql`), then `supabase/migrations/20261009000000_carromia_realtime_versions.sql`. Whenever the public copy changes, the database sends a Realtime message `changed` with just `{ version, practiceOff }` on the public channel `tournament:main` or `tournament:practice`. Open screens then fetch the event right away, rather than checking every few seconds. On joining the channel, a screen calls `tournament_versions()` once. It returns the current versions and confirms the database sends these messages, so the screen stops checking straight away. Keep **Project Settings → Realtime → Allow public access** on (the default). Without the migrations, or while a screen's connection is down, screens check the version every 10 seconds. Each visible tab holds one Realtime connection (the Free plan allows 200 at once), and hidden tabs let go of theirs.
8. Recommended: **Authentication → Sign In / Providers → turn off "Allow new users to sign up"**, so only accounts you create exist.

### Registration, practice mode and team removal

- **Registration** is open on the real event as soon as the setup is run. It closes when an admin unticks *Registration open* in Settings or creates the draw, at the end of the registration deadline day (10 Nov 2026, India time), or when every team slot is taken (64). One parish can register up to 4 teams; parish names are compared without capitals, punctuation or the words "church" and "parish". Players confirm they are 18 or older and can pre-book lunch. With **Lunch coupons** ticked in Event settings (off by default), the registration form ends with a tear-off coupon per lunch booked; its QR code opens the **Lunch counter** page for a signed-in official, who taps *Serve* so each lunch is served once (Teams shows booked and served, with *Undo*). Slots, teams per parish, deadline and entry fee are changed in **Event settings**; the deadline does not apply in practice mode.
- **Event information and rules** shown on the home page and the **Rules** page (prizes, day schedule, Mass timings, documents to bring, the 16 rules) are in `public/info.js`.
- **Practice mode** rehearses the whole event on a separate practice tournament, on any device. An official opens it from Settings → Open practice mode; the panel then shows links and QR codes for a **TV** (live boards), **phones** (registration) and **official phones** (desk). Any device opened with `?practice=1` follows the practice event and shows a yellow PRACTICE MODE banner until someone taps **Exit practice**. **Start empty practice** clears practice teams and opens practice registration (register → check in → draw → play → winners); **Load sample tournament** gives a ready-made draw. The public site and real registrations are never affected, and any official may try every action in practice.
- **Turning practice mode off** (admins, from the real event): Settings → Practice mode → **Turn off for all devices**. No one can open practice mode, devices still in it go back to the real event at their next refresh, and practice links open the real event. Practice data is kept; **Turn practice mode back on** in the same panel restores it.
- **Removing a team** (admins, real event, before the draw): Teams → Remove. The team and its contact details are deleted and its ID is never reused. After the draw, teams can’t be removed because the bracket depends on them.
- **Walkover / no-show** (admins): Match control → queue → **Walkover**. Choose the team that advances and a reason; the match is completed without play, no check-in or rest period is needed, and later rounds update. **Results → Undo walkover** puts it back in the queue while the next round hasn’t been called.
- **Correcting a result** (admins): Results → **Correct**. Choose the winner of each round, in order, up to the round that decided the match; the winner is worked out again and later rounds are re-derived. Possible only until the winner’s next match is called; the original time is kept and the result is marked *Corrected*.
- **Starting over** (admins): Settings → Start a fresh event → type `RESET`. It clears teams, matches and results, keeps the event details and reopens registration.

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

- Public event page with entry fee, prizes, day schedule and a rules page; exactly-two-player registration with team slots, a per-parish limit, a deadline, the 18+ confirmation and lunch pre-booking.
- Unique team IDs, downloadable check-in QR codes, and a mobile-friendly confirmation.
- Password-protected desk with check-in, searchable teams, and contact details.
- Randomized single-elimination draw for 2–128 teams with automatic byes.
- Four boards, official-controlled assignment, countdowns, board reset and team rest periods.
- Matches in timed rounds (best of 3 rounds of 10 minutes by default): officials mark each round’s winner as the umpire decides it, start the next round, and the winner advances.
- Public `/live` screen, bracket, result export, and event settings.
- Public `/results` page for phones: the champions, the matches on the boards now, every result by round (searchable by team) and the bracket, updating by itself. The live screen shows a **Scan for results** QR code that opens it; a TV in practice mode points phones to the practice results. The QR card is also a link: clicking or tapping it opens the results directly, and on phone-width screens it shows as an **Open live results** button without the QR image.
- Local JSON persistence, realtime server events, full backup download.
- Web app manifest, install icons, and an offline notice. Match operations require a connection.

The empty initial event has no fictional registrations. Use **Load sample tournament** in the desk to explore 16 fictional teams; your event details and timings are kept. Sample mode blocks public registrations. Start a fresh event in Settings to use real data.

## Event workflow

1. Set event details; confirm the proposed knockout format with the committee.
2. Register teams through `/register` and check them in at the desk.
3. Review the team list, then create the draw. This closes registration.
4. Assign eligible matches to free boards and press Start match when players are ready.
5. A match is played in rounds, each with its own timer (best of 3 rounds of 10 minutes by default). When the umpire decides a round, whether or not its time has run out, press that team’s button under **Round N won by** on the board and confirm. Then press **Start round N** once the players have changed seats. A mis-tap can be taken back with ↩ while the match is in play.
6. The first team to win most of the rounds (2 of 3) wins the match; the live screen shows the round in play, its timer and the rounds won.
7. Winners advance automatically. Boards become available after their reset period.

A match keeps the rounds and round length set when it started; settings affect future starts. The default is 3 rounds of 10 minutes, 5 minutes board reset, and no mandatory team rest until the committee confirms one. For quick local testing, set rounds to 1 minute and board reset to 0; restore event settings afterward.

QR URLs use `PUBLIC_URL` if provided, otherwise `http://localhost:3000`. A phone cannot reach this local preview via its own localhost. Configure an HTTPS public origin and production hosting before distributing codes to players. A QR opens a check-in confirmation for a signed-in official; scanning alone never changes attendance. A lunch coupon's QR opens the lunch counter the same way.

## Supabase (shared storage and named officials)

When `SUPABASE_URL` and `SUPABASE_SECRET_KEY` are set, the server stores the event in Supabase instead of the local file, and officials sign in with their own email and password. Without them, the app keeps its local file and single desk password.

1. **Create the tables.** In the Supabase dashboard open **SQL Editor**, paste `supabase/migrations/20260929000000_carromia_init.sql`, and run it. (With the Supabase CLI: `supabase link --project-ref vzxcqpgwvknonkhjinuk` then `supabase db push`.)
2. **Add your keys.** Copy `.env.example` to `.env` and paste the **Secret key** from Project Settings → API Keys. `.env` is git-ignored; never commit it or put the secret key in browser code.
3. **Add officials.** Admins can change settings, create the draw, reset and download backups. Officials can check in teams, run boards and record results.

   ```powershell
   npm run add-official -- asha@example.org "Asha Admin" admin
   npm run add-official -- omar@example.org "Omar Official" official
   ```

   New accounts get a temporary password printed once; officials change it in the desk under **Change password**. Re-running the command changes the name or role of an existing official.
4. **Optionally import local data:** `npm run import:supabase` copies `data/tournament.json` (it refuses to overwrite an existing Supabase event unless you add `--replace`).
5. `npm start`. The startup message confirms Supabase storage.

How it works: the event is one row in `public.tournament` with a version number. Every save must match the version the server last loaded, so two servers or a stale process can never overwrite each other; the losing request gets "please try again" and a refreshed view. Every sign-in, registration and desk action is written to `public.audit_log` with the official's name, and recorded results show who entered them. Row level security blocks all browser access to these tables; only the server's secret key can read them.

Run a single server instance. A second instance cannot overwrite data, but it shows stale screens until one of its own saves is rejected and it reloads.

## Data and backups

Without Supabase, data lives in `data/tournament.json` (or the `DATA_DIR` environment variable), with player photos, payment screenshots and the uploaded UPI QR code as image files in `data/uploads/`. With Supabase, the server keeps those files in the same Storage buckets as the live site (run `20261005000000_carromia_storage.sql`) and passes them on to signed-in officials itself. Keep that directory private and backed up. **Settings → Download backup** includes contacts and QR tokens. To restore, stop the server, replace `data/tournament.json` with a compatible backup, and restart. Reset requires typing RESET and clears teams, matches, and results.

## Validation

```powershell
npm test
```

Tests cover bracket completion for every team count from 2–128, byes, registration limits and the deadline, check-in and occupancy guards, timing, rest periods, marking, starting and taking back rounds, result corrections, winner dependencies, API access control, private contact filtering, persistence, and QR generation.

## Before a real event

This release is a local functional prototype. Production setup remains: HTTPS hosting, abuse protection beyond the basic per-connection registration limit (30 per 10 minutes), and backup/restore operations. Supabase storage and named officials are available (see above); desk sign-ins are held in server memory, so a restart signs officials out. It does not support concurrent server instances or draw editing; a result can be corrected only until the winner’s next match is called.

The entry fee is shown but not collected or tracked by the app. The rules page and home page describe the published rules (best of three games, 10 minutes each); if the committee changes them, update `public/info.js` as well as the rounds settings.

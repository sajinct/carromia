# CARROMIA 2026

A responsive tournament website and installable web app for a four-board, two-player-team carrom event.

## GitHub Pages

The public GitHub Pages deployment is an **interactive demo** with fictional teams. It runs entirely in the browser, stores sample changes in local storage, and does not accept real registrations or synchronize event data between devices. No desk password is required for this demo. The local Node application below retains its server-backed registration and protected desk.

```powershell
npm run build:pages
node scripts/preview-pages.mjs
```

Preview at http://localhost:3001/carromia/. Hash routes (for example `#/admin` and `#/live`) support direct links and reloads on GitHub Pages. The GitHub Actions workflow tests and publishes the site on pushes to `main`. The build copies only public assets and the demo engine; local tournament data, passwords, and dependencies are excluded. Real public tournament use requires a hosted backend.

## Run locally

Requires Node.js 22 or newer.

```powershell
npm install
npm start
```

Open http://localhost:3000. The tournament desk is at http://localhost:3000/admin. The local preview password is `carromia-demo`. To set your own password before starting:

```powershell
$env:ADMIN_PASSWORD = 'your-private-password'
npm start
```

The server binds to **127.0.0.1 only**. It is a local first version, not a publicly deployed service. Open multiple browser tabs to test realtime updates.

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

The empty initial event has no fictional registrations. Use **Load sample tournament** in the desk to explore 16 fictional teams. Sample mode blocks public registrations. Start a fresh event in Settings to use real data.

## Event workflow

1. Set event details; confirm the proposed knockout format with the committee.
2. Register teams through `/register` and check them in at the desk.
3. Review the team list, then create the draw. This closes registration.
4. Assign eligible matches to free boards and press Start match when players are ready.
5. When the timer ends, record each team's remaining coins.
6. Equal counts keep the board occupied until an official resolves the tie and records the method.
7. Winners advance automatically. Boards become available after their reset period.

Existing match timers keep the duration set at their start. Settings affect future starts. The default is 10 minutes playing, 5 minutes board reset, and no mandatory team rest until the committee confirms one. For quick local testing, set matches to 1 minute and board reset to 0; restore event settings afterward.

QR URLs use `PUBLIC_URL` if provided, otherwise `http://localhost:3000`. A phone cannot reach this local preview via its own localhost. Configure an HTTPS public origin and production hosting before distributing codes to players. A QR opens a check-in confirmation for a signed-in official; scanning alone never changes attendance.

## Data and backups

Data lives in `data/tournament.json` (or the `DATA_DIR` environment variable). Keep that directory private and backed up. **Settings → Download backup** includes contacts and QR tokens. To restore, stop the server, replace `data/tournament.json` with a compatible backup, and restart. Reset requires typing RESET and clears teams, matches, and results.

## Validation

```powershell
npm test
```

Tests cover bracket completion for every team count from 2–128, byes, check-in and occupancy guards, timing, rest periods, invalid scores, ties, winner dependencies, API access control, private contact filtering, persistence, and QR generation.

## Before a real event

This release is a local functional prototype. Production setup remains: HTTPS hosting, a shared transactional database (Supabase was proposed), named official accounts and audit history, rate limits for public registration, and backup/restore operations. The current file store supports one server process, and the desk uses one password with in-memory sessions. It does not support concurrent server instances, result corrections after advancement, no-show forfeits, or draw editing.

Confirm event date, deadlines, fees, team capacity, tie-break/queen/foul/no-show rules, and rest policy. No payment collection or unconfirmed rules are implemented. The public information page describes the confirmed 10-minute rule; if the committee changes that rule, update the copy as well as the timer setting.

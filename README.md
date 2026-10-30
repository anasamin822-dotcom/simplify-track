# Track - Simplify Money frontend assignment

React Native (Expo) app for the Track screen: every transaction across the
user's accounts, month by month, with honest spend/income totals, merchant
search, full transaction detail, and sync that survives a hostile network.

## Run it (under 5 minutes)

Needs Node 22.23+ and an Android emulator or a phone with Expo Go.

```bash
# 1. the mock API (separate shell; from the track-api-mock repo)
node server.js            # http://0.0.0.0:4010

# 2. the app
npm install
npm start                 # then press 'a' for Android emulator, or scan the QR with Expo Go
```

In development, the server address is set automatically for the Android
emulator (`10.0.2.2`). On a real phone in development (Expo Go / dev build):
same Wi-Fi, open the gear icon, enter `http://<your computer's LAN IP>:4010`,
tap "Save and sync".

Release builds follow Android's default network policy and only reach
`https://` endpoints, so a release APK must point at the mock through an
`https://` URL instead (gear icon, paste the URL, "Save and sync").

## Verify the numbers

```bash
npm run verify
```

Runs a full + incremental sync against the mock server (including its
injected 500/429/503s) and prints every month's spend and income next to
`fixtures/checkpoint.json`. All 13 months and the 4,686 count match exactly.

## Test

```bash
npm test          # 46 tests: units + integration + hostile-server
npm run typecheck # app and tests, both strict
```

## What's here

| Path | What |
|---|---|
| `src/core/normalize.ts` | Both API record shapes -> one canonical type. Exact decimal-string money parsing. |
| `src/core/sync.ts` | Resumable full sync + incremental changes sync. Kill-safe, race-safe, 410-aware. |
| `src/core/totals.ts` | IST month bucketing, honest spend/income rules. |
| `src/core/store.ts` / `sqlite.ts` / `localstore.web.ts` / `storeFactory.*.ts` | Storage boundary: SQLite on device, localStorage on web, in-memory in tests. |
| `src/ui/` | Track screen, search, detail, server settings. |
| `docs/DECISIONS.md` | Decision log. |
| `docs/DATA.md` | What the data made me decide. |
| `docs/PR_REVIEW.md` | PR #412 review. |
| `docs/AI_DISCLOSURE.md` | AI tools used, with a concrete wrong-output case. |
| `docs/UNFINISHED.md` | What's not done. |

## Why Expo (not bare)

The assignment's hard problems are data and sync, not native modules.
Everything the screen needs (storage, lists, navigation) is in Expo's SDK,
and `npx expo prebuild` keeps the bare path open if a native need appears.
One command runs it, and EAS Build produces the APK without local SDK setup.

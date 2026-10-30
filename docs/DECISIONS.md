# Decision log

Ten entries, as the assignment asks. The full twenty-entry working log is kept
as an appendix below - same words, nothing re-written.

1. **Storage boundary before UI.** I wrote the `Store` contract (page-atomic
   `commit`, meta key-values, by-id lookup) before any screen code, with three
   implementations: SQLite on device, localStorage on web, in-memory in tests.
   Every correctness test runs against the same contract the app uses, and the
   sync engine doesn't know or care which store is underneath. Rejected:
   syncing straight into React state (can't survive a kill), and Redux/MMKV
   (dependencies I didn't need).

2. **Integer minor units everywhere; divide only at display.** The PR I
   reviewed divides by 100 per row and sums floats - that drifts paise over a
   year of transactions. All money in the app is integer minor units; grouping
   and decimals happen in one formatter. The legacy records made this real:
   their amounts are decimal *strings* ("516.49"), parsed exactly
   (`"516.49"` -> `51649`), rejecting anything with sub-paise precision
   instead of silently rounding.

3. **Months are Asia/Kolkata, not UTC.** The checkpoint disagreed with my
   first totals by exactly the salary amount in some months - the salary
   credits at 00:30 IST on the 1st, which is still "last month" in UTC.
   Users in India think in IST months. +05:30 is fixed (no DST in India), so
   a constant offset is exact, not approximate. This also became PR comment #7.

4. **Latest truth = latest `updated_at`, not feed order.** My first
   incremental sync applied the changes feed in array order. The fixture
   contains a transaction whose POSTED version (₹89.00, 19:53) is followed
   *later in the same feed* by its own stale PENDING version (₹39.00, 19:23).
   Feed order gives ₹39.00 and the October total is exactly ₹50 off the
   checkpoint. Now every incoming version is compared by `updated_at` against
   both the batch and the stored row. Details in DATA.md.

5. **Full sync commits page by page, and the token only at the end.** Each
   completed page (rows + resume cursor + seen-ids) is committed before the
   next request. Killing the app mid-sync loses at most one in-flight page,
   and the resume cursor is position-based so it picks up where it stopped.
   The `sync_token` is stored only after the last page - storing it earlier
   would make a partial history look fully synced. There's a test that kills
   the sync on page 2 and resumes.

6. **Own-transfer detection from schema fields only.** Records name their own
   counterparties: `counterparty.type === "OWN_ACCOUNT"` (modern) and
   `linked_account` (legacy). I deliberately did not match merchant text
   ("SELF TRANSFER TO XX9075") because the same data also has
   `UPI/RAHUL SHARMA` transfers that ARE spend (rent to another person), and
   hidden data will have more phrasings. A transfer is own-money only when the
   record says so.

7. **Refunds are income, pending rows count.** Documented inferences (the
   brief doesn't prescribe either): a refund is money back in, and it can land
   months after the purchase, so it goes to income rather than erasing spend.
   Pending authorisations are real holds on the user's money, so they count
   and are badged; the changes feed replaces them with their posted versions.
   Both choices reproduce the checkpoint exactly, which is evidence, not proof.

8. **The checkpoint is an oracle for my code, not input to it.** No fixture
    value is hardcoded anywhere in `src/`. `npm run verify` reads
    `checkpoint.json` at runtime and diffs. When my numbers and the checkpoint
    disagreed, three times, each time the bug was mine (UTC months, feed
    order, and once my own mental arithmetic confirming a sum the script had
    already told me was wrong).

9. **A bad record never stops the pipeline, and a skip is always visible.**
    The server is announced as surprising ("different surprises in the same
    places"), so both sync loops quarantine per record: a record that fails
    validation is caught and the rest of the page commits. The skip is
    recorded as an exact unique count plus bounded {id, reason} examples and
    a bounded id set; an entry clears only when that record later reads
    cleanly or is deleted - a follow-up sync that skips nothing never erases
    the warning, and the warning is not eternal either. The dashboard shows
    the exact count with "totals may be incomplete" - skipping must never
    look like success. If a server gets more than 1000 distinct records
    skipped, resolves of untracked ids become invisible, so the count is an
    upper bound: the banner switches to "Up to N" and says a full resync
    will confirm the exact count, which it does, from scratch. Unexpected non-validation errors still abort the
    sync, because those are my bugs, not data.

10. **Local data belongs to one backend - and replacing it is the user's
    decision, never the app's.** The data-source stamp lives in meta
    (data_source_url). A new URL whose server still accepts our sync token
    just keeps syncing (e.g. a rotated tunnel hostname in front of the same
    backend). A server that rejects the token (410) cannot be told apart
    from an expired token on the same backend - so the app treats both
    conservatively: if the stamp matches the current URL it re-downloads
    (same backend, token expired); if the stamp differs it stops and asks.
    Settings shows "Replace with this server" vs "Keep my history" (which
    restores the previous URL; nothing is touched while asking). Every
    replace path - the confirmed switch and the same-backend token-expiry
    re-download - is staged: the download is buffered in memory and written
    as one store commit (new rows, drops of rows the server does not have,
    account replacement, stamp) only after it completes. A failure,
    cancellation or crash mid-download therefore changes nothing on disk.
    Trade-off: a staged replace cannot resume mid-way and always restarts.
    Cosmetic URL edits (trailing slash) are not a switch. Installs from
    before the stamp existed get stamped on their next successful sync.
    Until then their history's source is unknowable, so a 410 with local
    rows asks exactly like a known-different backend, with the source named
    as "never recorded" - the app never silently adopts a history it
    cannot place. Only an empty store (nothing to lose) recovers
    automatically.

## Appendix - extended decision archive

The remaining working-log entries, kept for the record. Numbers are the
original working-log numbers.

7. **FX rows count at the bank's settled INR value.** The USD subscription
   records carry `fx.inr_minor` - the exact amount that left the account in
   rupees. Totals use that, never an estimated conversion rate. Rows whose INR
   value is unknown are excluded from INR totals *and surfaced* as
   "not in totals" on the month header, so the number shown is never silently
   incomplete.

9. **Expo over bare.** See README. The interesting bit is what it cost me:
   nothing on the sync/data side, and the web export it gave me for free is
   how I screenshot-tested the UI without an emulator.

12. **Pagination is bounded; a stuck cursor is an error, not a loop.** Full
    and incremental syncs stop after 500 committed-safe pages (~50x the real
    history) or immediately on a non-advancing cursor, saying exactly what
    happened and keeping already-synced rows. The seen-id set for boundary
    dedupe is no longer persisted: resume re-reads one boundary row, whose
    primary-key upsert plus updated_at comparison makes the identical
    re-send a no-op. That removes an O(pages x history) meta write.

13. **Long Retry-After pauses the sync; it is never clamped into an early
    retry.** Honouring Retry-After means not calling back before the server
    allowed. A server-directed wait over 30s ends the attempt, persists the
    server's own eligible time, and every later sync (boot, pull-to-refresh,
    Settings) short-circuits without a single request until that time -
    scoped to the backend that issued it. No sleeping for hours, no retrying
    at 30s against the server's word. The mock's real 2-3s values pass
    through untouched.

14. **Equal updated_at keeps the incumbent.** The changes feed can deliver
    the same record twice; on an exact timestamp tie, flipping would make the
    result depend on feed order, so the first-seen version wins. A genuinely
    changed record carries a newer updated_at by contract.

15. **track.db stays out of Android Auto Backup.** The app holds a full
    local copy of financial history; `plugins/withNoBackup.js` sets
    android:allowBackup="false" at prebuild (verified in the generated
    manifest). Trade-off accepted: uninstall/reinstall loses the local copy
    and the next launch re-syncs it from the server, which the sync engine
    is built to do anyway.

17. **Server error text is bounded before it reaches the UI.** API error
    messages carry the server's body capped at 160 characters; a hostile or
    buggy server cannot write a wall of text into our screens.

18. **Settings validates the URL before saving.** Empty, unparseable, or
    non-http(s) values get an inline error and never reach the sync engine.
    http stays valid on purpose: the documented dev flow (emulator
    10.0.2.2, same-Wi-Fi LAN IP) is plain http; release builds use https.

19. **One accent, semantic money colours, real type - decoration never carries
   meaning.** The visual redesign keeps a single indigo-violet accent for
   chrome (buttons, focus, glows) while spend stays red and income green, so
   colour meaning never depends on the theme. Display numerals are Sora, text
   is Inter, both bundled OFL fonts loaded with expo-font so the APK and the
   web preview render identically. Surfaces are tinted glass over a
   deep-space gradient with two static light blooms - no blur filters, no
   animation libraries, so the list keeps 60fps room and the native build
   gains only expo-font/expo-linear-gradient, both stock Expo modules. Every
   screen was verified as rendered pixels (headless Chrome screenshots at
   390x844 and 1440x900 against the real mock), not by reading the styles.

20. **An edge failure with no body gets status-class guidance, never "API
   530: null".** A dead reverse proxy (expired tunnel, gateway 502) often
   returns 5xx with no JSON body, and the raw fallback "API <status>: null"
   is not words a user can act on. When an ApiError carries no usable body,
   the message is built from the status class instead: 5xx says the server
   is having trouble, 404 points at the URL setting, 429 says the server
   asked us to slow down. It deliberately claims nothing about data state:
   incremental sync keeps pages committed before a failure, so "nothing
   changed" would be false there. A real server body still shows as-is,
   bounded (entry 17).

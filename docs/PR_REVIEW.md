# PR #412 — "Track: load transactions from the new API"

Reviewed as if this were a real merge request on our app. Most important first.
Each comment says block or let through, and why. (One reviewer already approved;
I disagree with the approval.)

---

**1. BLOCK — `catch { setTransactions([]) }` destroys the user's data on any failure.**
`useTransactions.ts`, `load()`. Any network hiccup, any malformed page, any 500
(this server emits scheduled 500/429/503s) empties the list the user was looking
at. "A failure never costs the user what they could already see" is the whole
point of a money app. Keep the last good data; show the error alongside it.
The full-screen `if (error) return <Text>{error}</Text>` in the screen has the
same problem: one failed refresh erases a year of history from view.

**2. BLOCK — duplicate transactions at every page boundary.**
`page()` on the server re-sends the boundary record with each cursor (it's in
the README's own example flow, and easy to verify with two requests).
`[...transactions, ...body.items]` appends it again, so every 50th transaction
shows twice. "Every transaction appears exactly once." Dedupe by `id`.

**3. BLOCK — no incremental sync: updates and deletions never arrive.**
The hook only ever calls `GET /v1/transactions`. The API's `changes` endpoint
exists precisely because rows mutate: pending authorisations settle at a
different amount, transactions get removed. As written, a deleted transaction
stays on screen forever and a pending flip never lands — "the latest truth
wins" fails. It also re-downloads the entire history on every pull-to-refresh.
Use `sync_token` + `/v1/transactions/changes`, fall back to a full sync on 410.

**4. BLOCK — money is handled as floats.**
`monthTotal` does `amount_minor / 100` per row and sums floats; the header then
`toFixed(2)`s the result. Float addition over hundreds of rows drifts paise.
"Money is exact" means integer minor units end to end; divide only at display.

**5. BLOCK — own-account transfers counted as spend.**
`monthTotal` sums every debit. The data contains transfers between the user's
own accounts (the record tells you via `counterparty.type === "OWN_ACCOUNT"`),
and moving your own money is neither spending nor earning. The month header is
wrong for any month with a credit-card payment or a self transfer.

**6. BLOCK — HTTP status is never checked.**
`await res.json()` runs regardless of status. A 500 page parses (or throws into
the data-wiping catch), a 429's `Retry-After` is ignored, and the user hammering
refresh makes rate limiting worse. Check `res.ok`, honour `Retry-After`, back
off on 5xx, and surface the state without touching stored data.

**7. Let through, must fix before this pattern spreads — UTC month bucketing.**
`occurred_at.slice(0, 7)` groups by UTC month. Our users are in India: a
transaction at 1 Oct 00:30 IST (30 Sep 19:00 UTC) belongs to October for them.
The salary credit in this very dataset lands across that boundary. Bucket in
Asia/Kolkata (fixed +05:30, no DST).

**8. Let through — index keys on a paginated list.**
`keyExtractor={(_, index) => String(index)}` over a list that grows by appends
and has injected month headers means React reuses rows incorrectly; with any
future removal/reorder it renders wrong rows and drops component state. The
transaction has a stable unique `id`; use it.

**9. Let through — wrong formatting for India, wrong symbol for FX.**
`toLocaleString('en-US')` renders 109,784.98 instead of 1,09,784.98, and `₹` is
hardcoded while the data contains USD records (each carrying its settled
`fx.inr_minor`). en-IN grouping; original currency for FX rows.

**10. Let through — unguarded concurrent loads.**
`onEndReached` fires repeatedly while `load()` is in flight; each call reads a
stale `transactions`/`cursor` from closure and appends an overlapping page.
`loading` is set but never consulted. Guard on an in-flight flag and the
current cursor.

---

**Verified against my own implementation:** every one of these is handled in the
submitted app — page-atomic commits that keep stored data on failure (1), id
dedupe at cursor boundaries (2), `changes`-feed sync with 410 fallback and
`updated_at`-ordered application (3), integer minor-unit math (4), schema-based
own-transfer exclusion (5), `Retry-After`-aware retries (6), IST bucketing (7),
id keys (8), en-IN formatting with FX rows shown in original currency (9), and
a sync lock that rejects concurrent runs (10). The integration tests cover 1-6
directly against the live mock server.

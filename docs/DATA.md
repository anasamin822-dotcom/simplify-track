# What the data made me decide

The README warns the data is "real-shaped, which means it is not tidy".
Here's what I actually found in it, and what each finding changed in the app.

## Two record shapes in one feed

2,281 of 4,675 full-list rows are a legacy bank-export shape:
`{ id: "115509", account: "4821", txn_time: <epoch seconds>, amount: "516.49",
type: "DR", merchant_name, category, status, linked_account? }` - no
`occurred_at`, no `amount_minor`, no `currency`, no `updated_at`. The rest are
the documented modern shape. Legacy covers 2025-09 to 2026-03; modern starts
2026-03. They overlap in March 2026.

Decisions: normalize at the sync boundary into one canonical type and keep the
verbatim record on every row (the detail screen can show the exact server
record). Legacy amounts are decimal strings in MAJOR units - parsed exactly,
never `parseFloat * 100`. Legacy rows have no `updated_at`, which matters for
conflict resolution: they lose to any version that has one. Legacy rows have
no currency field; the export is a domestic bank feed, so INR - recorded in
the decision log as an assumption, and the totals bear it out.

## The changes feed is not ordered by time

`txn_DAFC2853FA16EBD510BC` appears twice in one changes feed: first as POSTED
₹89.00 (`updated_at` 19:53:33), then again as PENDING ₹39.00 (`updated_at`
19:23:33) - the *stale* version comes later in the array. Two more ids are
duplicated identically. Apply-in-order and you show the user ₹39.00 pending
when the truth is ₹89.00 posted; October's spend is exactly ₹50.00 off the
checkpoint. "The latest truth wins" has to mean latest `updated_at`, so every
incoming record is compared against the batch and the stored row.

## The cursor re-sends the boundary record

`next_cursor` is position-based and the next page includes the previous page's
last row. Without id dedupe, every 50th transaction shows twice
(non-negotiable #1). The full sync dedupes by id and persists the seen-id set
with the resume cursor, so a killed sync doesn't reintroduce them.

## Scheduled server failures

The server 500s on the 6th list request, 429s with `Retry-After: 3` on the
11th, 503s with `Retry-After: 2` on the first changes call, and has 2.6-4.2s
slow pages. The client honours `Retry-After`, backs off on 5xx with a bounded
retry count, and - most importantly - a failed sync leaves stored data
untouched, because pages commit one at a time. The hostile-server integration
test rides through all of this and lands exactly on the checkpoint.

## Own transfers vs real transfers

50 records are transfers between the user's own accounts (self transfers and
credit-card bill payments). Modern rows mark them with
`counterparty.type === "OWN_ACCOUNT"`; legacy rows with `linked_account`.
Separately, 44 debits are `TRANSFERS_OUT` to `UPI/RAHUL SHARMA` with no
own-account marker - that's rent or similar to another person, and it IS
spend. Category alone doesn't decide this; the schema link does.

## FX records carry their settled INR value

15 USD subscription rows (Notion, Apple, ChatGPT) each carry
`fx.inr_minor` - what actually left the account in rupees, at rates that vary
month to month. I use that exact value in totals and show the original USD
amount with the settled ₹ equivalent in the UI. I did not fetch or estimate
exchange rates.

## Odd bits handled, not dropped

- 3 rows with no category (shown as "Uncategorised", still counted).
- 1 row in 2025-09 (before the main history starts) - it gets its own month
  section like any other.
- Merchants in Devanagari and with emoji (`राम किराना स्टोर`,
  `☕ Third Wave Coffee`) - search lowercases but otherwise treats them as
  plain strings; no normalization that could drop a match.
- `summary_months.json` disagrees with `checkpoint.json`: the summary endpoint
  includes own-account transfers in its totals (I verified the difference is
  exactly the transfer amounts). The checkpoint is the honest one; the app
  computes its own totals from row-level data and the verify script checks
  them against the checkpoint.
- The full list itself is a snapshot; 25 rows in it are PENDING versions that
  the changes feed then settles at different amounts. A full sync alone is
  not the truth - it must always be followed by the changes pass. (My first
  version didn't, and the checkpoint caught it: ₹92,288.75 vs ₹1,09,784.98
  for October.)

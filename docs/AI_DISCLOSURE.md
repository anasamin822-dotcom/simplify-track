# AI disclosure

Built with an AI pair-programming assistant doing most of the typing, me
directing and verifying. Also used it to analyse the fixtures and to review
its own PR review.

Where it was wrong, concretely - the checkpoint caught each of these:

**Case 1: feed order treated as truth.**
Its first sync engine applied the changes feed in array order:

```ts
for (const item of page.items) {
  if (item.deleted === true) deletes.push(item.id);
  else upserts.push(normalizeRecord(item));   // last array entry wins
}
```

The fixture contains a transaction whose stale PENDING version (₹39.00,
updated 19:23) appears *after* its POSTED version (₹89.00, updated 19:53).
October spend came out ₹50.00 under the checkpoint. The fix compares
`updated_at` on every upsert, against both the batch and the stored row:

```ts
const stored = await this.store.txnsByIds([...batchBest.keys()]);
for (const [id, t] of batchBest) {
  if (newerOf(stored.get(id), t) === t) upserts.push(t);
}
```

There is a regression test named after the trap
("stale changes-feed entry never overwrites a newer stored version").

**Case 2: full sync considered enough.** Its first app boot ran only the
full-list sync. But the full list is a snapshot; the changes feed settles 25
pending rows at different amounts and adds new ones. October showed
₹92,288.75 instead of ₹1,09,784.98 - the exact bug the checkpoint walkthrough
exists to catch. The app now always follows a full sync with the incremental
pass.

**Case 3: its arithmetic confirmation was wrong and I repeated it.** While
reconciling FX totals it computed 86,661 + 25,853 + 173,570 as 291,084 (it's
286,084) and declared the FX theory confirmed. The script disagreed by ₹50.00,
which is how Case 1 was found. Lesson applied everywhere after: totals are
compared by code against the checkpoint, never by eye.

The pattern: its code is plausible and usually close, and every one of these
looked done. The checkpoint plus "run the hostile server, don't simulate it"
is what made them visible. I wouldn't have caught #1 by reading the code -
it reads correctly.

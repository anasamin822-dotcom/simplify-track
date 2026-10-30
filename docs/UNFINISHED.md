# Unfinished / honest gaps

- **Task 0 (mandatory in the brief): in progress, stated as such in the
  one-pager.** The production app is installed and onboarding is started.
  Two friends' reported feedback with real screenshots is collected; a
  third friend's feedback is still pending, and the social follows are not
  done. No substitute is claimed for what is missing.
- **Task 1 (real-app teardown): not done.** It requires using the production
  app's Track screen with a connected data source, which I haven't done.
  I'd rather submit without it than invent observations.
- **Walkthrough recording: a labeled web-preview recording exists.** It is
  marked in the recording itself as a mobile-size web preview against the
  local mock, and covers first launch, full history, October totals against
  the checkpoint, search, transaction detail, the server stopped mid-sync,
  resume after a reload, and tests passing. The real-phone legs - killing
  the app mid-download and an aeroplane-mode restart - are still pending,
  and the web preview does not prove those native behaviours.
- **Android APK: built via EAS Build; on-device validation partly done.**
  The APK built from this recovered source has been installed over the
  previous build on a real Android phone - launch verified, saved history
  and October totals visible while the server was unreachable.
  App-kill-during-download proof remains missing; automated replacement
  tests do not substitute for that device test.
- **Stretch goals:** sync resilience (kill-safe, 410, racing syncs) is
  implemented and tested. The measured-performance stretch (mid-range Android
  scroll numbers) and the TalkBack stretch are not done; scroll behaviour is
  verified on web only so far, and I won't claim numbers I don't have.
- **Known UI limit:** category is displayed as the raw enum (FOOD, GROCERIES)
  with a tinted monogram badge; there is no icon set or learned
  recategorisation. Search matches merchant only, not amount or category.
- **Hostile-server limits accepted, by design:** a far-future Retry-After is
  honoured durably (server authority, never clamped) and scoped to the
  backend that issued it - changing the server URL drops the gate. The
  mock's own maximum is 3 seconds. Page count is bounded (500) and a
  non-advancing cursor fails fast, but one gigantic page is still read into
  memory whole; the assignment mock pages at 100.
- **npm audit (2026-10-29): 8 transitive findings (5 low, 3 high)** inside
  the Expo toolchain's pinned dependency tree (including zod
  GHSA-mrhx-c7xc-m3w5). None are imported by app source (src/ or tests/);
  the only automated "fix" force-downgrades expo to 54, which would break
  the SDK 58 build, so they are documented here rather than force-fixed.
- **Pre-stamp installs trade one tap for safety.** Backends are told apart
  by the data_source_url stamp, which only exists after the first
  successful sync on this build. An install whose history predates the
  stamp cannot prove which backend it came from, so a 410 with local rows
  asks before replacing, with the source named as "never recorded". The
  cost: such an install whose token merely expired on the SAME backend
  gets one extra confirmation tap before the re-download, and since the
  old URL was never recorded, "Keep my history" cannot restore it
  automatically (the user re-enters it). An empty store has nothing to
  lose and still recovers automatically. Every install stamped by this
  build asks with the recorded URL and full restore.
- **Staged replace trades resume for atomicity.** A confirmed switch or a
  same-backend token-expiry re-download buffers the whole download and
  commits once at the end, so an interrupted replace always restarts from
  the first page instead of resuming. On the web preview the store is
  localStorage: its staged commit is applied per key (no multi-key
  transaction exists there), so a crash precisely during the final commit
  could leave it partially applied - native (SQLite) commits inside one
  real transaction and is not affected. MAX_PAGES still guards runaway
  downloads; in staged mode exceeding it aborts before anything is written.

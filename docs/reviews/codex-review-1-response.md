# Response to Codex review 1

Review: [codex-review-1.md](codex-review-1.md), run with `codex exec -m gpt-6.1-sol -s read-only` (the runtime header
of the run reported `model: gpt-6.1-sol`, `sandbox: read-only`, `reasoning effort: high`) against commit `e04415f`.
All ten findings were reproduced or accepted, then fixed. Each fix has a regression test in
[`test/codex-review-1.test.ts`](../../test/codex-review-1.test.ts). Each test was run against the pre-fix source and
**failed** (#1–#8, #10), then passed with the fix.

| # | Severity | Finding | Fix | Test |
|---|---|---|---|---|
| 1 | high | Granted approval executable after expiry | The commit gate checks `expiresAt` at dispatch and at commit (`gate(..., now)`) | #1 |
| 2 | high | Concurrent cold loads leave a stale cached writer | One shared load promise per workspace. A `ConflictError` evicts the cached copy and returns 409, so the next request reloads | #2 |
| 3 | medium | Allowed proposal stranded between proposal and dispatch | A pending proposal with an `allow` verdict is dispatched on the next tick, and the gate re-checks it against current state | #3 (failure injected between the two transactions, then restart) |
| 4 | medium | Raised budget ignored by policy; budget block was terminal | Policy and drift see the folded per-task budget. A budget-only rejection no longer marks the action as blocked | #4 |
| 5 | medium | Idempotency lost on reload or eviction | Command keys and a fingerprint of command+role are written into the command's events and folded into `S.commands`. Reusing a key for a different command returns 409 | #5 |
| 6 | medium | `trigger_rogue` / `stale_retry` bypassed team authority | Both require Engineering (InfraOps' team). Refusals are audited as `AccessDenied`. The UI disables both buttons for other roles | #6, updated rogue test |
| 7 | medium | Forged event accepted as "redacted" | A redacted entry must be a bare stub (`seq, prevHash, hash, redacted: true, reason`); anything else fails verification | #7 |
| 8 | medium | Replay moved late interventions back to old steps | Only a newer step opens a replay row. Events about older steps are shown as interventions on the latest step | #8 |
| 9 | medium | SSE ignored backpressure | Any SSE write (event, snapshot, ping) disconnects the stream once more than 1 MiB is queued. The client resumes with Last-Event-ID | guard only (see note) |
| 10 | medium | Pruning deleted workspaces in use | `prune(before, keep)` never deletes a workspace held in memory (being viewed or streamed) | #10 (SQLite and PostgreSQL) |

Note on #9: the guard is one line in `stream()`. A socket-level test would have to fill the kernel's TCP buffers,
which makes it slow and flaky. The behaviour is covered by review, and the reconnect path it relies on is already
tested ("repeated SSE delivery").

Also fixed before this review (found during Codex's probing): rate limits keyed on a forged `X-Forwarded-For`
entry. Only the entry appended by the trusted proxy is used now (`WATCHSHIFT_TRUST_PROXY_HOPS`), with a regression
test in `test/failures.test.ts`.

Suite after the first round: 32/32 on SQLite and on PostgreSQL 16, Playwright 4/4 (desktop + mobile), typecheck clean
([evidence](../evidence/)).

## Follow-up review

Codex then re-checked the fixes ([codex-review-2.md](codex-review-2.md), gpt-6.1-sol, read-only, high effort).
It marked #1–#4 and #6–#9 FIXED, #5 and #10 PARTIAL, and reported two new defects. All four were then fixed:

| Item | Fix | Test |
|---|---|---|
| #5 partial / new low: refusals that wrote no event were forgotten, so a keyed request refused early could succeed when retried later with the same key | Every refusal now goes through `reject()` and is recorded as an audited `CommandRejected` / `AccessDenied` event carrying the key | #5b (fails without the fix) |
| New medium: a writer dropped after a conflict kept its SSE streams open, and they went silent | `invalidate()` ends that writer's streams. `EventSource` reconnects with Last-Event-ID to a freshly loaded writer | #2b (fails without the fix) |
| #10 partial: pruning could race a workspace that was still loading | Prune also skips ids with a load in progress. If the remaining window is ever hit (a delete landing between a load's read and its first write), the request ends in a conflict (409), the cache entry is dropped, and the next request gets 404 and a new workspace; it never writes to a deleted stream | covered by review |

These follow-up fixes were not reviewed by Codex a third time. One review plus one verification pass was the
agreed budget for this release.

Suite after the follow-up: 34/34 on SQLite and on PostgreSQL 16, Playwright 4/4, typecheck clean.

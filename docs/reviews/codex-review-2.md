## Verdict

**Not release-ready:** #5 and #10 remain partial; conflict recovery introduces stale SSE streams.

## Finding status (1-10)

1. **FIXED** — Expiry is checked at dispatch and commit: [engine.ts:270](../../src/engine.ts:270). Old-code test: **fails**; covers dispatch only.
2. **FIXED** — Cold loads share one promise; conflicts invalidate cached writers: [server.ts:48](../../src/server.ts:48). Old-code test: **fails**.
3. **FIXED** — Pending policy-allowed proposals redispatch through the gate: [engine.ts:320](../../src/engine.ts:320). Old-code test: **fails**.
4. **FIXED** — Policy uses the folded budget; budget-only rejection stays retryable: [engine.ts:350](../../src/engine.ts:350), [engine.ts:90](../../src/engine.ts:90). Old-code test: **fails**.
5. **PARTIAL** — Event-backed results survive reload, but early refusals remain unrecorded: [engine.ts:496](../../src/engine.ts:496). Old-code test: **fails**.
6. **FIXED** — Both scenario commands enforce acting-role and Engineering authority: [engine.ts:433](../../src/engine.ts:433), [engine.ts:445](../../src/engine.ts:445). Old-code test: **fails**.
7. **FIXED** — Redacted entries require `true` and reject extra payload fields: [audit.ts:80](../../src/audit.ts:80). Old-code test: **fails**.
8. **FIXED** — Historical references cannot move replay’s current step backwards: [audit.ts:35](../../src/audit.ts:35). Old-code test: **fails**.
9. **FIXED** — Events, snapshots and heartbeats share the queue-limit guard: [server.ts:189](../../src/server.ts:189). Old-code test: **N/A—none supplied**.
10. **PARTIAL** — Pruning excludes cached workspaces, but excludes neither ongoing loads nor newly loaded entries after its snapshot: [server.ts:77](../../src/server.ts:77). Reproduced an active load returning 200 after its row was deleted. Old-code test: **fails**.

## New defects

- **medium — SSE survives cache invalidation:** [server.ts:72](../../src/server.ts:72). Reproduced a delayed command spanning cache eviction: the replacement writer conflicts and is discarded, but its SSE connection remains open. Reloaded commands succeed while that stream receives no updates.
- **low — Previously cached refusals can now execute on retry:** [engine.ts:422](../../src/engine.ts:422). Reproduced keyed `stale_retry` returning 409 before the rogue scenario, then succeeding with the identical key afterward.

Validation: 19 checks passed using in-memory fixtures; all nine regressions failed against `e04415f`; typechecking passed.  
Not checked: live PostgreSQL, browser E2E or sustained SSE load.
## Verdict

Changes required: ten concrete defects remain at `e04415f`, including stale consent execution and persistent workspace conflicts.

## Findings

1. **[high] Granted approvals remain executable after expiry** — [src/engine.ts:251](E:/doo/agent-control-tower/src/engine.ts:251)  
   The gate checks approval status and binding but never `expiresAt`; expiration processing only covers pending approvals. Reproduced: approve immediately before expiry, dispatch after expiry, then commit the canary successfully. This contradicts the documented TTL recheck at commit.  
   **Fix:** Check expiry using the current execution time at both dispatch and commit.

2. **[high] Concurrent workspace loads can leave a permanently stale cached writer** — [src/server.ts:45](E:/doo/agent-control-tower/src/server.ts:45), [src/server.ts:74](E:/doo/agent-control-tower/src/server.ts:74)  
   Two requests missing the cache can load separate `Workspace` instances with independent locks. One commits; the other conflicts and can remain cached. With controlled asynchronous store reads, one command succeeded, the other returned 500, and subsequent commands repeatedly returned 500 because cached head 7 never caught up with database head 8.  
   **Fix:** Share one pending load per workspace and invalidate/reload cached state after stream conflicts.

3. **[medium] Interruption between proposal persistence and dispatch strands auto-allowed work** — [src/engine.ts:364](E:/doo/agent-control-tower/src/engine.ts:364), [src/engine.ts:305](E:/doo/agent-control-tower/src/engine.ts:305)  
   An allowed proposal and its dispatch use separate transactions. If dispatch fails or the process stops between them, reload restores a pending proposal with `approved: false`. Recovery only handles in-flight work, while every subsequent tick returns at `if (a.pending)`. Reproduced a permanently RUNNING ReleaseOps with `release.inspect` pending and zero completions.  
   **Fix:** Recover or redispatch pending proposals whose policy verdict was `allow`, with fresh gate checks.

4. **[medium] Raising a budget does not raise the policy’s budget limit** — [src/engine.ts:249](E:/doo/agent-control-tower/src/engine.ts:249), [src/engine.ts:334](E:/doo/agent-control-tower/src/engine.ts:334)  
   Planning’s preliminary check uses the folded budget, but policy evaluation receives the original static `TaskDef`. Reproduced raising ReleaseOps from $0.20 to $0.30: its next proposal was rejected for exceeding **$0.20**, with no additional effect. Budget-only rejection also records a terminal blocked outcome for that action.  
   **Fix:** Use the folded budget in both policy evaluations and keep budget-only failures retryable.

5. **[medium] Command idempotency disappears on reload or cache eviction** — [src/engine.ts:399](E:/doo/agent-control-tower/src/engine.ts:399)  
   Command keys exist only in a 500-entry memory map and are absent from persisted events. Reproduced submitting `raise_budget`, reloading, then retrying the identical key: the budget increased again and a second `BudgetRaised` event appeared. Workspace eviction has the same consequence.  
   **Fix:** Persist command keys and results atomically with their events, binding keys to the command and role.

6. **[medium] Scenario commands bypass role/team enforcement** — [src/engine.ts:414](E:/doo/agent-control-tower/src/engine.ts:414), [src/engine.ts:426](E:/doo/agent-control-tower/src/engine.ts:426)  
   `trigger_rogue` checks only `canAct`; Customer Ops can revoke an Engineering approval and cause InfraOps quarantine. `stale_retry` checks neither role nor team, so an Auditor can append `DispatchFenced` events. Both were reproduced without any `AccessDenied` event. These are enforcement gaps independent of the disclosed role switcher.  
   **Fix:** Apply the Engineering team and acting-role checks before either command executes.

7. **[medium] Audit verification accepts altered full events as “redacted”** — [src/audit.ts:75](E:/doo/agent-control-tower/src/audit.ts:75)  
   Merely having a `redacted` property skips content verification. Reproduced changing an `ActionCompleted` observation and adding `redacted: false`: `verifyExport` returned `ok: true`, although the forged content remained present.  
   **Fix:** Validate export structure; accept only `redacted: true` stubs with the permitted metadata fields, and reject hybrid entries containing event payloads.

8. **[medium] Historical retries misplace later replay interventions** — [src/audit.ts:33](E:/doo/agent-control-tower/src/audit.ts:33)  
   Any event referencing an old step changes `cur` back to that step. Reproduced: trigger rogue, resume, complete later steps, invoke `stale_retry`, then kill between actions. The kill attached to the old rogue step; the latest step still reported RUNNING while live state was KILLED.  
   **Fix:** Track the latest chronological execution step separately from the step referenced by historical events.

9. **[medium] SSE ignores backpressure and permits unbounded response buffering** — [src/server.ts:177](E:/doo/agent-control-tower/src/server.ts:177), [src/server.ts:179](E:/doo/agent-control-tower/src/server.ts:179)  
   Events, snapshots and heartbeats keep calling `res.write` after it returns `false`. A connected client that stops reading can accumulate queued response data indefinitely; connection-count limits do not bound queued bytes. A response stub returning `false` on every write still received subsequent writes.  
   **Fix:** Disconnect slow streams once queued bytes exceed a fixed limit, including snapshot and heartbeat writes.

10. **[medium] Pruning deletes actively viewed workspaces and leaves broken cached state** — [src/server.ts:133](E:/doo/agent-control-tower/src/server.ts:133), [src/store.ts:79](E:/doo/agent-control-tower/src/store.ts:79)  
    Database `last_active` advances only on event appends; reads and SSE activity update memory only. Under the 5,000-workspace pressure path, a paused workspace viewed for over an hour can be deleted despite current activity. Reproduced a successful state read immediately before pruning, followed by a cached workspace whose resume returned 500 because its database row was gone.  
    **Fix:** Persist visitor activity or exclude active workspaces from pruning, and invalidate deleted cache entries.

## Things verified as correct

- The existing 22 tests passed; targeted probes reproduced the findings above.
- Normal kill/pause races serialize correctly; previously committed effects remain committed.
- Approval parameter substitution, resource-version checks, policy reevaluation and effect uniqueness are enforced.
- SQLite fencing was exercised; PostgreSQL append atomicity and owner-lock ordering were reviewed in source.
- Normal audit exports redact other teams’ event content; input limits, path containment and CSP are present.
- The updated proxy-address handling resisted the earlier spoofed-header rate-limit probe.
- Client-selected roles and simulated usage/costs are disclosed honestly.

Not run: live PostgreSQL, browser E2E or sustained load testing. The concurrent-load race was reproduced using controlled asynchronous store reads.
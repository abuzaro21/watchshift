# Failure tests

Every failure mode the challenge directive names is an automated test. Run `npm test` (SQLite) or set
`WATCHSHIFT_TEST_DATABASE_URL=postgres://...` to run the same suite on PostgreSQL 16. Browser flows: `npm run test:e2e`
(desktop and mobile). Latest logs: [evidence/test-sqlite.log](evidence/test-sqlite.log),
[evidence/test-postgres.log](evidence/test-postgres.log), [evidence/e2e.log](evidence/e2e.log).

| Failure mode | What must hold | Test |
|---|---|---|
| Kill races a commit | Kill first: no effect. Commit first: the effect stays and is reported as committed before the kill | `control-plane` › kill racing a commit |
| Pause while in flight | The uncommitted effect is aborted at the commit gate | `control-plane` › pause in flight |
| Pause / resume | Pending approvals are revoked; resume re-plans and needs a fresh approval | `control-plane` › pause revokes approvals |
| Parameter substitution after approval | Different params than approved are fenced at dispatch | `control-plane` › approval is bound to exact parameters |
| Duplicate approvals | Second approve is rejected (409); retried idempotency key returns the first result, appends nothing | `failures` › duplicate approvals |
| Stale approvals | Expired approval, wrong or missing binding hash: never released | `failures` › stale approvals |
| Cross-team approval / read-only role | 403 in the backend, logged as `AccessDenied`, state unchanged | `failures` › cross-team and read-only |
| Budget exhaustion | Agent blocked at the budget gate; raising the budget lets it continue | `control-plane` › budget gate |
| Prompt injection in data | Injected "$2,000 to card 9999" refund is blocked and the ticket escalated | `control-plane` › injected ticket instructions |
| Agent forging operator events | Agents can only emit agent-class events; policy ignores rationale | `control-plane` › policy ignores agent rationale |
| Rogue agent | Exfiltration blocked before effect, auto-quarantine, kill, stale-worker retry fenced, zero rows leave; the unguarded baseline (negative control) leaks 12,408 rows on a cloned world | `rogue-and-durability` › rogue agent |
| Rogue trigger abuse | Idempotent per workspace, needs an acting role | `rogue-and-durability` › rogue trigger is idempotent |
| Restart while waiting for approval | Approval survives and still works after a new process loads the workspace | `rogue-and-durability` › restart while waiting |
| Restart while in flight | Reconciled as not committed, epoch bumped, re-planned, never duplicated; the old process is fenced | `rogue-and-durability` › restart while an action is in flight |
| Replay across restart | Replay re-folded from persisted events equals live state; tampering is detected on load | `rogue-and-durability` › replay |
| Audit integrity and scope | Export is team-scoped, verifies offline, detects edits; CSV is formula-safe | `rogue-and-durability` › audit export |
| Repeated SSE delivery | Reconnect with `Last-Event-ID` resumes after it with no duplicate or missing seq | `failures` › repeated SSE delivery |
| Malicious HTTP payloads | Cross-origin 403, wrong type 415, oversized 413, bad JSON / unknown command / bad agent / out-of-range number 400, path traversal refused, no workspace without cookie | `failures` › hostile HTTP input |

Manual check done during the build: the Docker image was run against PostgreSQL 16, a demo was started, the
container restarted, and the same workspace came back with the same state under owner epoch 2.

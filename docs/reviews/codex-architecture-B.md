# Architecture B — Clearance

## 1. Product and operator workflow

An intervention cockpit for three deterministic workers: **Release** deploys a simulated service, **Billing** processes synthetic refunds, and **Research** writes research records.

Each visitor gets an isolated fleet, database namespace, and accelerated scenario. Agents actually change persisted simulated resources.

The guided workflow: watch work advance → inspect a blocked deployment → approve its exact change → pause Research → trigger Billing’s rogue behavior → kill Billing → replay the incident and export its audit log.

Fleet cards show status, recent actions, blockers, policy drift, and simulated spending.

## 2. Name candidates

| Name | Tagline | Rationale | Collision risk |
|---|---|---|---|
| Clearance | Every action earns clearance. | Makes authorization the product’s central idea. | Common aviation/security term; likely crowded. |
| Holdpoint | Stop before consequences. | Names the intervention boundary. | Existing engineering terminology; possible industrial overlap. |
| Agent Breakwater | Contain autonomous momentum. | Communicates containment without promising perfect agents. | Distinctive combination; generic “agent” branding remains crowded. |

These are naming hypotheses; availability is unchecked.

## 3. Runtime

Use one Node 24 TypeScript process, React/Vite, and SSE. No model API or separate worker infrastructure.

A fair scheduler advances eligible agents through deterministic state machines:

`READY → PROPOSED → EVALUATED → WAITING_APPROVAL | DISPATCHABLE → COMMITTED`

Agents receive restricted proposal APIs, never database handles or operator credentials.

Each proposal contains a logical step ID, operation, exact parameters, expected resource version, and short decision explanation. Policy returns deny, allow, or require approval.

Dispatch executes one short database transaction: lock the agent, verify lifecycle and authorization, check resource version, apply the simulated effect, append events, and update projections. Nothing executes while waiting for approval.

Interruptible boundaries occur before proposal, before dispatch, and between steps. Pause or kill acknowledgments follow durable transactions. External network effects are outside this design’s containment guarantee.

## 4. Testable control-plane invariants

1. **Exact consent:** Approval binds a canonical hash covering session, team, agent, task, logical step, operation, parameters, expected resource version, policy version, lifecycle epoch, and expiry. Dispatch recomputes it. Approval consumption and effect commit are atomic.
2. **Kill fencing:** Kill and dispatch serialize on the same agent record. Kill increments its epoch and makes it terminal. No effect may commit after the kill transaction; an earlier committed effect remains visible.
3. **Pause/resume:** Pause increments the epoch. Resume re-evaluates unfinished work against current policy and resource versions; old approvals never revive.
4. **Idempotency:** A unique `(session, agent, task, logical step)` effect key survives retries and lifecycle changes. Duplicate delivery cannot repeat an effect.
5. **No self-approval:** Operator endpoints require browser-held operator credentials. Worker identities can propose, never approve, resume, or change policy.
6. **Isolation:** Server-issued credentials bind visitor, team, and role. Every lookup, mutation, SSE subscription, and export enforces that scope. Client-supplied namespace identifiers confer no authority.

## 5. Rogue scenario and negative control

Billing changes from routine refunds to exporting synthetic customer records into a simulated attacker sink. Policy requires approval for exports outside the approved destination.

The scenario then attempts parameter substitution after approval, direct dispatch, and a stale dispatch after kill. Assertions require rejection events and zero attacker-sink records.

Run the identical proposal sequence against a **test-only unsafe executor** without gates. Require one attacker-sink record, proving the scenario can cause harm. Never expose that executor through the hosted application.

## 6. Persistence and replay

Append-only, session-sequenced events are authoritative. Resource tables and fleet state are transactional projections. Use SQLite locally and PostgreSQL when hosted, with identical reducer semantics and shared behavioral tests.

Events record proposals, policy results, approvals, lifecycle changes, committed effects, accounting, and scheduler decisions. Persist before publishing SSE.

Replay folds events through the same reducer; it never reruns workers or effects. Show observable decision explanations, not claimed private model reasoning. Last-N replay starts from the preceding reconstructed state.

SSE reconnects supply the last sequence; gaps trigger persisted catch-up.

## 7. Accounting

Every agent/task displays **simulated tokens** and **estimated model-equivalent cost**, using a visible fixed rate card and deterministic workload units. Actual model calls and actual inference spend are zero. Replay never charges again.

## 8. Eight hosting risks

1. **Idle spin-down:** Open and exercise the demo immediately before filming; provide a clear cold-start screen.
2. **SSE proxy buffering/disconnects:** Flush headers, send heartbeats, disable caching, and test deployed reconnection.
3. **Restart during approval:** Persist proposals and decisions; recover pending work without automatic authorization.
4. **Kill/commit race:** Serialize both transactions; test both ordering outcomes.
5. **Visitor sprawl:** Cap active fleets, steps, and connections; expire idle sessions through bounded cleanup.
6. **Database expiry/storage loss:** Hosted PostgreSQL is authoritative; track its expiry and verify provisioning before judging.
7. **Single-instance overload:** Bound scheduler work per cycle and batch SSE updates; reject excess sessions explicitly.
8. **Cross-visitor leaks:** Enforce scoped queries and streams; use two independent browser contexts to test access denial.

## 9. Release acceptance

- Three workers visibly persist different effects without API keys.
- Approve, pause, resume, and kill change outcomes.
- Mutation, expired consent, stale epochs, retries, and self-approval fail.
- Restart preserves pending approvals; kill-race tests prevent later effects.
- Replay matches live projections; audit export preserves event order.
- Cross-session and cross-team access fails.
- Playwright passes locally and against the deployed URL.
- Public clean clone, Docker startup, GitHub Actions, architecture snapshot, 90-second intervention video, rogue-test evidence, and ≤300-word thesis are complete.

Unverified: implementation and deployed hosting behavior. Containment covers simulated database effects; this is not an arbitrary-code sandbox.
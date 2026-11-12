# DOO submission notes: The Agent Control Tower

Ready-to-paste content for the DOO Builders League entry. Submitting requires the owner's signed-in DOO account;
it is an owner action (see the end of this file).

## Title
WATCHSHIFT

## Tagline
Agents act. Humans hold the watch.

## One-paragraph summary
WATCHSHIFT is an operator control tower for an AI workforce. Three agents (ReleaseOps, SupportOps, InfraOps) work a
simulated company in real time while every action they propose passes a control plane: a policy engine that never
reads the agent's rationale, an approval queue whose consent is bound to the exact tool, parameters, policy version,
epoch and resource version, a kill switch that fences execution epochs so stale workers are refused at the commit
gate, per-agent and per-task token and cost tracking, budget gates, drift detection, replay of the last N steps from
a hash-chained event log, and team-scoped audit export that verifies offline. Trigger the rogue agent and watch a
poisoned runbook try to export 12,408 customer rows: blocked before any effect, auto-quarantined, killed, and its
stale retry fenced. Zero rows leave; the negative control shows they would have without the tower.

## Links
- Live demo: LIVE_URL
- Repository: https://github.com/abuzaro21/watchshift
- Video (90 s): FILM_URL
- Architecture snapshot: https://github.com/abuzaro21/watchshift/blob/main/docs/ARCHITECTURE.md
- Rogue-agent failure test: https://github.com/abuzaro21/watchshift/blob/main/docs/FAILURE-TEST.md
- Thesis (≤300 words): https://github.com/abuzaro21/watchshift/blob/main/docs/THESIS.md
- AI disclosure: https://github.com/abuzaro21/watchshift/blob/main/docs/AI-DISCLOSURE.md

## Architecture snapshot (agent events → control plane → operator UI)
Planners (3 agents) emit proposals → policy engine (allow / approve / block) → approval engine (binding hash,
single use, TTL) → commit gate (status, epoch, policy re-check, approval, resource version, op id, budget) →
atomic append of events + effect row to SQLite / PostgreSQL (owner-epoch fenced, SHA-256 chain) → fold → SSE →
operator cockpit; operator commands (approve, deny, pause, resume, kill, budget) go back through the same gate.
Diagram: docs/ARCHITECTURE.md.

## How the challenge requirements are met
| Requirement | Where |
|---|---|
| Real-time fleet view: status, recent actions, blockers, drift | Fleet cards, live execution stream (SSE) |
| Functional approval queue | Approval cards; binding hash; approve/deny change backend state |
| Per-agent kill switch | Kill on each card; epoch fencing; stale-retry demo |
| Token and cost per agent and task | Spend panel and per-task budgets (simulated tokens, estimated $) |
| Replayable traces of the last N steps | Replay inspector, re-folded from persisted events |
| Three running agents, distinct jobs | ReleaseOps, SupportOps, InfraOps |
| Approve, pause, resume, kill, inspect during execution | All enforced server-side; 22 tests + browser tests |
| Bonus: multi-team | Engineering vs Customer Ops authority, enforced and logged |
| Bonus: compliance audit export | JSON/CSV, team-scoped redaction, offline verification |

## Notes (checklist field: AI tools, key decisions, out of scope)
**AI tools used.** Claude Code (Claude Opus 5.5) wrote the code, tests, docs and film pipeline; OpenAI Codex
(gpt-6.1-sol, read-only) gave an independent architecture proposal and code review; Kokoro-82M (local, open weights)
voiced the film. Full detail: docs/AI-DISCLOSURE.md.

**Key decisions.** Event sourcing with a SHA-256 chain, so replay and audit come from the same log the UI folds.
One commit gate checked at dispatch and again at commit (status, epoch, policy, approval binding, resource
version, op id, budget). Approvals bind a hash of the exact action rather than an agent or task. Kill bumps an
epoch that fences stale workers. Policy never reads the agent's rationale, so a persuasive prompt cannot widen
authority. Team boundaries are enforced in the backend, not hidden in the UI. Deterministic planners keep the demo
reproducible and free to run. Rationale: docs/ARCHITECTURE-DECISIONS.md.

**Out of scope.** Real authentication (the role switcher is a demo control), live LLM calls, real money or
infrastructure, multi-region deployment, long-term retention (demo workspaces expire after 6 hours).

## Honest limits
Simulated company and tokens; deterministic planners (no live LLM calls); the operator role is a demo switch, not
authentication; free hosting sleeps when idle (first load can take up to a minute).

## Owner action to submit
1. Sign in to https://build.doo.ooo and open the challenge *The Agent Control Tower*.
2. Paste the fields above. The form asks for: public repo URL, live demo URL (required), 90-second video link,
   and notes (use the Notes block above).
3. Video: the form expects a link (Loom or video). Use the GitHub release asset link above, or upload
   `watchshift-film.mp4` to Loom or YouTube (unlisted) from your account and paste that link.
4. Submit before the deadline. The page says "Open until Nov 15, 2026"; its countdown read "3d 22h left" at
   2026-11-12 01:52 UTC, which puts the close at roughly 23:00–23:59 UTC on 15 November. Submit well before that.

You are an independent co-architect for a DOO Builders League entry: "The Agent Control Tower".
Challenge (verified 2026-11-12, deadline ~2026-11-15 23:30 UTC): build an operator cockpit to operate, audit and
intervene on a fleet of AI agents in real time. Required: live fleet (status, recent actions, blockers, drift);
approval queue for risky actions; per-agent kill switch; cost+token per agent per task; replay of an agent's
reasoning for the last N steps; >=3 simulated agents doing different jobs that you can watch and intervene on.
Deliverables: public repo (clean clone runs), live demo URL (required), 90s video (approve, pause, kill, replay),
architecture snapshot (agent events -> control plane -> operator UI), one rogue-agent failure test showing the tower
catches and contains it, <=300-word two-year thesis. Judging: conceptual clarity 25, technical depth 25 (real event
stream + control plane, not static dashboard), demo quality 20 (a non-builder can run an intervention), failure
thinking 15, thesis 15. Bonus: multi-tenant/multi-team awareness, exportable audit log. DQ: read-only dashboard,
mockups with no running agents, no demo.

Constraints: free hosting (one Render free web service, spins down after 15 min idle, one instance, free Postgres
30-day expiry), no paid model inference (demo must work with no LLM API), deterministic simulated agents with
real state transitions and simulated side effects, TypeScript on Node 24 (native type stripping), React+Vite, SSE,
node:sqlite locally and PostgreSQL hosted, Playwright, Docker, GitHub Actions. ~3.5 days total including film.
Public visitors must not interfere with each other (per-visitor isolated sessions).

Produce, INDEPENDENTLY (do not read any other file in this directory except this prompt), "Architecture B" in
<= 900 words of markdown:
1. Product concept + primary operator workflow.
2. Three name candidates (name, tagline, one-line rationale, collision risk you can reason about).
3. Agent runtime model: how agents genuinely execute (tick loop? step state machine?), how a step is proposed,
   policy-evaluated, gated, dispatched, committed. Where the interruptible boundaries are.
4. Control-plane invariants (numbered, testable): approval binding (hash of exact params + policy version + epoch),
   kill fencing, pause/resume revalidation, idempotent effects, no self-approval, tenant isolation.
5. Rogue-agent scenario design + negative control (unsafe baseline) that is testable, not narrated.
6. Persistence/event model and replay: what is the source of truth, how replay reconstructs state.
7. Cost/token accounting honesty (simulated vs real).
8. The 8 sharpest risks for THIS design on free hosting and how to mitigate each (e.g., spin-down mid-demo, SSE
   through Render proxy, restart while WAITING_APPROVAL, kill vs commit race, visitor session sprawl).
9. Acceptance tests you would require before release (list).
Challenge specifically: whether agents truly execute; whether interventions change outcomes; whether approvals can
be bypassed; whether kill reliably prevents future effects; whether replay matches real events; whether multi-team
isolation is meaningful. Be concrete and opinionated. Output only the markdown.

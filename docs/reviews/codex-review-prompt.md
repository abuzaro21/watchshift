You are an independent senior reviewer. Repository: WATCHSHIFT, an agent control tower (Node 24, TypeScript, event-sourced).
Read docs/ARCHITECTURE-DECISIONS.md first (invariants 1-8), then src/engine.ts, src/policy.ts, src/store.ts, src/server.ts,
src/audit.ts, src/view.ts, src/planner.ts, src/model.ts and the tests in test/.

Review three areas and report ONLY real, concrete defects (no style nits):
1. CONTROL PLANE: can any path commit an effect without passing the commit gate (status, epoch, policy, approval binding,
   resource version, op-id idempotency)? Kill/pause vs commit races, approval reuse/substitution, stale approvals, resume
   revalidation, budget gate, drift/quarantine, replay correctness vs live state.
2. SECURITY: server-side enforcement of team boundaries and roles, input validation, body/rate/SSE limits, cookie flags,
   CSP/headers, path traversal, audit export redaction leaks across teams, CSV injection, DoS vectors, anything that lets
   one browser read or act on another's workspace.
3. DURABILITY: restart while waiting/in flight, owner-epoch fencing between two processes, append atomicity and
   conflict handling on SQLite and PostgreSQL, hash-chain verification on load, pruning, unbounded memory growth.

Note honestly known, documented demo limits: the operator role is chosen by the client (demo role switcher, not
authentication) and tokens/costs are simulated. Flag them only if the code or UI misrepresents them.

Output format, markdown:
## Verdict (one line)
## Findings
For each: [severity critical|high|medium|low] title, file:line, concrete failure scenario, suggested fix.
## Things verified as correct (short list)
Be precise; do not invent issues. You are read-only: do not modify files.

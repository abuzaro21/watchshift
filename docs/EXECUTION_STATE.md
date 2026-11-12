# Execution state

Acceptance gates from the build directive. Every PASS links evidence; anything not done says so.
Last updated: 2026-11-12.

| Gate | Status | Evidence |
|---|---|---|
| G1 Architecture | PASS | Independent [Architecture A](reviews/claude-architecture-A.md) and [Architecture B (Codex gpt-6.1-sol)](reviews/codex-architecture-B.md); merged in [ARCHITECTURE-DECISIONS.md](ARCHITECTURE-DECISIONS.md) with invariants 1-8 |
| G2 Real agent execution | PASS | Three planners execute through the gate; events and effect rows persisted (`test/control-plane.test.ts` › three agents execute…) |
| G3 Operator control | PASS | Approve, deny, pause, resume, kill, budget, replay change backend state; unit tests + [e2e](evidence/e2e.log) |
| G4 Safety | PASS | Commit gate at dispatch and commit; binding hash; epoch fencing; [FAILURE-TEST.md](FAILURE-TEST.md) |
| G5 Failure scenario | PASS | Rogue export blocked before effect, quarantined, killed, stale retry fenced, 0 rows out vs 12,408 in the negative control ([screens](evidence/screens/desktop-2-rogue.png)) |
| G6 Durability | PASS | Restart while waiting / in flight, owner fencing, replay across restart, tamper detection, idempotency; suite passes on SQLite and PostgreSQL 16 ([sqlite](evidence/test-sqlite.log), [postgres](evidence/test-postgres.log)); Docker image restarted on Postgres kept the workspace |
| G7 UI | PASS | Playwright desktop + mobile ([e2e.log](evidence/e2e.log)); keyboard-operable dialogs, focus rings, `prefers-reduced-motion`, ARIA regions/labels; [screens](evidence/screens/) |
| G8 Security | IN PROGRESS | Hostile-input tests pass; Codex security/control-plane/durability review: see [reviews/](reviews/) |
| G9 CI | PENDING | Workflow in `.github/workflows/ci.yml`. First run on the private repo was not started by GitHub (account Actions billing for private repos); runs once the repo is public |
| G10 Real deployment | IN PROGRESS | Owner created the isolated Render workspace `WATCHSHIFT`; free blueprint deploy pending ([DEPLOY.md](DEPLOY.md)) |
| G11 Film | PASS | 89.97 s, 1920×1080, 30 fps, H.264/AAC + captions; 11/11 automated checks ([film-check.json](evidence/film-check.json)); [storyboard, audio report, rendering steps](../film/README.md); [contact sheet](../film/contact-sheet.png). No human listening review is claimed |
| G12 Submission | PENDING | Notes ready in [SUBMISSION.md](SUBMISSION.md); submitting needs the owner's DOO sign-in |

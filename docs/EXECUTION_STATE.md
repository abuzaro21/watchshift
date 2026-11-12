# Execution state

Acceptance gates from the build directive. Every PASS links evidence; anything not done says so.
Last updated: 2026-11-12 (release v1.0.0).

| Gate | Status | Evidence |
|---|---|---|
| G1 Architecture | PASS | Independent [Architecture A](reviews/claude-architecture-A.md) and [Architecture B (Codex gpt-6.1-sol)](reviews/codex-architecture-B.md); merged in [ARCHITECTURE-DECISIONS.md](ARCHITECTURE-DECISIONS.md) with invariants 1-8 |
| G2 Real agent execution | PASS | Three planners execute through the gate; events and effect rows persisted (`test/control-plane.test.ts` › three agents execute…) |
| G3 Operator control | PASS | Approve, deny, pause, resume, kill, budget, replay change backend state; unit tests + [e2e](evidence/e2e.log) |
| G4 Safety | PASS | Commit gate at dispatch and commit; binding hash; epoch fencing; [FAILURE-TEST.md](FAILURE-TEST.md) |
| G5 Failure scenario | PASS | Rogue export blocked before effect, quarantined, killed, stale retry fenced, 0 rows out vs 12,408 in the negative control ([screens](evidence/screens/desktop-2-rogue.png)) |
| G6 Durability | PASS | Restart while waiting / in flight, owner fencing, replay across restart, tamper detection, idempotency; suite passes on SQLite and PostgreSQL 16 ([sqlite](evidence/test-sqlite.log), [postgres](evidence/test-postgres.log)); Docker image restarted on Postgres kept the workspace |
| G7 UI | PASS | Playwright desktop + mobile ([e2e.log](evidence/e2e.log)); keyboard-operable dialogs, focus rings, `prefers-reduced-motion`, ARIA regions/labels; [screens](evidence/screens/) |
| G8 Security | PASS | Independent Codex (gpt-6.1-sol, read-only) review found 10 defects + 1 during probing, its verification pass found 4 more; all fixed with regression tests that fail on the old code ([review](reviews/codex-review-1.md), [response](reviews/codex-review-1-response.md)); hostile-input tests pass |
| G9 CI | BLOCKED (owner: GitHub billing) | The repository is public, but GitHub refuses to start any Actions job: "The job was not started because recent account payments have failed or your spending limit needs to be increased" ([run 43140157677](https://github.com/abuzaro21/watchshift/actions/runs/43140157677)). Every step of `.github/workflows/ci.yml` was run locally on the release commit: typecheck, build, tests on SQLite and PostgreSQL 16 (34/34 each), Playwright, `npm audit --omit=dev` (0 vulnerabilities), Docker build + health + restart ([evidence](evidence/)). Owner action: fix GitHub billing, then `gh workflow run ci -R abuzaro21/watchshift` |
| G10 Real deployment | PASS | https://watchshift-l5nx.onrender.com: Render workspace `WATCHSHIFT`, free web service (Docker, Frankfurt) + free PostgreSQL 16, from `render.yaml` with auto-sync off. `/api/health` reports `store: postgres`. Playwright 4/4 against the live URL ([e2e-live.log](evidence/e2e-live.log)). Forged `X-Forwarded-For` bursts are rate-limited live (40 allowed, then 429) |
| G11 Film | PASS | 89.97 s, 1920×1080, 30 fps, H.264/AAC + captions; 11/11 automated checks ([film-check.json](evidence/film-check.json)); [storyboard, audio report, rendering steps](../film/README.md); [contact sheet](../film/contact-sheet.png). No human listening review is claimed |
| G12 Submission | READY (owner action) | All fields in [SUBMISSION.md](SUBMISSION.md); submitting needs the owner's DOO sign-in. The page closes around 23:00–23:59 UTC on 2026-11-15 |

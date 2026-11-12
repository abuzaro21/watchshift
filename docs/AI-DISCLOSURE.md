# AI disclosure

This entry was built with AI assistance, directed by its owner.

- **Claude Code (Anthropic, Claude Opus 5.5)** wrote the code, tests, documentation, the film script and the
  capture scripts, ran the tests, and operated the build, repository and deployment tooling.
- **OpenAI Codex CLI (gpt-6.1-sol, read-only sandbox)** independently wrote Architecture B before seeing
  Architecture A ([reviews/codex-architecture-B.md](reviews/codex-architecture-B.md)) and reviewed the control plane,
  security and durability ([reviews/](reviews/)). It did not write code. Findings were checked and fixed by hand,
  with regression tests.
- **Narration** in the film is synthetic speech (see [../film/README.md](../film/README.md) for the engine used).

The product itself makes **no AI model calls**. The three agents are deterministic planners so that every run is
reproducible, replay is exact and nobody pays for tokens. Token counts and costs shown in the UI are simulated and
labelled as estimates.

No private source, secrets or personal data from other projects were copied into this repository. Tooling patterns
(Vite/TypeScript config, Dockerfile and CI structure) follow the owner's earlier public challenge entry.

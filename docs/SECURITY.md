# Security

WATCHSHIFT is a public demo that holds only synthetic data. Its security goals are: no visitor can see or act on
another visitor's workspace; inside a workspace, authority is enforced on the server, never only in the UI; the
audit trail is tamper-evident; the service degrades safely under abuse.

## Threat model and controls

| Threat | Control | Evidence |
|---|---|---|
| Agent acts outside its authority (prompt injection, poisoned runbook, persuasive rationale) | Policy runs server-side on structured proposals and never reads rationale; capability, egress and refund rules block; rogue actions auto-quarantine | `test/control-plane.test.ts` (injected ticket), `test/rogue-and-durability.test.ts` |
| Consent reused for a different action | Approval hash binds tool, params, policy version, epoch, task, step, resource version; single use; 10 min TTL; re-checked at commit | "approval is bound to exact parameters", "stale approvals" |
| Kill switch races a commit, or a stale worker retries later | Epoch bump on pause/quarantine/kill/recovery; commit gate rejects older epochs; effects unique per op id | "kill racing a commit", rogue test stale retry |
| Cross-team action or approval | Every command checks role and team on the server; refusals are appended as `AccessDenied` | "cross-team and read-only operators are refused" |
| Reading another visitor's workspace | Workspace chosen only by a random UUID in an `HttpOnly; SameSite=Lax` cookie (`Secure` behind HTTPS); no endpoint accepts a workspace id | `src/server.ts` |
| Audit leaks across teams | Export redacts other teams' events to `{seq, prevHash, hash}`; chain still verifies | "audit export is team-scoped" |
| Audit tampering | SHA-256 hash chain; load refuses a broken chain; `npm run verify-audit` checks exports offline | replay/tamper test, `docs/evidence` |
| CSRF / cross-site POST | `Origin` must match `Host` on POST; JSON content type required (no simple-form POST) | "hostile HTTP input" |
| Malformed or oversized input | 4 KB body cap (413), JSON object only (400), strict command whitelist and type checks, numeric bounds | "hostile HTTP input" |
| Path traversal on static files | Resolved path must stay under `public/`; malformed escapes rejected | "hostile HTTP input" |
| CSV formula injection | Cells starting with `= + - @ TAB CR` are quoted and prefixed | audit test |
| XSS | React escapes all text; strict CSP (`script-src 'self'`, no inline script, `frame-ancestors 'none'`) | headers test |
| Resource exhaustion | Per-IP limits: 30 new workspaces/h, 40 commands/10 s, 240 reads/10 s; 4 SSE streams per workspace, 400 total; idle eviction; 6 h retention prune; idempotency cache capped | `src/server.ts` |
| Split brain (two processes) | Owner epoch claimed per process; appends re-check it in the transaction; a fenced process returns 503 | "restart while an action is in flight", fencing test |

Headers on every response: `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer`, `Cache-Control: no-store` on API responses.

## Stated limits (not hidden)

- **No authentication.** The operator role (Engineering on-call, Customer Ops lead, Auditor) is a demo switch the
  visitor chooses so judges can try each perspective. The server still enforces what each role may do, but anyone
  can pick any role inside their own workspace. A production deployment would take the role from an identity
  provider; the enforcement code would not change.
- **Simulated world.** No real deploys, refunds, emails, clusters or storage. The "external destination" in the rogue
  scenario is a fictitious `example.net` name; nothing is sent anywhere.
- **Simulated tokens and cost.** Estimates from a visible rate card, labelled as such.
- **Rate limits are per process and per IP** (as seen through the host's proxy header), not distributed.

## Secrets and personal data

The repository contains no secrets: the hosted database URL is injected by the platform as `DATABASE_URL`. Commits
use a GitHub no-reply identity. The data set is invented ("Northwind Commerce"); card numbers are 4-digit fictional
endings. Report a problem by opening a GitHub issue.

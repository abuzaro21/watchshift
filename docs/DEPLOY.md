# Deploy

Live: **https://watchshift-l5nx.onrender.com**. Render workspace `WATCHSHIFT`, blueprint `watchshift`: service
`watchshift-l5nx` and database `watchshift-db-l5nx` (Render adds the suffix), both on free plans. The free
database expires 2026-12-12.

The hosted demo runs on Render's **free** plans: one Docker web service and one PostgreSQL 16 database, both in
Frankfurt, described by [`render.yaml`](../render.yaml). `autoDeploy` is off; every deploy is triggered on purpose.

## Isolation

WATCHSHIFT gets its **own Render workspace**. The owner's existing workspaces already host other challenge entries,
and those services and databases are not touched by this project. A separate workspace also gives this demo its own
free-database allowance.

## Steps

1. Workspace: `WATCHSHIFT` on the free Hobby plan, created by the owner (no payment method change).
2. Blueprint from the public repository `https://github.com/abuzaro21/watchshift`, file `render.yaml`, auto-sync off.
   Render creates `watchshift` (web, free) and `watchshift-db` (Postgres 16, free). The database URL is injected as
   `DATABASE_URL` by `fromDatabase`; no credential is typed, copied or committed.
3. Review the plan (two free resources, nothing else), approve it, wait for the deploy, then check:
   ```bash
   curl -s https://<service>.onrender.com/api/health     # {"ok":true,"store":"postgres",...}
   E2E_BASE_URL=https://<service>.onrender.com npx playwright test
   ```
4. Later deploys are deliberate: push, then plan and approve the blueprint again (or trigger a deploy).

## Free-plan facts to plan around

- **Cold start.** A free web service sleeps after about 15 minutes without traffic; the first request then takes
  up to a minute. Open the demo once before showing it.
- **Database expiry.** A free Render Postgres expires 30 days after creation, with a 14-day grace period before
  deletion. The demo stores only synthetic, short-lived workspaces (pruned after 6 hours), so nothing of value is lost:
  create a new free database, point `DATABASE_URL` at it and redeploy. The schema is created on start.
- **Without a database** the service still runs: if `DATABASE_URL` is unset it uses SQLite in the container's
  temporary disk, which resets on every restart or deploy.
- **One instance.** The design is a single writer per database (owner epoch fencing). If a second instance ever
  starts against the same database, the older one is fenced and refuses writes (health returns 503) rather than
  corrupting state.

## Local and container

```bash
npm ci && npm run build && npm start                         # SQLite in data/
DATABASE_URL=postgres://user:pass@host:5432/db npm start      # PostgreSQL
docker build -t watchshift . && docker run -p 3000:3000 watchshift
```

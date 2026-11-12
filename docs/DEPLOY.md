# Deploy

The hosted demo runs on Render's **free** plans: one Docker web service and one PostgreSQL 16 database, both in
Frankfurt, described by [`render.yaml`](../render.yaml). `autoDeploy` is off; every deploy is triggered on purpose.

## Isolation

WATCHSHIFT gets its **own Render workspace**. The owner's existing workspaces already host other challenge entries,
and those services and databases are not touched by this project. A separate workspace also gives this demo its own
free-database allowance.

## Steps

1. In the Render dashboard, create a workspace named `WATCHSHIFT` on the free Hobby plan (owner action; no payment
   method change).
2. Connect the GitHub repository `abuzaro21/watchshift` to that workspace.
3. **New > Blueprint**, select the repository; Render reads `render.yaml` and creates `watchshift` (web, free) and
   `watchshift-db` (Postgres 16, free). The database URL is injected as `DATABASE_URL`; nothing secret is in the repo.
4. Wait for the deploy, then check:
   ```bash
   curl -s https://<service>.onrender.com/api/health     # {"ok":true,"store":"postgres",...}
   E2E_BASE_URL=https://<service>.onrender.com npx playwright test
   ```

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

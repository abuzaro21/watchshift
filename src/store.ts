// Durable, append-only event store. Two adapters, one contract: SQLite (node:sqlite: local runs, tests, clean clone)
// and PostgreSQL (hosted demo). `append` is one transaction: owner-epoch fence + optimistic head check + events +
// effect rows (UNIQUE (workspace, op_id), so a duplicated effect can never be stored twice).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';

export type StoredEvent = { seq: number; ts: number; type: string; agent: string | null; hash: string; body: string };
export type EffectRow = { opId: string; tool: string; params: string; seq: number };
export type WorkspaceRow = { id: string; seed: number; created: number };

export class FencedError extends Error {
  constructor(mine: number, cur: number) { super(`fenced: this process holds owner epoch ${mine}, the database is owned by epoch ${cur}`); }
}
export class ConflictError extends Error {}

export interface Store {
  readonly kind: 'sqlite' | 'postgres';
  /** Become the single writer: bump and remember the owner epoch. Later writes by an older holder fail. */
  claim(holder: string): Promise<number>;
  createWorkspace(id: string, seed: number): Promise<void>;
  workspace(id: string): Promise<WorkspaceRow | null>;
  /** Atomic iff the workspace head is still `expected`. Throws ConflictError / FencedError / unique violation. */
  append(ws: string, expected: number, events: StoredEvent[], effects: EffectRow[]): Promise<void>;
  events(ws: string): Promise<StoredEvent[]>;
  effectIds(ws: string): Promise<string[]>;
  /** Delete workspaces idle since before `before` (ms). Returns how many. */
  /** Delete workspaces idle since `before`, except the ids in `keep` (workspaces currently in use). */
  prune(before: number, keep?: string[]): Promise<number>;
  count(): Promise<number>;
  close(): Promise<void>;
}

const DDL = (S: string, real: string) => `
  CREATE TABLE IF NOT EXISTS ${S}workspaces (id TEXT PRIMARY KEY, seed INTEGER NOT NULL, created ${real} NOT NULL, last_active ${real} NOT NULL, head INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS ${S}events (ws TEXT NOT NULL REFERENCES ${S}workspaces(id) ON DELETE CASCADE, seq INTEGER NOT NULL, ts ${real} NOT NULL,
    type TEXT NOT NULL, agent TEXT, hash TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (ws, seq));
  CREATE TABLE IF NOT EXISTS ${S}effects (ws TEXT NOT NULL REFERENCES ${S}workspaces(id) ON DELETE CASCADE, op_id TEXT NOT NULL, tool TEXT NOT NULL,
    params TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (ws, op_id));
  CREATE TABLE IF NOT EXISTS ${S}owner (id INTEGER PRIMARY KEY CHECK (id = 1), epoch BIGINT NOT NULL, holder TEXT NOT NULL, since ${real} NOT NULL);
`;

export class SqliteStore implements Store {
  readonly kind = 'sqlite' as const;
  private db: DatabaseSync;
  private epoch: number | null = null;
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    this.db.exec(DDL('', 'REAL'));
  }
  private tx<T>(fn: () => T, fenced = true): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (fenced && this.epoch !== null) {
        const cur = Number((this.db.prepare('SELECT epoch FROM owner WHERE id = 1').get() as { epoch: number } | undefined)?.epoch ?? 0);
        if (cur !== this.epoch) throw new FencedError(this.epoch, cur);
      }
      const r = fn(); this.db.exec('COMMIT'); return r;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  async claim(holder: string) {
    this.epoch = this.tx(() => Number((this.db.prepare(`INSERT INTO owner (id, epoch, holder, since) VALUES (1, 1, ?, ?)
      ON CONFLICT (id) DO UPDATE SET epoch = owner.epoch + 1, holder = excluded.holder, since = excluded.since RETURNING epoch`).get(holder, Date.now()) as { epoch: number }).epoch), false);
    return this.epoch;
  }
  async createWorkspace(id: string, seed: number) {
    const t = Date.now();
    this.tx(() => this.db.prepare('INSERT INTO workspaces (id, seed, created, last_active) VALUES (?, ?, ?, ?)').run(id, seed, t, t));
  }
  async workspace(id: string) {
    const r = this.db.prepare('SELECT id, seed, created FROM workspaces WHERE id = ?').get(id) as WorkspaceRow | undefined;
    return r ? { id: r.id, seed: Number(r.seed), created: Number(r.created) } : null;
  }
  async append(ws: string, expected: number, events: StoredEvent[], effects: EffectRow[]) {
    this.tx(() => {
      const head = events.length ? events[events.length - 1].seq : expected;
      const u = this.db.prepare('UPDATE workspaces SET head = ?, last_active = ? WHERE id = ? AND head = ?').run(head, Date.now(), ws, expected);
      if (Number(u.changes) !== 1) throw new ConflictError(`stream conflict on ${ws}: head is not ${expected}`);
      const ie = this.db.prepare('INSERT INTO events (ws, seq, ts, type, agent, hash, body) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const e of events) ie.run(ws, e.seq, e.ts, e.type, e.agent, e.hash, e.body);
      const ix = this.db.prepare('INSERT INTO effects (ws, op_id, tool, params, seq) VALUES (?, ?, ?, ?, ?)');
      for (const x of effects) ix.run(ws, x.opId, x.tool, x.params, x.seq);
    });
  }
  async events(ws: string) {
    return (this.db.prepare('SELECT seq, ts, type, agent, hash, body FROM events WHERE ws = ? ORDER BY seq').all(ws) as StoredEvent[])
      .map((e) => ({ ...e, seq: Number(e.seq), ts: Number(e.ts) }));
  }
  async effectIds(ws: string) {
    return (this.db.prepare('SELECT op_id FROM effects WHERE ws = ? ORDER BY seq').all(ws) as { op_id: string }[]).map((r) => r.op_id);
  }
  async prune(before: number, keep: string[] = []) {
    return this.tx(() => Number(this.db.prepare('DELETE FROM workspaces WHERE last_active < ? AND id NOT IN (SELECT value FROM json_each(?))').run(before, JSON.stringify(keep)).changes));
  }
  async count() { return Number((this.db.prepare('SELECT count(*) AS n FROM workspaces').get() as { n: number }).n); }
  async close() { this.db.close(); }
}

export class PgStore implements Store {
  readonly kind = 'postgres' as const;
  private epoch: number | null = null;
  private pool: pg.Pool; private S: string;
  private constructor(pool: pg.Pool, S: string) { this.pool = pool; this.S = S; }
  static async open(url: string, schema = 'watchshift') {
    if (!/^[a-z_][a-z0-9_]{0,40}$/.test(schema)) throw new Error('bad schema name');
    const pool = new pg.Pool({ connectionString: url, max: 5, ssl: /sslmode=require|render\.com/.test(url) ? { rejectUnauthorized: false } : undefined });
    const s = new PgStore(pool, `${schema}.`);
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await pool.query(DDL(s.S, 'DOUBLE PRECISION'));
    return s;
  }
  private async tx<T>(fn: (c: pg.PoolClient) => Promise<T>, fenced = true): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      if (fenced && this.epoch !== null) {
        const r = await c.query(`SELECT epoch FROM ${this.S}owner WHERE id = 1 FOR SHARE`);
        const cur = Number(r.rows[0]?.epoch ?? 0);
        if (cur !== this.epoch) throw new FencedError(this.epoch, cur);
      }
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }
  async claim(holder: string) {
    this.epoch = await this.tx(async (c) => Number((await c.query(`INSERT INTO ${this.S}owner (id, epoch, holder, since) VALUES (1, 1, $1, $2)
      ON CONFLICT (id) DO UPDATE SET epoch = ${this.S}owner.epoch + 1, holder = EXCLUDED.holder, since = EXCLUDED.since RETURNING epoch`, [holder, Date.now()])).rows[0].epoch), false);
    return this.epoch;
  }
  async createWorkspace(id: string, seed: number) {
    const t = Date.now();
    await this.tx((c) => c.query(`INSERT INTO ${this.S}workspaces (id, seed, created, last_active) VALUES ($1, $2, $3, $3)`, [id, seed, t]));
  }
  async workspace(id: string) {
    const r = (await this.pool.query(`SELECT id, seed, created FROM ${this.S}workspaces WHERE id = $1`, [id])).rows[0];
    return r ? { id: r.id, seed: Number(r.seed), created: Number(r.created) } : null;
  }
  async append(ws: string, expected: number, events: StoredEvent[], effects: EffectRow[]) {
    await this.tx(async (c) => {
      const head = events.length ? events[events.length - 1].seq : expected;
      const u = await c.query(`UPDATE ${this.S}workspaces SET head = $1, last_active = $2 WHERE id = $3 AND head = $4`, [head, Date.now(), ws, expected]);
      if (u.rowCount !== 1) throw new ConflictError(`stream conflict on ${ws}: head is not ${expected}`);
      for (const e of events) await c.query(`INSERT INTO ${this.S}events (ws, seq, ts, type, agent, hash, body) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [ws, e.seq, e.ts, e.type, e.agent, e.hash, e.body]);
      for (const x of effects) await c.query(`INSERT INTO ${this.S}effects (ws, op_id, tool, params, seq) VALUES ($1, $2, $3, $4, $5)`, [ws, x.opId, x.tool, x.params, x.seq]);
    });
  }
  async events(ws: string) {
    return (await this.pool.query(`SELECT seq, ts, type, agent, hash, body FROM ${this.S}events WHERE ws = $1 ORDER BY seq`, [ws])).rows
      .map((e) => ({ seq: Number(e.seq), ts: Number(e.ts), type: e.type, agent: e.agent, hash: e.hash, body: e.body }));
  }
  async effectIds(ws: string) {
    return (await this.pool.query(`SELECT op_id FROM ${this.S}effects WHERE ws = $1 ORDER BY seq`, [ws])).rows.map((r) => r.op_id as string);
  }
  async prune(before: number, keep: string[] = []) {
    return this.tx(async (c) => (await c.query(`DELETE FROM ${this.S}workspaces WHERE last_active < $1 AND NOT (id = ANY($2::text[]))`, [before, keep])).rowCount ?? 0);
  }
  async count() { return Number((await this.pool.query(`SELECT count(*) AS n FROM ${this.S}workspaces`)).rows[0].n); }
  async close() { await this.pool.end(); }
}

export async function openStore(env = process.env): Promise<Store> {
  if (env.DATABASE_URL) return PgStore.open(env.DATABASE_URL, env.WATCHSHIFT_PG_SCHEMA ?? 'watchshift');
  return new SqliteStore(env.WATCHSHIFT_DB ?? 'data/watchshift.db');
}

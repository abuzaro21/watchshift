import { after } from 'node:test';
import { createHash } from 'node:crypto';
import { SqliteStore, PgStore, type Store } from '../src/store.ts';
import { Workspace, type Ev } from '../src/engine.ts';

// Set WATCHSHIFT_TEST_DATABASE_URL to run the whole suite against PostgreSQL (one schema per store key per run).
const PG = process.env.WATCHSHIFT_TEST_DATABASE_URL;
const RUN = Date.now().toString(36);
const opened: Store[] = [];
export async function testStore(key = ':memory:'): Promise<Store> {
  if (!PG) return new SqliteStore(key);
  const name = key === ':memory:' ? `m${opened.length}${Math.random().toString(36).slice(2, 7)}` : createHash('sha1').update(key).digest('hex').slice(0, 10);
  const s = await PgStore.open(PG, `t_${RUN}_${name}`);
  opened.push(s);
  return s;
}
after(async () => { for (const s of opened) await s.close().catch(() => {}); });

export async function fresh(id = 'ws-test', store?: Store) {
  store ??= await testStore();
  await store.claim('test');
  const ws = await Workspace.create(store, id, 7, 1, 0);
  return { store, ws, clock: { now: 0 } };
}
/** Advance simulated time in 100 ms ticks until `until` holds (or the cap). */
export async function run(ws: Workspace, clock: { now: number }, until: (ws: Workspace) => boolean, capMs = 600_000) {
  const end = clock.now + capMs;
  while (!until(ws)) {
    if (clock.now > end) throw new Error(`condition not reached by t=${clock.now}`);
    clock.now += 100;
    await ws.tick(clock.now);
  }
}
export const evs = (ws: Workspace, type: string, agent?: string): Ev[] => ws.S.events.filter((e) => e.type === type && (!agent || e.agent === agent));
export const pendingFor = (ws: Workspace, agent: string) => Object.values(ws.S.approvals).find((a) => a.agent === agent && a.status === 'pending');

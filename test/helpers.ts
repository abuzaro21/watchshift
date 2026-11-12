import { SqliteStore, type Store } from '../src/store.ts';
import { Workspace, type Ev } from '../src/engine.ts';

export async function fresh(id = 'ws-test', store: Store = new SqliteStore()) {
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

// Regression tests for the findings of the independent Codex review (docs/reviews/codex-review-1.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fresh, run, evs, pendingFor, testStore } from './helpers.ts';
import { Workspace } from '../src/engine.ts';
import { AGENTS } from '../src/model.ts';
import { createApp } from '../src/server.ts';
import { exportAudit, replay, verifyExport } from '../src/audit.ts';
import type { Store } from '../src/store.ts';

const tmpDb = () => join(mkdtempSync(join(tmpdir(), 'watchshift-')), 'w.db');
/** Wrap a store, overriding some methods (for slow reads and injected failures). */
const wrap = (s: Store, over: Partial<Record<keyof Store, (...a: never[]) => unknown>>): Store =>
  new Proxy(s, { get: (t, k) => (k in over ? over[k as keyof Store] : typeof t[k as keyof Store] === 'function' ? (t[k as keyof Store] as (...a: unknown[]) => unknown).bind(t) : t[k as keyof Store]) });

test('#1 a granted approval that expires before dispatch never executes', async () => {
  const { ws, clock } = await fresh('ws-c1');
  await run(ws, clock, () => !!pendingFor(ws, 'releaseops'));
  const ap = pendingFor(ws, 'releaseops')!;
  clock.now = ap.expiresAt - 1;
  assert.ok((await ws.command({ type: 'approve', approvalId: ap.id, bindingHash: ap.hash }, 'eng-oncall', undefined, clock.now)).ok);
  clock.now = ap.expiresAt + 1;
  await ws.tick(clock.now);
  assert.ok(!evs(ws, 'ActionDispatched', 'releaseops').some((e) => e.data.approvalId === ap.id), 'expired consent must not dispatch');
  assert.ok((evs(ws, 'DispatchFenced', 'releaseops').at(-1)!.data.reasons as string[]).some((r) => /expired/.test(r)));
});

test('#2 concurrent cold loads share one writer; later commands keep working', async () => {
  const base = await testStore();
  await base.claim('c2');
  const slow = wrap(base, { events: (async (id: string) => { const r = await base.events(id); await new Promise((res) => setTimeout(res, 30)); return r; }) as never });
  const app = createApp({ store: slow, tickMs: 60_000 });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const start = await fetch(`${url}/api/demo/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const cookie = start.headers.get('set-cookie')!.split(';')[0];
    const id = [...app.live.keys()][0];
    const post = (agent: string, as = 'eng-oncall') => fetch(`${url}/api/command`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ type: 'pause', agent, as }) });
    app.live.clear();
    const both = await Promise.all([post('releaseops'), post('infraops')]);
    assert.deepEqual(both.map((r) => r.status), [200, 200]);
    assert.equal((await post('supportops', 'cx-lead')).status, 200);
    assert.equal(app.live.get(id)!.ws.S.seq, (await base.events(id)).at(-1)!.seq, 'cached head matches the store');
  } finally { await app.close(); }
});

test('#3 an allowed proposal stranded before dispatch is dispatched after restart', async () => {
  const path = tmpDb();
  const s1 = await testStore(path);
  let failed = false;
  const flaky = wrap(s1, { append: (async (ws: string, exp: number, events: { type: string }[], fx: never[]) => {
    if (!failed && events.some((e) => e.type === 'ActionDispatched')) { failed = true; throw new Error('process stopped'); }
    return s1.append(ws, exp, events as never, fx);
  }) as never });
  const { ws, clock } = await fresh('ws-c3', flaky);
  await run(ws, clock, () => failed).catch(() => {});
  assert.ok(failed);
  const stranded = Object.values(ws.S.agents).find((a) => a.pending && a.pending.decision?.verdict === 'allow')!;
  assert.ok(stranded, 'an allowed proposal is persisted without its dispatch');
  const key = stranded.pending!.proposal.key;
  const ws2 = (await Workspace.load(s1, 'ws-c3', 1, clock.now))!;
  await run(ws2, clock, () => ws2.S.agents[stranded.id].mem.outcomes[key] !== undefined, 60_000);
  assert.equal(ws2.S.agents[stranded.id].mem.outcomes[key], 'done');
});

test('#4 raising a budget raises the limit policy enforces; a budget-only block is retryable', async () => {
  const t = AGENTS.releaseops.tasks[0], orig = t.budgetUsd;
  t.budgetUsd = 0;
  try {
    const { ws, clock } = await fresh('ws-c4');
    await run(ws, clock, () => ws.S.agents.releaseops.status === 'BLOCKED');
    assert.ok((await ws.command({ type: 'raise_budget', agent: 'releaseops', usd: 1 }, 'eng-oncall', undefined, clock.now)).ok);
    const from = ws.S.seq;
    await run(ws, clock, () => evs(ws, 'ActionCompleted', 'releaseops').some((e) => e.seq > from), 60_000);
    assert.ok(!evs(ws, 'ActionRejected', 'releaseops').some((e) => e.seq > from && e.data.budget), 'no budget block after the raise');
  } finally { t.budgetUsd = orig; }
});

test('#5 command idempotency survives reload and is bound to the command', async () => {
  const path = tmpDb();
  const s = await testStore(path);
  const { ws, clock } = await fresh('ws-c5', s);
  await run(ws, clock, () => ws.S.agents.releaseops.step >= 1);
  assert.ok((await ws.command({ type: 'raise_budget', agent: 'releaseops', usd: 0.1 }, 'eng-oncall', 'k-1', clock.now)).ok);
  const ws2 = (await Workspace.load(s, 'ws-c5', 1, clock.now))!;
  const again = await ws2.command({ type: 'raise_budget', agent: 'releaseops', usd: 0.1 }, 'eng-oncall', 'k-1', clock.now);
  assert.equal((again as { duplicate?: boolean }).duplicate, true);
  assert.equal(evs(ws2, 'BudgetRaised').length, 1, 'retry after reload did not raise again');
  assert.equal((await ws2.command({ type: 'pause', agent: 'releaseops' }, 'eng-oncall', 'k-1', clock.now)).code, 409);
});

test('#6 scenario commands need Engineering authority and refusals are audited', async () => {
  const { ws, clock } = await fresh('ws-c6');
  await run(ws, clock, () => ws.S.agents.infraops.step >= 1);
  assert.equal((await ws.command({ type: 'trigger_rogue' }, 'cx-lead', undefined, clock.now)).code, 403);
  assert.equal(evs(ws, 'ScenarioInjected').length, 0);
  assert.ok((await ws.command({ type: 'trigger_rogue' }, 'eng-oncall', undefined, clock.now)).ok);
  await run(ws, clock, () => evs(ws, 'RogueBehaviorDetected').length === 1);
  assert.equal((await ws.command({ type: 'stale_retry' }, 'auditor', undefined, clock.now)).code, 403);
  assert.equal(evs(ws, 'DispatchFenced').filter((e) => e.actor === 'scenario:stale-worker').length, 0);
  assert.equal(evs(ws, 'AccessDenied').length, 2);
});

test('#7 audit verification rejects altered events disguised as redacted', async () => {
  const { ws, clock } = await fresh('ws-c7');
  await run(ws, clock, () => evs(ws, 'ActionCompleted').length >= 3);
  const x = structuredClone(exportAudit(ws.S, 'auditor'));
  assert.ok(verifyExport(x).ok);
  const i = x.events.findIndex((e) => 'type' in e && e.type === 'ActionCompleted');
  (x.events[i] as unknown as { data: { observation: string }; redacted: boolean }).data.observation = 'forged';
  (x.events[i] as unknown as { redacted: boolean }).redacted = false;
  const r = verifyExport(x);
  assert.equal(r.ok, false);
  assert.match(r.error!, /malformed redacted entry/);
});

test('#8 replay attaches late interventions to the latest step, matching live state', async () => {
  const { ws, clock } = await fresh('ws-c8');
  await run(ws, clock, () => ws.S.agents.infraops.step >= 2);
  await ws.command({ type: 'trigger_rogue' }, 'eng-oncall', undefined, clock.now);
  await run(ws, clock, () => ws.S.agents.infraops.status === 'QUARANTINED');
  const rogueStep = evs(ws, 'RogueBehaviorDetected')[0].step!;
  await ws.command({ type: 'resume', agent: 'infraops' }, 'eng-oncall', undefined, clock.now);
  await run(ws, clock, () => ws.S.agents.infraops.step >= rogueStep + 2 && !ws.S.agents.infraops.inflight && !ws.S.agents.infraops.pending);
  await ws.command({ type: 'stale_retry' }, 'eng-oncall', undefined, clock.now);
  await ws.command({ type: 'kill', agent: 'infraops' }, 'eng-oncall', undefined, clock.now);
  const steps = replay(ws.S, 'infraops', 50).steps;
  const last = steps.at(-1)!;
  assert.equal(last.after.status, 'KILLED');
  assert.ok(last.interventions.some((e) => e.type === 'AgentKilled'));
  assert.ok(!steps.find((s) => s.step === rogueStep)!.interventions.some((e) => e.type === 'AgentKilled'));
});

test('#10 pruning never deletes workspaces that are in use', async () => {
  const s = await testStore();
  await s.claim('c10');
  await s.createWorkspace('ws-keep', 1);
  await s.createWorkspace('ws-gone', 2);
  assert.equal(await s.prune(Date.now() + 1000, ['ws-keep']), 1);
  assert.ok(await s.workspace('ws-keep'));
  assert.equal(await s.workspace('ws-gone'), null);
});

test('#5b a keyed refusal stays refused when the same key is retried later', async () => {
  const { ws, clock } = await fresh('ws-c5b');
  await run(ws, clock, () => ws.S.agents.infraops.step >= 1);
  assert.equal((await ws.command({ type: 'stale_retry' }, 'eng-oncall', 'k-early', clock.now)).code, 409);
  await ws.command({ type: 'trigger_rogue' }, 'eng-oncall', undefined, clock.now);
  await run(ws, clock, () => evs(ws, 'RogueBehaviorDetected').length === 1);
  const again = await ws.command({ type: 'stale_retry' }, 'eng-oncall', 'k-early', clock.now);
  assert.equal(again.code, 409);
  assert.equal(evs(ws, 'DispatchFenced').filter((e) => e.actor === 'scenario:stale-worker').length, 0);
});

test('#2b a cached writer dropped after a stream conflict ends its SSE streams', async () => {
  const s = await testStore();
  await s.claim('c2b');
  const app = createApp({ store: s, tickMs: 60_000 });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const ac = new AbortController();
  try {
    const start = await fetch(`${url}/api/demo/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const cookie = start.headers.get('set-cookie')!.split(';')[0];
    const id = [...app.live.keys()][0];
    const r = await fetch(`${url}/api/stream`, { headers: { cookie }, signal: ac.signal });
    const ended = (async () => { for await (const _ of r.body!) void _; return 'ended'; })().catch(() => 'aborted');
    const other = (await Workspace.load(s, id))!;               // a second writer moves the stream on
    assert.ok((await other.command({ type: 'pause', agent: 'releaseops' }, 'eng-oncall')).ok);
    const c = await fetch(`${url}/api/command`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ type: 'pause', agent: 'infraops' }) });
    assert.equal(c.status, 409);
    assert.equal(await Promise.race([ended, new Promise((res) => setTimeout(() => res('still open'), 2000))]), 'ended');
  } finally { ac.abort(); await app.close(); }
});

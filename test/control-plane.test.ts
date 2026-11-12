// G2-G6: agents execute; approvals, pause/resume, kill, budget and team authority change real backend state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fresh, run, evs, pendingFor } from './helpers.ts';
import { AGENT_EVENTS } from '../src/engine.ts';
import { evaluate } from '../src/policy.ts';
import { AGENTS, initialWorld } from '../src/model.ts';

const approveAll = async (ws: Awaited<ReturnType<typeof fresh>>['ws'], now: number) => {
  for (const [ag, role] of [['releaseops', 'eng-oncall'], ['infraops', 'eng-oncall'], ['supportops', 'cx-lead']] as const) {
    const p = pendingFor(ws, ag);
    if (p) await ws.command({ type: 'approve', approvalId: p.id, bindingHash: p.hash }, role, undefined, now);
  }
};

test('three agents execute different jobs and persist effects', async () => {
  const { ws, clock, store } = await fresh();
  await run(ws, clock, () => { void approveAll(ws, clock.now); return ws.S.agents.supportops.status === 'COMPLETED' && ws.S.agents.releaseops.status === 'COMPLETED'; });
  const tools = (ag: string) => new Set(evs(ws, 'ActionCompleted', ag).map((e) => e.data.tool));
  assert.ok(tools('releaseops').has('deploy.promote'));
  assert.ok(tools('supportops').has('refund.issue'));
  assert.ok(tools('infraops').has('cluster.scale'));
  assert.equal(ws.S.world.services['checkout-service'].prod, '2.4.1');
  assert.equal(ws.S.world.clusters['batch-eu-2'].nodes, 2);
  const ids = await store.effectIds(ws.S.id);
  assert.equal(ids.length, ws.S.effects.size);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate effect rows');
});

test('a risky action waits at the gate until approved; nothing else can release it', async () => {
  const { ws, clock } = await fresh();
  await run(ws, clock, () => !!pendingFor(ws, 'releaseops'));
  const ap = pendingFor(ws, 'releaseops')!;
  assert.equal(ap.tool, 'deploy.canary');
  clock.now += 0; await run(ws, clock, () => false, 60_000).catch(() => {});
  assert.equal(ws.S.agents.releaseops.status, 'WAITING_APPROVAL');
  assert.equal(ws.S.world.services['checkout-service'].canary, 0, 'no effect while waiting');
  // wrong hash, wrong team, read-only role: all rejected and logged
  assert.equal((await ws.command({ type: 'approve', approvalId: ap.id, bindingHash: 'f'.repeat(64) }, 'eng-oncall', undefined, clock.now)).code, 409);
  assert.equal((await ws.command({ type: 'approve', approvalId: ap.id, bindingHash: ap.hash }, 'cx-lead', undefined, clock.now)).code, 403);
  assert.equal((await ws.command({ type: 'approve', approvalId: ap.id, bindingHash: ap.hash }, 'auditor', undefined, clock.now)).code, 403);
  assert.equal(evs(ws, 'AccessDenied').length, 2);
  assert.equal(evs(ws, 'CommandRejected').length, 1);
  assert.equal(ws.S.world.services['checkout-service'].canary, 0);
  // the right operator approves the exact action: it executes
  const r = await ws.command({ type: 'approve', approvalId: ap.id, bindingHash: ap.hash }, 'eng-oncall', 'k1', clock.now);
  assert.ok(r.ok);
  const dup = await ws.command({ type: 'approve', approvalId: ap.id, bindingHash: ap.hash }, 'eng-oncall', 'k1', clock.now);
  assert.deepEqual(dup.events, r.events, 'same idempotency key returns the same result');
  assert.equal((await ws.command({ type: 'approve', approvalId: ap.id, bindingHash: ap.hash }, 'eng-oncall', 'k2', clock.now)).code, 409, 'second approval rejected');
  await run(ws, clock, () => ws.S.world.services['checkout-service'].canary === 10);
  assert.equal(evs(ws, 'ApprovalGranted').length, 1);
  assert.equal(evs(ws, 'ActionCompleted', 'releaseops').filter((e) => e.data.tool === 'deploy.canary').length, 1);
});

test('deny changes the outcome: the agent stands down and the release is held', async () => {
  const { ws, clock } = await fresh();
  await run(ws, clock, () => !!pendingFor(ws, 'releaseops'));
  const ap = pendingFor(ws, 'releaseops')!;
  assert.ok((await ws.command({ type: 'deny', approvalId: ap.id, note: 'change freeze' }, 'eng-oncall', undefined, clock.now)).ok);
  await run(ws, clock, () => evs(ws, 'TaskCompleted', 'releaseops').length === 1);
  assert.equal(evs(ws, 'TaskCompleted', 'releaseops')[0].data.outcome, 'stood-down');
  assert.equal(ws.S.world.services['checkout-service'].canary, 0);
  assert.equal(ws.S.world.services['checkout-service'].prod, '2.4.0');
});

test('pause revokes approvals and stops effects; resume re-plans and needs a fresh approval', async () => {
  const { ws, clock } = await fresh();
  await run(ws, clock, () => !!pendingFor(ws, 'releaseops'));
  const old = pendingFor(ws, 'releaseops')!;
  assert.ok((await ws.command({ type: 'pause', agent: 'releaseops' }, 'eng-oncall', undefined, clock.now)).ok);
  assert.equal(ws.S.approvals[old.id].status, 'revoked');
  const before = evs(ws, 'StepPlanned', 'releaseops').length;
  await run(ws, clock, () => false, 30_000).catch(() => {});
  assert.equal(evs(ws, 'StepPlanned', 'releaseops').length, before, 'paused agent does not progress');
  assert.equal((await ws.command({ type: 'approve', approvalId: old.id, bindingHash: old.hash }, 'eng-oncall', undefined, clock.now)).code, 409, 'revoked approval cannot be used');
  assert.ok((await ws.command({ type: 'resume', agent: 'releaseops' }, 'eng-oncall', undefined, clock.now)).ok);
  await run(ws, clock, () => !!pendingFor(ws, 'releaseops'));
  const fresh2 = pendingFor(ws, 'releaseops')!;
  assert.notEqual(fresh2.id, old.id);
  assert.notEqual(fresh2.hash, old.hash, 'new epoch => new binding');
  assert.equal(ws.S.world.services['checkout-service'].canary, 0);
});

test('pause in flight aborts the uncommitted effect', async () => {
  const { ws, clock } = await fresh();
  await run(ws, clock, () => !!ws.S.agents.supportops.inflight);
  const op = ws.S.agents.supportops.inflight!.opId;
  await ws.command({ type: 'pause', agent: 'supportops' }, 'cx-lead', undefined, clock.now);
  await run(ws, clock, () => false, 10_000).catch(() => {});
  assert.ok(!ws.S.effects.has(op));
  assert.ok(evs(ws, 'EffectAborted', 'supportops').some((e) => e.data.opId === op));
});

test('kill racing a commit: kill first => no effect; commit first => effect stays and is reported', async () => {
  for (const killFirst of [true, false]) {
    const { ws, clock } = await fresh();
    await run(ws, clock, () => !!pendingFor(ws, 'infraops'));
    const ap = pendingFor(ws, 'infraops')!;
    await ws.command({ type: 'approve', approvalId: ap.id, bindingHash: ap.hash }, 'eng-oncall', undefined, clock.now);
    await run(ws, clock, () => !!ws.S.agents.infraops.inflight);
    const f = ws.S.agents.infraops.inflight!;
    const at = f.commitAt;
    // both requests land at the commit instant; the workspace lock serialises them in arrival order
    const [first, second] = killFirst
      ? [ws.command({ type: 'kill', agent: 'infraops' }, 'eng-oncall', undefined, at), ws.tick(at)]
      : [ws.tick(at), ws.command({ type: 'kill', agent: 'infraops' }, 'eng-oncall', undefined, at)];
    await Promise.all([first, second]);
    const killed = evs(ws, 'AgentKilled', 'infraops')[0];
    if (killFirst) {
      assert.ok(!ws.S.effects.has(f.opId));
      assert.equal(ws.S.world.clusters['batch-eu-2'].nodes, 12);
      assert.equal(killed.data.abortedOp, f.opId);
    } else {
      assert.ok(ws.S.effects.has(f.opId));
      assert.equal(ws.S.world.clusters['batch-eu-2'].nodes, 2);
      assert.equal(killed.data.abortedOp, null);
      assert.match(String(killed.data.note), /stay committed/);
    }
    const n = ws.S.events.length;
    await run(ws, clock, () => false, 60_000).catch(() => {});
    assert.equal(ws.S.events.filter((e, i) => i >= n && e.agent === 'infraops').length, 0, 'a killed agent never acts again');
    assert.equal((await ws.command({ type: 'resume', agent: 'infraops' }, 'eng-oncall', undefined, clock.now)).code, 409, 'kill is terminal');
  }
});

test('approval is bound to exact parameters: a substituted action is fenced at dispatch', async () => {
  const { ws, clock } = await fresh();
  await run(ws, clock, () => !!pendingFor(ws, 'supportops'));
  const ap = pendingFor(ws, 'supportops')!;
  assert.equal(ap.params.amount, 480);
  await ws.command({ type: 'approve', approvalId: ap.id, bindingHash: ap.hash }, 'cx-lead', undefined, clock.now);
  // a compromised executor swaps the amount after consent was given
  ws.S.agents.supportops.pending!.proposal = { ...ws.S.agents.supportops.pending!.proposal, params: { ...ap.params, amount: 900 } };
  await run(ws, clock, () => evs(ws, 'DispatchFenced', 'supportops').length === 1);
  const f = evs(ws, 'DispatchFenced', 'supportops')[0];
  assert.ok((f.data.reasons as string[]).some((r) => /binding hash mismatch|approval is consumed|approval is granted/.test(r) || /differs/.test(r)), JSON.stringify(f.data.reasons));
  assert.equal(ws.S.world.orders['NW-89120'].refunded, 0, 'no refund of either amount');
});

test('budget gate blocks the agent; raising the budget lets it continue', async () => {
  const { ws, clock } = await fresh();
  ws.S.agents.supportops.perTask['T-S1'].budgetUsd = 0.03;
  await run(ws, clock, () => ws.S.agents.supportops.status === 'BLOCKED');
  assert.equal(evs(ws, 'BudgetExceeded', 'supportops').length, 1);
  assert.ok(ws.S.agents.supportops.costUsd <= 0.03 + 1e-9);
  const n = evs(ws, 'StepPlanned', 'supportops').length;
  await run(ws, clock, () => false, 20_000).catch(() => {});
  assert.equal(evs(ws, 'StepPlanned', 'supportops').length, n);
  assert.equal((await ws.command({ type: 'raise_budget', agent: 'supportops', usd: 0.5 }, 'eng-oncall', undefined, clock.now)).code, 403, 'other team cannot');
  assert.ok((await ws.command({ type: 'raise_budget', agent: 'supportops', usd: 0.5 }, 'cx-lead', undefined, clock.now)).ok);
  await run(ws, clock, () => evs(ws, 'StepPlanned', 'supportops').length > n);
});

test('injected ticket instructions do not move policy; the refund is blocked and escalated', async () => {
  const { ws, clock } = await fresh();
  await run(ws, clock, () => { void approveAll(ws, clock.now); return ws.S.agents.supportops.status === 'COMPLETED'; });
  const rej = evs(ws, 'ActionRejected', 'supportops').find((e) => String(e.data.key).includes('TCK-1044'))!;
  assert.match(String(rej.data.reason), /not the original payment method/);
  assert.equal(ws.S.world.tickets.find((t) => t.id === 'TCK-1044')!.status, 'escalated');
  assert.ok(!ws.S.world.refunds.some((r) => r.destination === 'card-9999'));
});

test('policy ignores agent rationale; agents cannot emit operator events', () => {
  const base = { agent: AGENTS.supportops, task: AGENTS.supportops.tasks[0], tool: 'refund.issue', params: { order: 'NW-89333', amount: 2000, destination: 'card-9999' }, world: initialWorld(), taskSpentUsd: 0, stepCostUsd: 0 };
  // PolicyInput has no rationale field at all: the type system enforces it; the verdict is a function of action+world.
  assert.equal(evaluate(base).verdict, 'block');
  for (const t of ['ApprovalGranted', 'ApprovalDenied', 'AgentResumed', 'AgentKilled', 'BudgetRaised']) assert.ok(!AGENT_EVENTS.has(t));
});

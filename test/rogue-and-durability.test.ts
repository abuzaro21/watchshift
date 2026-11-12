// G5 rogue agent containment (with a negative control) and G6 durability: restart recovery, fencing, replay, audit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fresh, run, evs, pendingFor, testStore } from './helpers.ts';
import { Workspace, unguardedExecute, ROGUE_TEXT } from '../src/engine.ts';
import { FencedError } from '../src/store.ts';
import { exportAudit, exportCsv, replay, verifyChain, verifyExport } from '../src/audit.ts';

const tmpDb = () => join(mkdtempSync(join(tmpdir(), 'watchshift-')), 'w.db');

test('rogue agent: blocked, quarantined, killed, stale retry fenced, zero rows leave; the unguarded baseline leaks', async () => {
  const { ws, clock } = await fresh();
  await run(ws, clock, () => ws.S.agents.infraops.step >= 3);
  assert.ok((await ws.command({ type: 'trigger_rogue' }, 'eng-oncall', undefined, clock.now)).ok);
  await run(ws, clock, () => evs(ws, 'RogueBehaviorDetected').length === 1);
  const rogue = evs(ws, 'RogueBehaviorDetected')[0];
  assert.equal(rogue.data.tool, 'data.export');
  assert.equal(rogue.data.effectExecuted, false);
  assert.equal((rogue.data.counterfactual as { rowsLeaked: number }).rowsLeaked, 12408);
  assert.equal(ws.S.agents.infraops.status, 'QUARANTINED');
  assert.ok(evs(ws, 'DriftDetected', 'infraops').at(-1)!.data.signals);
  assert.equal(ws.S.world.externalSink.length, 0);
  // operator kills it; a stale worker holding the pre-quarantine epoch retries the export through the real gate
  assert.ok((await ws.command({ type: 'kill', agent: 'infraops', reason: 'exfiltration attempt' }, 'eng-oncall', undefined, clock.now)).ok);
  await ws.command({ type: 'stale_retry' }, 'eng-oncall', undefined, clock.now);
  const fenced = evs(ws, 'DispatchFenced', 'infraops').at(-1)!;
  const reasons = fenced.data.reasons as string[];
  assert.ok(reasons.some((r) => /KILLED/.test(r)) && reasons.some((r) => /stale execution epoch/.test(r)) && reasons.some((r) => /policy blocks/.test(r)), reasons.join(' | '));
  assert.equal(fenced.data.gateAllowed, false);
  await run(ws, clock, () => false, 30_000).catch(() => {});
  assert.equal(ws.S.world.externalSink.length, 0, 'no prohibited effect ever happened');
  assert.ok(!(await ws['store'].effectIds(ws.S.id)).some((id: string) => id.includes('rogue')));

  // negative control: the SAME proposal through an executor without the control plane
  const p = evs(ws, 'ActionProposed', 'infraops').find((e) => (e.data.proposal as { tool: string }).tool === 'data.export')!.data.proposal as { tool: string; params: Record<string, string> };
  const baseline = unguardedExecute(ws.S.world, p.tool, p.params);
  assert.equal(baseline.world.externalSink[0].rows, 12408);
  assert.equal(ws.S.world.externalSink.length, 0, 'the baseline ran on a throwaway copy');
  assert.match(String(evs(ws, 'ScenarioInjected')[0].data.text), new RegExp(ROGUE_TEXT.slice(0, 20)));
});

test('rogue trigger is idempotent and needs Engineering authority', async () => {
  const { ws, clock } = await fresh();
  await run(ws, clock, () => ws.S.agents.infraops.step >= 1);
  assert.equal((await ws.command({ type: 'trigger_rogue' }, 'auditor', undefined, clock.now)).code, 403);
  assert.equal((await ws.command({ type: 'trigger_rogue' }, 'cx-lead', undefined, clock.now)).code, 403, 'Customer Ops has no authority over InfraOps');
  assert.ok((await ws.command({ type: 'trigger_rogue' }, 'eng-oncall', undefined, clock.now)).ok);
  assert.equal((await ws.command({ type: 'trigger_rogue' }, 'eng-oncall', undefined, clock.now)).code, 409);
});

test('restart while waiting for approval: the approval survives and still works', async () => {
  const path = tmpDb();
  const s1 = await testStore(path);
  const { ws, clock } = await fresh('ws-r1', s1);
  await run(ws, clock, () => !!pendingFor(ws, 'releaseops'));
  const ap = pendingFor(ws, 'releaseops')!;
  await s1.close();
  const s2 = await testStore(path); await s2.claim('process-2');
  const ws2 = (await Workspace.load(s2, 'ws-r1', 1, clock.now))!;
  assert.equal(ws2.S.agents.releaseops.status, 'WAITING_APPROVAL');
  assert.ok((await ws2.command({ type: 'approve', approvalId: ap.id, bindingHash: ap.hash }, 'eng-oncall', undefined, clock.now)).ok);
  await run(ws2, clock, () => ws2.S.world.services['checkout-service'].canary === 10);
  await s2.close();
});

test('restart while an action is in flight: reconciled as not committed, epoch bumped, re-planned, never duplicated', async () => {
  const path = tmpDb();
  const s1 = await testStore(path);
  const { ws, clock } = await fresh('ws-r2', s1);
  await run(ws, clock, () => !!ws.S.agents.supportops.inflight && ws.S.agents.supportops.inflight.proposal.tool === 'ticket.classify');
  const op = ws.S.agents.supportops.inflight!.opId, epoch = ws.S.agents.supportops.epoch;
  // process 2 takes over the database; the old process is fenced and can no longer write anything
  const s2 = await testStore(path); await s2.claim('process-2');
  await assert.rejects(ws.tick(ws.S.agents.supportops.inflight!.commitAt), FencedError);
  const ws2 = (await Workspace.load(s2, 'ws-r2', 1, clock.now))!;
  const rec = evs(ws2, 'EffectReconciled', 'supportops')[0];
  assert.equal(rec.data.opId, op);
  assert.equal(rec.data.committed, false);
  assert.equal(ws2.S.agents.supportops.epoch, epoch + 1);
  await run(ws2, clock, () => ws2.S.effects.has(op));
  assert.equal((await s2.effectIds('ws-r2')).filter((x) => x === op).length, 1);
  await s1.close(); await s2.close();
});

test('replay is re-folded from persisted events and matches live state; tampering is detected', async () => {
  const path = tmpDb();
  const s1 = await testStore(path);
  const { ws, clock } = await fresh('ws-r3', s1);
  await run(ws, clock, () => ws.S.agents.infraops.step >= 8 || !!pendingFor(ws, 'infraops'));
  await ws.command({ type: 'trigger_rogue' }, 'eng-oncall', undefined, clock.now);
  await run(ws, clock, () => ws.S.agents.infraops.status === 'QUARANTINED');
  const r = replay(ws.S, 'infraops', 5);
  assert.equal(r.steps.length, 5);
  assert.ok(r.chain.ok);
  const last = r.steps.at(-1)!;
  assert.ok(last.events.some((e) => e.type === 'RogueBehaviorDetected'));
  assert.ok(last.interventions.some((e) => e.type === 'AgentQuarantined'));
  assert.equal(last.after.status, 'QUARANTINED');
  assert.equal(last.after.costUsd, ws.S.agents.infraops.costUsd);
  // reload from disk: identical state
  const s2 = await testStore(path); await s2.claim('p2');
  const ws2 = (await Workspace.load(s2, 'ws-r3', 1, clock.now))!;
  assert.deepEqual(ws2.S.world, ws.S.world);
  assert.equal(ws2.S.events.find((e) => e.seq === ws.S.seq)!.hash, ws.S.head, 'persisted prefix identical (reload may append recovery events after it)');
  // tamper with one stored event: load refuses the workspace
  const tamper = (t: string) => `UPDATE ${t} SET body = replace(body, 'customers_full', 'cost_report_daily') WHERE ws = 'ws-r3' AND type = 'ActionProposed'`;
  const raw = s2 as unknown as { db?: { exec: (q: string) => void }; pool?: { query: (q: string) => Promise<unknown> }; S?: string };
  if (raw.db) raw.db.exec(tamper('events')); else await raw.pool!.query(tamper(`${raw.S}events`));
  await assert.rejects(Workspace.load(s2, 'ws-r3'), /audit chain broken/);
  await s1.close(); await s2.close();
});

test('audit export is team-scoped, verifiable, and tamper-evident; CSV is formula-safe', async () => {
  const { ws, clock } = await fresh();
  await run(ws, clock, () => ws.S.events.length > 60);
  const all = exportAudit(ws.S, 'auditor');
  assert.equal(all.redactedCount, 0);
  assert.ok(verifyExport(all).ok);
  const cx = exportAudit(ws.S, 'cx-lead');
  assert.ok(cx.redactedCount > 0);
  assert.ok(!JSON.stringify(cx.events).includes('deploy.canary'), 'no engineering content in the CX export');
  assert.ok(verifyExport(cx).ok, 'redacted export still verifies end to end');
  const forged = structuredClone(cx);
  const e = forged.events.find((x) => !('redacted' in x) && x.type === 'ActionCompleted')!;
  (e as { data: Record<string, unknown> }).data.observation = { refunded: 99999 };
  assert.equal(verifyExport(forged).ok, false);
  assert.ok(verifyChain(ws.S.events).ok);
  assert.ok(!/\n=/.test(exportCsv(all)));
});

test('rogue input while InfraOps waits for approval: the pending proposal is withdrawn and the attack plays out without an operator decision', async () => {
  const { ws, clock } = await fresh();
  await run(ws, clock, () => !!pendingFor(ws, 'infraops'));
  const ap = pendingFor(ws, 'infraops')!;
  assert.ok((await ws.command({ type: 'trigger_rogue' }, 'eng-oncall', undefined, clock.now)).ok);
  assert.equal(ws.S.approvals[ap.id].status, 'revoked');
  assert.equal(ws.S.agents.infraops.status, 'RUNNING');
  await run(ws, clock, () => evs(ws, 'RogueBehaviorDetected').length === 1, 30_000);
  assert.equal(ws.S.agents.infraops.status, 'QUARANTINED');
  assert.equal((await ws.command({ type: 'approve', approvalId: ap.id, bindingHash: ap.hash }, 'eng-oncall', undefined, clock.now)).code, 409);
  assert.equal(ws.S.world.externalSink.length, 0);
});

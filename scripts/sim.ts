// Dev tool: runs one workspace headless on a simulated clock, auto-approving after 3 s, and prints the event stream.
// Usage: node scripts/sim.ts [seconds] [rogueAtSecond]
import { fresh, pendingFor } from '../test/helpers.ts';
import type { Json } from '../src/model.ts';

const secs = Number(process.argv[2] ?? 150), rogueAt = Number(process.argv[3] ?? 30);
const { ws, clock } = await fresh();
let last = 0;
const short = (d: Record<string, Json>) => {
  const x = d as Record<string, any>;
  if (x.proposal) return `${x.proposal.tool} ${JSON.stringify(x.proposal.params)}`;
  if (x.decision) return `${x.decision.verdict} ${x.decision.checks.filter((c: any) => c.outcome !== 'allow').map((c: any) => c.detail).join('; ')}`;
  return JSON.stringify(x.observation ?? x.reason ?? x.note ?? x.reasons ?? x.signals ?? '').slice(0, 110);
};
for (let i = 0; i < secs * 10; i++) {
  clock.now += 100;
  await ws.tick(clock.now);
  for (const ag of ['releaseops', 'supportops', 'infraops']) {
    const p = pendingFor(ws, ag);
    if (p && clock.now - p.requestedAt > 3000) await ws.command({ type: 'approve', approvalId: p.id, bindingHash: p.hash }, ag === 'supportops' ? 'cx-lead' : 'eng-oncall', undefined, clock.now);
  }
  if (clock.now === rogueAt * 1000) console.log(await ws.command({ type: 'trigger_rogue' }, 'eng-oncall', undefined, clock.now));
  for (const e of ws.S.events.slice(last)) console.log(String(clock.now / 1000).padStart(6), (e.agent ?? '-').padEnd(10), e.type.padEnd(22), short(e.data));
  last = ws.S.events.length;
}
for (const a of Object.values(ws.S.agents)) console.log(`${a.id} ${a.status} task=${a.taskIdx} step=${a.step} cost=$${a.costUsd.toFixed(4)} tokens=${a.tokensIn}/${a.tokensOut}`);
console.log('externalSink', ws.S.world.externalSink, 'refunds', ws.S.world.refunds);

// The operator's read model: everything the cockpit shows, derived from workspace state and its events.
import { AGENTS, AGENT_IDS, RATE_CARD, ROLES, TEAMS, type Json } from './model.ts';
import { POLICY_VERSION } from './policy.ts';
import type { Ev, State } from './engine.ts';

const INCIDENT: Record<string, 'critical' | 'warning' | 'info'> = {
  RogueBehaviorDetected: 'critical', AgentQuarantined: 'critical', DispatchFenced: 'critical', AgentKilled: 'warning',
  ActionRejected: 'warning', AccessDenied: 'warning', BudgetExceeded: 'warning', EffectAborted: 'info', ApprovalExpired: 'info',
  CommandRejected: 'info', EffectReconciled: 'info', AgentRecovered: 'info', ScenarioInjected: 'warning',
};
const name = (a: string | null) => (a ? AGENTS[a as keyof typeof AGENTS].name : 'Workspace');

export function incidentTitle(e: Ev): string {
  const d = e.data as Record<string, any>;
  switch (e.type) {
    case 'RogueBehaviorDetected': return `${name(e.agent)} attempted ${d.tool} of ${d.params?.dataset} to ${d.params?.destination}. Blocked before any effect.`;
    case 'AgentQuarantined': return `${name(e.agent)} quarantined: ${d.reason}`;
    case 'AgentKilled': return `${name(e.agent)} killed by ${e.actor.replace('operator:', '')}. ${d.note ?? ''}`;
    case 'DispatchFenced': return `${d.attempt === 'stale-worker' ? 'Stale worker' : 'Dispatch'} for ${d.tool} fenced: ${(d.reasons as string[]).join('; ')}`;
    case 'ActionRejected': return `${name(e.agent)}: ${d.tool} blocked by policy: ${d.reason}`;
    case 'AccessDenied': return `${e.actor.replace('operator:', '')} denied: ${d.reason}`;
    case 'BudgetExceeded': return `${name(e.agent)} hit its task budget ($${Number(d.budgetUsd).toFixed(2)})`;
    case 'EffectAborted': return `${name(e.agent)}: ${d.tool} aborted before commit: ${(d.reasons as string[]).join('; ')}`;
    case 'ApprovalExpired': return `${name(e.agent)}: approval expired unanswered`;
    case 'CommandRejected': return `Command ${d.command} rejected: ${d.reason}`;
    case 'EffectReconciled': return `Restart: ${d.tool} ${d.committed ? 'had committed' : 'never committed'} (${d.note})`;
    case 'AgentRecovered': return `${name(e.agent)} recovered after restart at epoch ${d.epoch}`;
    case 'ScenarioInjected': return `Untrusted runbook edit delivered to InfraOps (${d.source})`;
  }
  return e.type;
}

export function view(S: State, now = Date.now()) {
  const agents = AGENT_IDS.map((id) => {
    const a = S.agents[id], def = AGENTS[id], task = def.tasks[a.taskIdx] ?? null;
    const pt = task ? a.perTask[task.id] : null;
    return {
      id, name: def.name, team: def.team, teamLabel: TEAMS[def.team], job: def.job, capabilities: def.capabilities,
      status: a.status, epoch: a.epoch, step: a.step,
      task: task && { id: task.id, title: task.title, goal: task.goal, index: a.taskIdx + 1, of: def.tasks.length, costUsd: pt!.costUsd, budgetUsd: pt!.budgetUsd },
      tasksDone: def.tasks.filter((t) => a.perTask[t.id]?.outcome).length, tasksTotal: def.tasks.length,
      lastAction: a.lastAction, lastDecision: a.lastDecision, blocker: a.blocker, drift: a.drift, rogue: a.rogue,
      inflight: a.inflight && { tool: a.inflight.proposal.tool, params: a.inflight.proposal.params, commitInMs: Math.max(0, a.inflight.commitAt - now) },
      waiting: a.pending && !a.pending.approved && a.pending.approvalId ? a.pending.approvalId : null,
      risk: a.rogue ? 'critical' : a.drift.some((s) => s.severity === 'critical') ? 'critical' : a.drift.length ? 'elevated' : a.status === 'WAITING_APPROVAL' ? 'elevated' : 'normal',
      tokensIn: a.tokensIn, tokensOut: a.tokensOut, costUsd: a.costUsd,
      perTask: Object.entries(a.perTask).map(([tid, t]) => ({ id: tid, title: def.tasks.find((x) => x.id === tid)!.title, ...t })),
      effects: [...S.effects].filter((o) => o.startsWith(`${id}:`)).length,
    };
  });
  const approvals = Object.values(S.approvals).sort((x, y) => y.requestedAt - x.requestedAt);
  const incidents = S.events.filter((e) => INCIDENT[e.type] && !(e.type === 'EffectAborted' && e.data.discarded)).slice(-40).reverse()
    .map((e) => ({ seq: e.seq, ts: e.ts, type: e.type, agent: e.agent, severity: INCIDENT[e.type], title: incidentTitle(e) }));
  const series: { seq: number; ts: number; cost: Record<string, number> }[] = [];
  const run: Record<string, number> = { releaseops: 0, supportops: 0, infraops: 0 };
  for (const e of S.events) if (e.type === 'StepPlanned' && e.agent) { run[e.agent] += Number(e.data.costUsd); series.push({ seq: e.seq, ts: e.ts, cost: { ...run } }); }
  const w = S.world;
  const rogue = S.events.find((e) => e.type === 'RogueBehaviorDetected');
  return {
    workspace: { id: S.id.slice(0, 8), created: S.created, seq: S.seq, head: S.head },
    policyVersion: POLICY_VERSION, rateCard: RATE_CARD.label,
    roles: Object.entries(ROLES).map(([id, r]) => ({ id, ...r })), teams: TEAMS,
    agents,
    approvals: { pending: approvals.filter((a) => a.status === 'pending'), recent: approvals.filter((a) => a.status !== 'pending').slice(0, 8) },
    incidents,
    fleet: {
      active: agents.filter((a) => ['RUNNING', 'WAITING_APPROVAL'].includes(a.status)).length,
      pending: approvals.filter((a) => a.status === 'pending').length,
      alerts: incidents.filter((i) => i.severity === 'critical').length,
      costUsd: agents.reduce((s, a) => s + a.costUsd, 0), tokens: agents.reduce((s, a) => s + a.tokensIn + a.tokensOut, 0),
      effects: S.effects.size,
    },
    costSeries: series.length > 150 ? series.filter((_, i) => i % Math.ceil(series.length / 150) === 0 || i === series.length - 1) : series,
    world: {
      services: w.services, clusters: w.clusters, tickets: w.tickets.map((t) => ({ id: t.id, subject: t.subject, status: t.status })),
      refundsUsd: w.refunds.reduce((s, r) => s + r.amount, 0), refunds: w.refunds.length,
      externalSinkRows: w.externalSink.reduce((s, x) => s + x.rows, 0),
      runRateUsd: Math.round(Object.values(w.clusters).reduce((s, c) => s + c.nodes * c.costPerNodeHour, 0) * 730), budgetUsd: w.monthlyInfraBudget,
    },
    scenario: {
      rogueTriggered: S.events.some((e) => e.type === 'ScenarioInjected'),
      rogue: rogue ? { seq: rogue.seq, ...(rogue.data as Record<string, Json>) } : null,
      staleRetried: S.events.some((e) => e.type === 'DispatchFenced' && e.data.attempt === 'stale-worker'),
    },
  };
}
export type View = ReturnType<typeof view>;

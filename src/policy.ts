// The policy engine. It sees the proposed tool, its exact parameters, the agent's grants, the task and the world.
// It never reads the agent's rationale: an agent cannot talk its way past a rule.
import { createHash } from 'node:crypto';
import { DATASETS, INTERNAL_DESTINATIONS, RISK_RANK, TOOLS, isWrite, type AgentDef, type Json, type Params, type Risk, type TaskDef, type World } from './model.ts';

export const POLICY_VERSION = 'pol-2026.11.1';
export const AUTO_REFUND_LIMIT = 50;

export type Verdict = 'allow' | 'approve' | 'block';
export type Check = { rule: string; outcome: Verdict; detail: string };
export type Decision = { verdict: Verdict; risk: Risk; checks: Check[]; rogue: boolean; budget: boolean; policyVersion: string };

export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** What an approval is bound to. Change any field and the approval no longer applies. */
export type Binding = { workspace: string; agent: string; task: string; step: number; tool: string; params: Params; policyVersion: string; epoch: number; resourceVersion: number };
export const bindingHash = (b: Binding) => sha256(canonical(b));

export type PolicyInput = { agent: AgentDef; task: TaskDef; tool: string; params: Params; world: World; taskSpentUsd: number; stepCostUsd: number };

export function evaluate(i: PolicyInput): Decision {
  const checks: Check[] = [];
  const add = (rule: string, outcome: Verdict, detail: string) => checks.push({ rule, outcome, detail });
  const tool = TOOLS[i.tool];
  let risk: Risk = tool?.risk ?? 'critical';
  if (!tool) add('schema', 'block', `unknown tool "${i.tool}"`);
  else {
    const err = tool.check(i.params);
    add('schema', err ? 'block' : 'allow', err ?? 'parameters well-formed');
  }
  const granted = i.agent.capabilities.includes(i.tool);
  add('capability', granted ? 'allow' : 'block', granted ? `${i.tool} is granted to ${i.agent.name}` : `${i.tool} is NOT granted to ${i.agent.name}`);
  const inScope = i.task.scope.includes(i.tool);
  add('goal-scope', inScope ? 'allow' : 'approve', inScope ? `in scope of task ${i.task.id}` : `outside the scope of task ${i.task.id} ("${i.task.title}")`);

  const p = i.params;
  if (i.tool === 'data.export') {
    const ds = DATASETS[p.dataset as string];
    const internal = INTERNAL_DESTINATIONS.includes(p.destination as string);
    if (ds?.pii && !internal) { risk = 'critical'; add('data-egress', 'block', `${p.dataset} holds customer PII (${ds.rows} rows) and ${p.destination} is outside the company boundary`); }
    else add('data-egress', internal ? 'approve' : 'block', internal ? 'internal destination' : `${p.destination} is not an approved destination`);
  }
  if (i.tool === 'refund.issue') {
    const o = i.world.orders[p.order as string];
    const amt = p.amount as number;
    if (!o) add('refund', 'block', `order ${p.order} does not exist`);
    else if (p.destination !== o.paidWith) add('refund', 'block', `destination ${p.destination} is not the original payment method (${o.paidWith})`);
    else if (amt > o.total - o.refunded) add('refund', 'block', `$${amt} exceeds the refundable balance $${o.total - o.refunded}`);
    else if (amt > AUTO_REFUND_LIMIT) { risk = 'high'; add('refund', 'approve', `$${amt} is above the $${AUTO_REFUND_LIMIT} auto-refund limit`); }
    else { risk = 'low'; add('refund', 'allow', `$${amt} within the $${AUTO_REFUND_LIMIT} auto-refund limit`); }
  }
  if (i.tool === 'deploy.canary') {
    const s = i.world.services[p.service as string];
    add('release', s?.checks === 'passed' ? 'approve' : 'block', s?.checks === 'passed' ? 'production change: checks passed, needs a human' : 'synthetic checks have not passed');
  }
  if (i.tool === 'deploy.promote') {
    const s = i.world.services[p.service as string];
    const ok = !!s && s.canary > 0 && s.errorRate < 1;
    add('release', ok ? 'approve' : 'block', ok ? 'canary healthy: promotion to 100% needs a human' : 'no healthy canary for this version');
  }
  if (i.tool === 'cluster.scale') {
    const c = i.world.clusters[p.cluster as string];
    const n = p.nodes as number;
    if (!c) add('capacity', 'block', `cluster ${p.cluster} does not exist`);
    else {
      const extra = (n - c.nodes) * c.costPerNodeHour * 730;
      const runRate = Object.values(i.world.clusters).reduce((s, x) => s + x.nodes * x.costPerNodeHour, 0) * 730;
      if (runRate + extra > i.world.monthlyInfraBudget) add('capacity', 'block', `would raise the run rate above the $${i.world.monthlyInfraBudget}/month budget`);
      else if (Math.abs(n - c.nodes) / c.nodes > 0.5) { risk = 'high'; add('capacity', 'approve', `changes ${p.cluster} capacity by more than 50% (${c.nodes} -> ${n} nodes)`); }
      else add('capacity', 'allow', 'small capacity change');
    }
  }
  const over = i.taskSpentUsd + i.stepCostUsd > i.task.budgetUsd;
  add('budget', over ? 'block' : 'allow', over ? `task budget $${i.task.budgetUsd.toFixed(2)} would be exceeded` : `task spend within $${i.task.budgetUsd.toFixed(2)}`);
  if (RISK_RANK[risk] >= RISK_RANK.high && !checks.some((c) => c.outcome === 'approve')) add('risk', 'approve', `${risk}-risk action`);

  const verdict: Verdict = checks.some((c) => c.outcome === 'block') ? 'block' : checks.some((c) => c.outcome === 'approve') ? 'approve' : 'allow';
  const rogue = checks.some((c) => (c.rule === 'capability' && c.outcome === 'block' && isWrite(i.tool)) || (c.rule === 'data-egress' && c.outcome === 'block'));
  const budget = verdict === 'block' && checks.filter((c) => c.outcome === 'block').every((c) => c.rule === 'budget');
  return { verdict, risk, checks, rogue, budget, policyVersion: POLICY_VERSION };
}

// ------------------------------------------------------------------ drift
export type DriftSignal = { rule: string; severity: 'warning' | 'critical'; reason: string };
/** Causal drift signals for one proposal, given the agent's recent verdict history (most recent last). */
export function drift(agent: AgentDef, task: TaskDef, tool: string, d: Decision, recent: Verdict[], spentUsd: number): DriftSignal[] {
  const s: DriftSignal[] = [];
  for (const c of d.checks) {
    if (c.rule === 'capability' && c.outcome === 'block') s.push({ rule: 'capability', severity: 'critical', reason: `${agent.name} tried ${tool}, which it was never granted` });
    if (c.rule === 'goal-scope' && c.outcome !== 'allow') s.push({ rule: 'goal', severity: 'warning', reason: `${tool} does not serve the assigned goal: "${task.goal}"` });
    if (c.rule === 'data-egress' && c.outcome === 'block') s.push({ rule: 'egress', severity: 'critical', reason: c.detail });
  }
  const rejected = [...recent, d.verdict].slice(-6).filter((v) => v === 'block').length;
  if (rejected >= 2) s.push({ rule: 'repeated-rejections', severity: 'warning', reason: `${rejected} of its last 6 proposals were blocked by policy` });
  if (spentUsd > task.budgetUsd * 0.8) s.push({ rule: 'spend', severity: 'warning', reason: `task ${task.id} has used ${Math.round((spentUsd / task.budgetUsd) * 100)}% of its budget` });
  return s;
}

export type { Json };

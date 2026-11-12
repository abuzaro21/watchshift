// Replay and audit. Both read ONLY persisted events: replay re-folds them, export ships them with their hash chain.
import { AGENTS, ROLES, type AgentId, type Json, type Role } from './model.ts';
import { GENESIS, emptyState, fold, hashOf, type Ev, type State } from './engine.ts';

export type ChainCheck = { ok: boolean; checked: number; head: string; error?: string };
export function verifyChain(events: Ev[]): ChainCheck {
  let prev = GENESIS;
  for (const e of events) {
    if (e.prevHash !== prev) return { ok: false, checked: e.seq, head: prev, error: `#${e.seq}: prevHash does not link to #${e.seq - 1}` };
    if (hashOf(e) !== e.hash) return { ok: false, checked: e.seq, head: prev, error: `#${e.seq}: content does not match its hash` };
    prev = e.hash;
  }
  return { ok: true, checked: events.length, head: prev };
}

const teamOf = (e: Ev) => (e.agent ? AGENTS[e.agent].team : null);

// ------------------------------------------------------------------ replay
export type ReplayStep = {
  step: number; task: string | null; from: number; to: number; events: Pick<Ev, 'seq' | 'ts' | 'type' | 'actor' | 'data' | 'hash'>[];
  interventions: Pick<Ev, 'seq' | 'ts' | 'type' | 'actor' | 'data'>[];
  after: { status: string; epoch: number; costUsd: number; tokens: number };
};
/** The agent's last N steps, each with the lifecycle/operator events that happened up to the next step, and the
 *  agent's state as re-folded from the persisted log at the end of that step. */
export function replay(S: State, agent: AgentId, n: number): { agent: AgentId; n: number; steps: ReplayStep[]; chain: ChainCheck } {
  const steps = new Map<number, ReplayStep>();
  const R = emptyState(S.id, S.seed, S.created);
  let cur: ReplayStep | null = null;
  for (const e of S.events) {
    fold(R, e);
    if (e.agent !== agent) continue;
    // Only a newer step opens a new replay row. An event that references an older step (a stale retry, a late
    // reconciliation) happened now, so it is shown as an intervention on the latest step, not moved back in time.
    if (e.step !== null && (!cur || e.step >= cur.step)) {
      cur = steps.get(e.step) ?? { step: e.step, task: e.task, from: e.seq, to: e.seq, events: [], interventions: [], after: { status: '', epoch: 0, costUsd: 0, tokens: 0 } };
      steps.set(e.step, cur);
    }
    if (!cur) continue;
    const slim = { seq: e.seq, ts: e.ts, type: e.type, actor: e.actor, data: e.data, hash: e.hash };
    if (e.step === cur.step) cur.events.push(slim); else cur.interventions.push(slim);
    cur.to = e.seq;
    const a = R.agents[agent];
    if (a) cur.after = { status: a.status, epoch: a.epoch, costUsd: a.costUsd, tokens: a.tokensIn + a.tokensOut };
  }
  const k = Math.max(1, Math.min(50, Math.floor(n) || 10));
  return { agent, n: k, steps: [...steps.values()].slice(-k), chain: verifyChain(S.events) };
}

// ------------------------------------------------------------------ export
export type ExportEvent = Ev | { seq: number; prevHash: string; hash: string; redacted: true; reason: string };
export type AuditExport = {
  format: 'watchshift-audit/1'; workspace: string; exportedAt: string; exportedBy: string; scope: string;
  policyVersion: string; headHash: string; eventCount: number; redactedCount: number;
  note: string; events: ExportEvent[];
};
/** Team-scoped, verifiable export. Other teams' events are replaced by {seq, prevHash, hash} so the chain still
 *  verifies end to end while their content stays private. */
export function exportAudit(S: State, role: Role, now = Date.now()): AuditExport {
  const team = ROLES[role].team;
  const events: ExportEvent[] = S.events.map((e) => {
    const t = teamOf(e);
    return team === null || t === null || t === team ? e : { seq: e.seq, prevHash: e.prevHash, hash: e.hash, redacted: true as const, reason: `belongs to team ${t}` };
  });
  return {
    format: 'watchshift-audit/1', workspace: S.id, exportedAt: new Date(now).toISOString(), exportedBy: ROLES[role].label,
    scope: team ?? 'all teams', policyVersion: S.events.at(-1)?.policyVersion ?? '', headHash: S.head, eventCount: events.length,
    redactedCount: events.filter((e) => 'redacted' in e).length,
    note: 'SHA-256 hash chain: hash = sha256(prevHash + canonical(event fields)). Verify with `npm run verify-audit <file>`. All effects are SIMULATED; token usage is SIMULATED and costs are ESTIMATES.',
    events,
  };
}
const STUB_KEYS = new Set(['seq', 'prevHash', 'hash', 'redacted', 'reason']);
export function verifyExport(x: AuditExport): ChainCheck & { redacted: number } {
  let prev = GENESIS, redacted = 0;
  for (const e of x.events) {
    if (e.prevHash !== prev) return { ok: false, checked: e.seq, head: prev, redacted, error: `#${e.seq}: chain link broken` };
    if ('redacted' in e) {
      // A redacted entry must be a bare stub: anything else could smuggle unverified content past the hash check.
      if (e.redacted !== true || !Object.keys(e).every((k) => STUB_KEYS.has(k))) return { ok: false, checked: e.seq, head: prev, redacted, error: `#${e.seq}: malformed redacted entry` };
      redacted++;
    } else if (hashOf(e) !== e.hash) return { ok: false, checked: e.seq, head: prev, redacted, error: `#${e.seq}: content does not match its hash` };
    prev = e.hash;
  }
  if (prev !== x.headHash) return { ok: false, checked: x.events.length, head: prev, redacted, error: 'head hash does not match the export header' };
  return { ok: true, checked: x.events.length, head: prev, redacted };
}

const FORMULA = /^[=+\-@\t\r]/;
const csvCell = (v: unknown) => { const s = typeof v === 'string' ? v : JSON.stringify(v ?? ''); return /[",\n\r]/.test(s) || FORMULA.test(s) ? `"${(FORMULA.test(s) ? `'${s}` : s).replace(/"/g, '""')}"` : s; };
export function exportCsv(x: AuditExport): string {
  const rows = [['seq', 'time_utc', 'type', 'agent', 'team', 'task', 'step', 'actor', 'summary', 'hash']];
  for (const e of x.events) {
    if ('redacted' in e) { rows.push([String(e.seq), '', 'REDACTED', '', '', '', '', '', e.reason, e.hash]); continue; }
    const d = e.data as Record<string, Json>;
    const summary = (d.reason ?? d.note ?? (d.proposal as Record<string, Json> | undefined)?.tool ?? d.tool ?? '') as string;
    rows.push([String(e.seq), new Date(e.ts).toISOString(), e.type, e.agent ?? '', e.agent ? AGENTS[e.agent].team : '', e.task ?? '', e.step === null ? '' : String(e.step), e.actor, String(summary), e.hash]);
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

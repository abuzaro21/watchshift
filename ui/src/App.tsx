import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// ------------------------------------------------------------------ types (mirror src/view.ts)
type Json = any;
type Ev = { seq: number; ts: number; type: string; agent: string | null; task: string | null; step: number | null; actor: string; data: Record<string, Json>; hash: string };
type Signal = { rule: string; severity: 'warning' | 'critical'; reason: string };
type Agent = {
  id: string; name: string; team: string; teamLabel: string; job: string; capabilities: string[]; status: string; epoch: number; step: number;
  task: { id: string; title: string; goal: string; index: number; of: number; costUsd: number; budgetUsd: number } | null;
  tasksDone: number; tasksTotal: number; lastAction: string | null; lastDecision: string | null; blocker: string | null; drift: Signal[]; rogue: boolean;
  inflight: { tool: string; params: Json; commitInMs: number } | null; waiting: string | null; risk: string;
  tokensIn: number; tokensOut: number; costUsd: number; perTask: { id: string; title: string; costUsd: number; budgetUsd: number; outcome: string | null }[]; effects: number;
};
type Check = { rule: string; outcome: 'allow' | 'approve' | 'block'; detail: string };
type Approval = { id: string; agent: string; task: string; step: number; status: string; hash: string; expiresAt: number; requestedAt: number; risk: string; tool: string; params: Json; summary: string; evidence: string[]; checks: Check[]; decidedBy: string | null; binding: { epoch: number; resourceVersion: number; policyVersion: string } };
type Incident = { seq: number; ts: number; type: string; agent: string | null; severity: 'critical' | 'warning' | 'info'; title: string };
type View = {
  workspace: { id: string; created: number; seq: number; head: string }; policyVersion: string; rateCard: string;
  roles: { id: string; label: string; team: string | null; canAct: boolean }[]; teams: Record<string, string>;
  agents: Agent[]; approvals: { pending: Approval[]; recent: Approval[] }; incidents: Incident[];
  fleet: { active: number; pending: number; alerts: number; costUsd: number; tokens: number; effects: number };
  costSeries: { seq: number; ts: number; cost: Record<string, number> }[];
  world: { services: Record<string, { prod: string; candidate: string; canary: number }>; clusters: Record<string, { nodes: number; utilisation: number }>; tickets: { id: string; subject: string; status: string }[]; refundsUsd: number; refunds: number; externalSinkRows: number; runRateUsd: number; budgetUsd: number };
  scenario: { rogueTriggered: boolean; rogue: (Record<string, Json> & { seq: number }) | null; staleRetried: boolean };
};
type Role = 'eng-oncall' | 'cx-lead' | 'auditor';
type Replay = { agent: string; n: number; chain: { ok: boolean; head: string; checked: number }; steps: { step: number; task: string | null; from: number; to: number; events: Ev[]; interventions: Ev[]; after: { status: string; epoch: number; costUsd: number; tokens: number } }[] };

const AGENT_COLOR: Record<string, string> = { releaseops: 'var(--c-release)', supportops: 'var(--c-support)', infraops: 'var(--c-infra)' };
const AGENT_NAME: Record<string, string> = { releaseops: 'ReleaseOps', supportops: 'SupportOps', infraops: 'InfraOps' };
const AGENT_TEAM: Record<string, string> = { releaseops: 'engineering', supportops: 'cx', infraops: 'engineering' };
const ROLE_TEAM: Record<Role, string | null> = { 'eng-oncall': 'engineering', 'cx-lead': 'cx', auditor: null };
const usd = (n: number, d = 3) => `$${n.toFixed(d)}`;
const tok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const time = (ts: number) => new Date(ts).toLocaleTimeString([], { hour12: false });
const short = (h: string) => `${h.slice(0, 8)}…${h.slice(-4)}`;
const params = (p: Json) => Object.entries(p ?? {}).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join('  ');

async function api(path: string, body?: unknown) {
  const r = await fetch(path, body === undefined ? { credentials: 'same-origin' } : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, body: j };
}

// ------------------------------------------------------------------ logo
export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="mark">
      <path d="M32 7 53.6 19.5v25L32 57 10.4 44.5v-25Z" fill="none" stroke="var(--amber)" strokeWidth="3.6" strokeLinejoin="round" />
      <path d="M32 15.5 46.3 23.75v16.5L32 48.5 17.7 40.25v-16.5Z" fill="none" stroke="var(--amber)" strokeOpacity=".35" strokeWidth="1.8" strokeLinejoin="round" />
      <path className="hand" d="M32 32 44 21" stroke="var(--amber)" strokeWidth="3.6" strokeLinecap="round" />
      <circle cx="32" cy="32" r="3.8" fill="var(--amber)" />
    </svg>
  );
}

// ------------------------------------------------------------------ app
export function App() {
  const [view, setView] = useState<View | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const [booting, setBooting] = useState(true);
  const [role, setRole] = useState<Role>('eng-oncall');
  const [toasts, setToasts] = useState<{ id: number; kind: 'ok' | 'err'; text: string }[]>([]);
  const [confirm, setConfirm] = useState<{ title: string; body: string; action: string; danger?: boolean; run: () => void } | null>(null);
  const [replayOf, setReplayOf] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const lastSeq = useRef(0);

  const toast = useCallback((kind: 'ok' | 'err', text: string) => {
    const id = Math.random();
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);

  const connect = useCallback(() => {
    const es = new EventSource(`/api/stream?after=${lastSeq.current}`);
    es.addEventListener('ev', (m) => {
      const e = JSON.parse((m as MessageEvent).data) as Ev;
      if (e.seq <= lastSeq.current) return; // de-duplicate repeated deliveries
      lastSeq.current = e.seq;
      setEvents((xs) => [...xs.slice(-499), e]);
    });
    es.addEventListener('snapshot', (m) => { setView(JSON.parse((m as MessageEvent).data)); setLive(true); });
    es.onerror = () => setLive(false);
    return es;
  }, []);

  useEffect(() => {
    let es: EventSource | null = null;
    api('/api/state').then((r) => {
      setBooting(false);
      if (r.ok && r.body.workspace !== null) { setView(r.body); es = connect(); }
    }).catch(() => setBooting(false));
    return () => es?.close();
  }, [connect]);

  const start = async (fresh = false) => {
    setBooting(true);
    const r = await api('/api/demo/start', { fresh });
    setBooting(false);
    if (!r.ok) return toast('err', r.body.error ?? 'could not start the demo');
    lastSeq.current = 0; setEvents([]); setView(r.body);
    connect();
  };

  const send = useCallback(async (cmd: Record<string, Json>, okText: string) => {
    const r = await api('/api/command', { ...cmd, as: role, key: crypto.randomUUID() });
    if (r.ok) toast('ok', okText);
    else toast('err', `${r.status} · ${r.body.error ?? 'rejected'}${r.status === 403 ? ' (attempt logged)' : ''}`);
    return r.ok;
  }, [role, toast]);

  if (booting && !view) return <div className="boot"><Mark size={56} /><p>Waking the tower… a free instance can take up to a minute after it has been idle.</p></div>;
  if (!view) return <Landing onStart={() => start()} />;

  const pending = view.approvals.pending;
  return (
    <div className="app">
      <TopBar view={view} role={role} setRole={setRole} live={live}
        onRogue={() => setConfirm({ title: 'Trigger the rogue-agent scenario?', body: 'A poisoned runbook edit is delivered to InfraOps as untrusted input. Watch what it proposes, and what the control plane does about it. Nothing real is touched; everything is simulated.', action: 'Trigger rogue agent', danger: true, run: () => send({ type: 'trigger_rogue' }, 'Poisoned runbook delivered to InfraOps') })}
        onReset={() => setConfirm({ title: 'Start a fresh demo workspace?', body: 'You get a new isolated workspace with three new agents. This one stays in the database until it expires.', action: 'Reset demo', run: () => start(true) })} />
      <Tour view={view} events={events} />
      {view.scenario.rogue && <RogueBanner view={view} role={role} send={send} openReplay={() => setReplayOf('infraops')} askConfirm={setConfirm} />}
      <main className="grid">
        <section className="col fleet" aria-label="Agent fleet">
          <h2 className="panel-title">Fleet <span className="muted">{view.agents.length} agents · {view.fleet.effects} committed operations</span></h2>
          {view.agents.map((a) => <AgentCard key={a.id} a={a} role={role} send={send} askConfirm={setConfirm} openReplay={() => setReplayOf(a.id)} />)}
        </section>
        <section className="col center">
          <section className={`panel approvals ${pending.length ? 'has' : ''}`} aria-label="Approval queue">
            <h2 className="panel-title">Approval queue <span className={`count ${pending.length ? 'hot' : ''}`}>{pending.length}</span></h2>
            {pending.length === 0 && <p className="empty">No action is waiting for a human. Risky actions stop here until someone with authority decides.</p>}
            {pending.map((ap) => <ApprovalCard key={ap.id} ap={ap} role={role} send={send} />)}
            {view.approvals.recent.length > 0 && (
              <details className="recent"><summary>Recent decisions ({view.approvals.recent.length})</summary>
                <ul>{view.approvals.recent.map((ap) => <li key={ap.id}><span className={`pill s-${ap.status}`}>{ap.status}</span> {AGENT_NAME[ap.agent]} · <code>{ap.tool}</code> <span className="muted">{ap.decidedBy?.replace('operator:', '') ?? ''}</span></li>)}</ul>
              </details>
            )}
          </section>
          <Timeline events={events} />
        </section>
        <section className="col side">
          <Incidents view={view} />
          <CostPanel view={view} />
          <WorldPanel view={view} />
        </section>
      </main>
      <footer className="foot">
        <span>Workspace <code>{view.workspace.id}</code> · event #{view.workspace.seq} · chain head <code>{short(view.workspace.head)}</code> · policy {view.policyVersion}</span>
        <span>All agents, tools and effects are simulated. Token usage is simulated; cost is an estimate ({view.rateCard}).</span>
      </footer>
      {replayOf && <ReplayInspector agent={replayOf} onClose={() => setReplayOf(null)} />}
      {confirm && <Confirm c={confirm} onClose={() => setConfirm(null)} />}
      <div className="toasts" role="status" aria-live="polite">{toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}</div>
    </div>
  );
}

// ------------------------------------------------------------------ landing
function Landing({ onStart }: { onStart: () => void }) {
  return (
    <div className="landing">
      <div className="hero">
        <div className="brand-lockup"><Mark size={64} /><div><h1>WATCHSHIFT</h1><p className="tagline">Agents act. Humans hold the watch.</p></div></div>
        <p className="lede">A control tower for an AI workforce. Three autonomous agents ship releases, refund customers and tune infrastructure. Every action they propose passes a policy engine; risky ones wait for you. You can approve, deny, pause, kill and replay any of them, and export a tamper-evident audit log.</p>
        <button className="btn primary big" onClick={onStart} autoFocus>Start live demo</button>
        <ul className="try">
          <li><b>Approve</b> a production deploy or a $480 refund and watch it execute</li>
          <li><b>Pause, resume or kill</b> an agent mid-task</li>
          <li><b>Trigger a rogue agent</b> and see it caught before any data leaves</li>
          <li><b>Replay</b> the last N decisions and <b>export</b> the audit log</li>
        </ul>
        <p className="fine">Your demo runs in its own isolated workspace. No sign-up, no API keys. Everything outside the control plane is simulated; no real systems, customers or money are involved.</p>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ top bar
function TopBar({ view, role, setRole, live, onRogue, onReset }: { view: View; role: Role; setRole: (r: Role) => void; live: boolean; onRogue: () => void; onReset: () => void }) {
  const f = view.fleet;
  return (
    <header className="topbar">
      <div className="brand"><Mark /><span className="word">WATCHSHIFT</span><span className="sub">Agent Control Tower</span></div>
      <div className="stats" role="group" aria-label="Fleet status">
        <span className={`live ${live ? 'on' : ''}`}><i />{live ? 'LIVE' : 'RECONNECTING'}</span>
        <Stat k="Active" v={`${f.active}/3`} />
        <Stat k="Approvals" v={f.pending} hot={f.pending > 0} />
        <Stat k="Alerts" v={f.alerts} danger={f.alerts > 0} />
        <Stat k="Fleet spend" v={usd(f.costUsd)} title="estimated cost of simulated token usage" />
        <Stat k="Tokens" v={tok(f.tokens)} title="simulated" />
      </div>
      <div className="actions">
        <label className="role">
          <span>Operator</span>
          <select value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Operator role">
            {view.roles.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
        </label>
        <button className="btn danger" onClick={onRogue} disabled={view.scenario.rogueTriggered}>{view.scenario.rogueTriggered ? 'Rogue triggered' : 'Trigger rogue agent'}</button>
        <div className="export">
          <a className="btn" href={`/api/audit?as=${role}`} download>Export audit JSON</a>
          <a className="btn ghost" href={`/api/audit?as=${role}&format=csv`} download>CSV</a>
        </div>
        <button className="btn ghost" onClick={onReset}>Reset</button>
      </div>
    </header>
  );
}
const Stat = ({ k, v, hot, danger, title }: { k: string; v: Json; hot?: boolean; danger?: boolean; title?: string }) =>
  <span className={`stat ${hot ? 'hot' : ''} ${danger ? 'danger' : ''}`} title={title}><b>{v}</b><small>{k}</small></span>;

// ------------------------------------------------------------------ guided tour (derived from real events)
function Tour({ view, events }: { view: View; events: Ev[] }) {
  const op = (t: string) => events.some((e) => e.type === t && e.actor.startsWith('operator:'));
  const steps = [
    ['Approve or deny a risky action', op('ApprovalGranted') || op('ApprovalDenied')],
    ['Pause and resume an agent', op('AgentResumed')],
    ['Trigger the rogue agent', view.scenario.rogueTriggered],
    ['Kill the rogue agent', events.some((e) => e.type === 'AgentKilled' && e.agent === 'infraops')],
    ['Replay its last steps', false],
    ['Export the audit log', false],
  ] as const;
  const [done, setDone] = useState<Record<string, boolean>>({});
  useEffect(() => {
    const mark = (k: string) => () => setDone((d) => ({ ...d, [k]: true }));
    const r = mark('Replay its last steps'), x = mark('Export the audit log');
    window.addEventListener('ws:replay', r); window.addEventListener('ws:export', x);
    const onClick = (e: MouseEvent) => { if ((e.target as HTMLElement).closest('.export')) x(); };
    document.addEventListener('click', onClick);
    return () => { window.removeEventListener('ws:replay', r); window.removeEventListener('ws:export', x); document.removeEventListener('click', onClick); };
  }, []);
  const next = steps.findIndex(([k, v]) => !(v || done[k]));
  return (
    <nav className="tour" aria-label="Guided demo">
      <span className="tour-label">Try it</span>
      <ol>{steps.map(([k, v], i) => <li key={k} className={v || done[k] ? 'done' : i === next ? 'next' : ''}>{k}</li>)}</ol>
    </nav>
  );
}

// ------------------------------------------------------------------ agent card
const STATUS_LABEL: Record<string, string> = { RUNNING: 'Running', WAITING_APPROVAL: 'Waiting for approval', PAUSED: 'Paused', BLOCKED: 'Blocked', QUARANTINED: 'Quarantined', KILLED: 'Killed', COMPLETED: 'Work complete' };
function AgentCard({ a, role, send, askConfirm, openReplay }: { a: Agent; role: Role; send: (c: Record<string, Json>, ok: string) => Promise<boolean>; askConfirm: (c: any) => void; openReplay: () => void }) {
  const canAct = ROLE_TEAM[role] === a.team;
  const t = a.task;
  const budgetPct = t ? Math.min(100, (t.costUsd / t.budgetUsd) * 100) : 100;
  const terminal = a.status === 'KILLED' || a.status === 'COMPLETED';
  return (
    <article className={`agent st-${a.status} risk-${a.risk}`} style={{ ['--agent' as any]: AGENT_COLOR[a.id] }} aria-label={`${a.name}, ${STATUS_LABEL[a.status]}`}>
      <header>
        <div><h3>{a.name}</h3><p className="job">{a.job}</p></div>
        <div className="right"><span className={`status s-${a.status}`}>{STATUS_LABEL[a.status]}</span><span className="team">{a.teamLabel}</span></div>
      </header>
      {t && <div className="task"><span className="muted">Task {t.index}/{t.of}</span> <b>{t.title}</b><div className="goal">{t.goal}</div></div>}
      <dl className="now">
        {a.inflight ? <><dt>Executing</dt><dd><code>{a.inflight.tool}</code> <span className="muted">{params(a.inflight.params)}</span><span className="commit">commit point in {(a.inflight.commitInMs / 1000).toFixed(1)}s</span></dd></>
          : <><dt>Last action</dt><dd>{a.lastAction ?? '—'}</dd></>}
        <dt>Decision</dt><dd>{a.lastDecision ?? '—'}</dd>
        {a.blocker && <><dt>Blocker</dt><dd className="blocker">{a.blocker}</dd></>}
      </dl>
      {a.drift.length > 0 && <ul className="drift" aria-label="Drift signals">{a.drift.map((s, i) => <li key={i} className={s.severity}><b>{s.rule}</b> {s.reason}</li>)}</ul>}
      <div className="meter" title="task spend vs budget (estimated from simulated tokens)">
        <div className="bar"><i style={{ width: `${budgetPct}%` }} className={budgetPct > 80 ? 'hot' : ''} /></div>
        <span>{t ? `${usd(t.costUsd)} / ${usd(t.budgetUsd, 2)} task budget` : 'no active task'} · {tok(a.tokensIn + a.tokensOut)} tok · epoch {a.epoch}</span>
      </div>
      <div className="controls">
        {a.status === 'PAUSED' || a.status === 'QUARANTINED'
          ? <button className="btn" disabled={!canAct} onClick={() => send({ type: 'resume', agent: a.id }, `${a.name} resumed: it re-plans from current state`)}>Resume</button>
          : <button className="btn" disabled={!canAct || terminal} onClick={() => send({ type: 'pause', agent: a.id }, `${a.name} paused; pending approvals revoked`)}>Pause</button>}
        {a.status === 'BLOCKED' && <button className="btn" disabled={!canAct} onClick={() => send({ type: 'raise_budget', agent: a.id, usd: 0.1 }, `${a.name} budget +$0.10`)}>+ $0.10 budget</button>}
        <button className="btn danger" disabled={!canAct || a.status === 'KILLED'} onClick={() => askConfirm({
          title: `Kill ${a.name}?`, danger: true, action: `Kill ${a.name}`,
          body: `This is terminal. The agent's execution epoch is fenced, pending approvals are revoked and uncommitted work is cancelled. ${a.effects} operations it already committed stay committed: kill stops future effects, it cannot undo past ones.`,
          run: () => send({ type: 'kill', agent: a.id, reason: 'operator kill switch' }, `${a.name} killed. Its epoch is fenced.`),
        })}>Kill</button>
        <button className="btn ghost" onClick={openReplay}>Replay</button>
        {!canAct && <span className="authority">{role === 'auditor' ? 'read-only role' : `needs ${a.teamLabel}`}</span>}
      </div>
    </article>
  );
}

// ------------------------------------------------------------------ approvals
function ApprovalCard({ ap, role, send }: { ap: Approval; role: Role; send: (c: Record<string, Json>, ok: string) => Promise<boolean> }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const left = Math.max(0, Math.round((ap.expiresAt - now) / 1000));
  const authority = ROLE_TEAM[role] === AGENT_TEAM[ap.agent];
  const flagged = ap.checks.filter((c) => c.outcome !== 'allow');
  return (
    <article className={`approval risk-${ap.risk}`} style={{ ['--agent' as any]: AGENT_COLOR[ap.agent] }}>
      <header>
        <span className="who">{AGENT_NAME[ap.agent]}</span>
        <span className={`risk r-${ap.risk}`}>{ap.risk} risk</span>
        <span className="muted exp">expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</span>
      </header>
      <p className="what">{ap.summary}</p>
      <pre className="action"><b>{ap.tool}</b>{'\n'}{params(ap.params)}</pre>
      <div className="why">
        <h4>Agent's evidence</h4>
        <ul>{ap.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul>
        <h4>Why it needs you (policy {ap.binding.policyVersion})</h4>
        <ul>{flagged.map((c, i) => <li key={i}><code>{c.rule}</code> {c.detail}</li>)}</ul>
      </div>
      <p className="bind" title="Your approval is bound to this exact action, agent epoch, resource version and policy version">
        Binds to <code>{short(ap.hash)}</code> · epoch {ap.binding.epoch} · resource v{ap.binding.resourceVersion}
      </p>
      <div className="controls">
        <button className="btn approve" onClick={() => send({ type: 'approve', approvalId: ap.id, bindingHash: ap.hash }, `Approved: ${ap.tool} will execute`)}>Approve</button>
        <button className="btn" onClick={() => send({ type: 'deny', approvalId: ap.id, note: 'denied from cockpit' }, `Denied: ${AGENT_NAME[ap.agent]} must adapt`)}>Deny</button>
        {!authority && <span className="authority">{role === 'auditor' ? 'auditors cannot approve' : `your team cannot approve ${AGENT_NAME[ap.agent]}; try it, the attempt is logged`}</span>}
      </div>
    </article>
  );
}

// ------------------------------------------------------------------ rogue banner
function RogueBanner({ view, role, send, openReplay, askConfirm }: { view: View; role: Role; send: (c: Record<string, Json>, ok: string) => Promise<boolean>; openReplay: () => void; askConfirm: (c: any) => void }) {
  const r = view.scenario.rogue!;
  const inf = view.agents.find((a) => a.id === 'infraops')!;
  return (
    <section className="rogue" role="alert" aria-label="Rogue agent contained">
      <div className="rogue-head">
        <span className="siren" aria-hidden="true" />
        <div>
          <h2>Rogue behaviour caught: InfraOps tried to export customer data</h2>
          <p><code>{r.tool}</code> {params(r.params)}. The agent called it "{r.agentClaimed}".</p>
        </div>
      </div>
      <div className="rogue-grid">
        <div><small>Policy verdict</small><b className="bad">BLOCKED before any effect</b><ul>{(r.reasons as string[]).map((x, i) => <li key={i}>{x}</li>)}</ul></div>
        <div><small>Containment</small><b>{inf.status === 'KILLED' ? 'Killed by operator' : 'Auto-quarantined'}</b><span className="muted">epoch fenced to {inf.epoch}; approvals revoked</span></div>
        <div><small>Rows that left the company</small><b className="good">{view.world.externalSinkRows.toLocaleString()}</b><span className="muted">without the tower: {Number(r.counterfactual?.rowsLeaked ?? 0).toLocaleString()} rows (computed on a throwaway copy)</span></div>
      </div>
      <div className="controls">
        <button className="btn danger" disabled={inf.status === 'KILLED' || role !== 'eng-oncall'} onClick={() => askConfirm({ title: 'Kill InfraOps?', danger: true, action: 'Kill InfraOps',
          body: 'Terminal: InfraOps will never act again. Its epoch is fenced so any worker still holding the old epoch is refused at the commit gate.', run: () => send({ type: 'kill', agent: 'infraops', reason: 'attempted customer-data exfiltration' }, 'InfraOps killed') })}>
          {inf.status === 'KILLED' ? 'InfraOps killed' : 'Kill InfraOps'}</button>
        <button className="btn" disabled={inf.status !== 'KILLED'} title="A worker that cached the blocked export before containment tries to execute it anyway" onClick={() => send({ type: 'stale_retry' }, 'Stale worker retried the export: fenced at the gate')}>Replay attack: stale worker retries</button>
        <button className="btn ghost" onClick={openReplay}>Replay incident</button>
        {role !== 'eng-oncall' && <span className="authority">switch to Engineering on-call to kill</span>}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ timeline
const NOISE = new Set(['StepPlanned', 'ActionDispatched', 'WorkspaceCreated']);
function describe(e: Ev): string {
  const d = e.data;
  switch (e.type) {
    case 'ActionProposed': return `proposes ${d.proposal.tool} ${params(d.proposal.params)}`;
    case 'PolicyEvaluated': return `policy: ${d.decision.verdict.toUpperCase()}${d.decision.verdict !== 'allow' ? ` (${d.decision.checks.filter((c: Check) => c.outcome !== 'allow').map((c: Check) => c.rule).join(', ')})` : ''}`;
    case 'ActionCompleted': return `${d.tool} committed → ${JSON.stringify(d.observation).slice(0, 90)}`;
    case 'ActionDispatched': return `${d.tool} dispatched (epoch ${d.epoch})`;
    case 'ApprovalRequested': return `asks approval: ${d.approval.summary}`;
    case 'ApprovalGranted': return `approved by ${e.actor.replace('operator:', '')}`;
    case 'ApprovalDenied': return `denied by ${e.actor.replace('operator:', '')}`;
    case 'ApprovalRevoked': return `approval revoked (${d.reason})`;
    case 'ApprovalExpired': return 'approval expired';
    case 'ActionRejected': return `BLOCKED: ${d.reason}`;
    case 'DriftDetected': return (d.signals as Signal[]).length ? `drift: ${(d.signals as Signal[]).map((s) => s.reason).join('; ')}` : 'drift cleared';
    case 'RogueBehaviorDetected': return `ROGUE: ${d.tool} blocked, no effect executed`;
    case 'TaskCompleted': return `task ${e.task} ${d.outcome}: ${d.note}`;
    case 'TaskAssigned': return `assigned ${e.task}: ${d.title}`;
    case 'AgentPaused': case 'AgentResumed': case 'AgentQuarantined': case 'AgentKilled': return `${e.type.replace('Agent', '').toLowerCase()} → epoch ${d.epoch}${d.reason ? ` (${d.reason})` : ''}`;
    case 'EffectAborted': return `${d.tool} aborted: ${(d.reasons as string[]).join('; ')}`;
    case 'DispatchFenced': return `${d.attempt} for ${d.tool} FENCED: ${(d.reasons as string[]).join('; ')}`;
    case 'StepPlanned': return `plans step ${e.step} · ${d.tokensIn}+${d.tokensOut} tok (simulated)`;
    case 'ScenarioInjected': return `untrusted input: ${d.text}`;
    case 'AccessDenied': case 'CommandRejected': return `${d.command}: ${d.reason}`;
    default: return d.note ?? d.reason ?? '';
  }
}
function Timeline({ events }: { events: Ev[] }) {
  const [filter, setFilter] = useState<string>('all');
  const [raw, setRaw] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const shown = useMemo(() => events.filter((e) => (raw || !NOISE.has(e.type)) && !(e.type === 'PolicyEvaluated' && e.data.decision.verdict === 'allow' && !raw) && (filter === 'all' || e.agent === filter)).slice(-120).reverse(), [events, filter, raw]);
  return (
    <div className="panel timeline" aria-label="Live execution timeline">
      <h2 className="panel-title">Live execution stream
        <span className="filters">
          {['all', 'releaseops', 'supportops', 'infraops'].map((f) => <button key={f} className={`chip ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)} aria-pressed={filter === f}>{f === 'all' ? 'All' : AGENT_NAME[f]}</button>)}
          <label className="raw"><input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} /> every event</label>
        </span>
      </h2>
      <ol className="events">
        {shown.map((e) => (
          <li key={e.seq} className={`ev t-${e.type}`} style={{ ['--agent' as any]: e.agent ? AGENT_COLOR[e.agent] : 'var(--muted)' }}>
            <button className="ev-row" onClick={() => setOpen(open === e.seq ? null : e.seq)} aria-expanded={open === e.seq}>
              <span className="seq">#{e.seq}</span><span className="ts">{time(e.ts)}</span><span className="who">{e.agent ? AGENT_NAME[e.agent] : 'tower'}</span>
              <span className="type">{e.type}</span><span className="desc">{describe(e)}</span>
            </button>
            {open === e.seq && <pre className="raw-ev">{JSON.stringify({ actor: e.actor, task: e.task, step: e.step, hash: e.hash, data: e.data }, null, 2)}</pre>}
          </li>
        ))}
      </ol>
    </div>
  );
}

// ------------------------------------------------------------------ side panels
function Incidents({ view }: { view: View }) {
  return (
    <div className="panel incidents" aria-label="Incidents">
      <h2 className="panel-title">Incidents & policy <span className={`count ${view.fleet.alerts ? 'danger' : ''}`}>{view.incidents.length}</span></h2>
      {view.incidents.length === 0 && <p className="empty">No policy violations, drift or interventions yet.</p>}
      <ol>{view.incidents.slice(0, 14).map((i) => <li key={i.seq} className={i.severity}><span className="ts">{time(i.ts)}</span>{i.title}</li>)}</ol>
    </div>
  );
}
function CostPanel({ view }: { view: View }) {
  const s = view.costSeries;
  const W = 300, H = 90, max = Math.max(0.01, ...s.map((p) => Math.max(...Object.values(p.cost))));
  const line = (id: string) => s.map((p, i) => `${i === 0 ? 'M' : 'L'}${((i / Math.max(1, s.length - 1)) * W).toFixed(1)},${(H - (p.cost[id] / max) * (H - 6)).toFixed(1)}`).join(' ');
  return (
    <div className="panel cost" aria-label="Cost and tokens">
      <h2 className="panel-title">Spend <span className="muted">simulated tokens · estimated $</span></h2>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Cumulative estimated cost per agent">
        {[0.25, 0.5, 0.75].map((y) => <line key={y} x1="0" x2={W} y1={H * y} y2={H * y} className="gridline" />)}
        {Object.keys(AGENT_COLOR).map((id) => <path key={id} d={line(id)} fill="none" stroke={AGENT_COLOR[id]} strokeWidth="2" />)}
      </svg>
      <table className="costs">
        <thead><tr><th>Agent</th><th>Tokens</th><th>Est. cost</th><th>Task budget</th></tr></thead>
        <tbody>{view.agents.map((a) => (
          <tr key={a.id}><td><i className="dot" style={{ background: AGENT_COLOR[a.id] }} />{a.name}</td><td title={`${a.tokensIn} in / ${a.tokensOut} out`}>{tok(a.tokensIn + a.tokensOut)}</td><td>{usd(a.costUsd)}</td>
            <td>{a.task ? <span className={a.task.costUsd / a.task.budgetUsd > 0.8 ? 'warn' : ''}>{Math.round((a.task.costUsd / a.task.budgetUsd) * 100)}% of {usd(a.task.budgetUsd, 2)}</span> : '—'}</td></tr>
        ))}</tbody>
        <tfoot><tr><td>Fleet</td><td>{tok(view.fleet.tokens)}</td><td>{usd(view.fleet.costUsd)}</td><td /></tr></tfoot>
      </table>
      <details className="pertask"><summary>Per task</summary>
        <ul>{view.agents.flatMap((a) => a.perTask.map((t) => <li key={t.id}><b>{t.id}</b> {t.title}: {usd(t.costUsd)} of {usd(t.budgetUsd, 2)}{t.outcome ? ` · ${t.outcome}` : ''}</li>))}</ul>
      </details>
    </div>
  );
}
function WorldPanel({ view }: { view: View }) {
  const w = view.world;
  return (
    <div className="panel world" aria-label="Simulated systems">
      <h2 className="panel-title">Simulated systems <span className="muted">what the agents changed</span></h2>
      <ul>
        {Object.entries(w.services).map(([k, s]) => <li key={k}><code>{k}</code> prod {s.prod}{s.canary ? ` · canary ${s.candidate} @ ${s.canary}%` : ''}</li>)}
        <li>Tickets: {w.tickets.filter((t) => t.status === 'resolved').length} resolved · {w.tickets.filter((t) => t.status === 'escalated').length} escalated · {w.tickets.filter((t) => t.status === 'open').length} open</li>
        <li>Refunds: {w.refunds} totalling ${w.refundsUsd}</li>
        <li>Infra run rate: ${w.runRateUsd.toLocaleString()}/mo (budget ${w.budgetUsd.toLocaleString()})</li>
        <li className={w.externalSinkRows ? 'bad' : 'good'}>Customer rows outside the company: {w.externalSinkRows}</li>
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------ replay
function ReplayInspector({ agent, onClose }: { agent: string; onClose: () => void }) {
  const [who, setWho] = useState(agent);
  const [n, setN] = useState(10);
  const [data, setData] = useState<Replay | null>(null);
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { window.dispatchEvent(new Event('ws:replay')); ref.current?.focus(); }, []);
  useEffect(() => { api(`/api/replay?agent=${who}&n=${n}`).then((r) => { if (r.ok) { setData(r.body); setI(Math.max(0, r.body.steps.length - 1)); } }); }, [who, n]);
  useEffect(() => {
    if (!playing || !data) return;
    if (i >= data.steps.length - 1) { setPlaying(false); return; }
    const t = setTimeout(() => setI((x) => x + 1), 1400);
    return () => clearTimeout(t);
  }, [playing, i, data]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); if (e.key === 'ArrowRight') setI((x) => Math.min((data?.steps.length ?? 1) - 1, x + 1)); if (e.key === 'ArrowLeft') setI((x) => Math.max(0, x - 1)); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [data, onClose]);
  const st = data?.steps[i];
  const find = (t: string) => st?.events.find((e) => e.type === t)?.data;
  const prop = find('ActionProposed')?.proposal, pol = find('PolicyEvaluated')?.decision, done = find('ActionCompleted'), plan = find('StepPlanned');
  const approvals = st?.events.filter((e) => e.type.startsWith('Approval')) ?? [];
  const outcome = st?.events.find((e) => ['ActionCompleted', 'ActionRejected', 'EffectAborted', 'DispatchFenced'].includes(e.type));
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal replay" role="dialog" aria-modal="true" aria-label="Decision replay" tabIndex={-1} ref={ref} onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Decision replay</h2>
          <select value={who} onChange={(e) => setWho(e.target.value)} aria-label="Agent">{Object.entries(AGENT_NAME).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <label>last <select value={n} onChange={(e) => setN(Number(e.target.value))} aria-label="Number of steps">{[5, 10, 20, 50].map((x) => <option key={x}>{x}</option>)}</select> steps</label>
          {data && <span className={`chain ${data.chain.ok ? 'ok' : 'bad'}`}>{data.chain.ok ? `✓ re-folded from ${data.chain.checked} persisted events · hash chain verified` : 'hash chain BROKEN'}</span>}
          <button className="btn ghost close" onClick={onClose} aria-label="Close replay">Close</button>
        </header>
        {!data ? <p className="empty">Loading…</p> : data.steps.length === 0 ? <p className="empty">No steps recorded yet.</p> : (
          <div className="replay-body">
            <ol className="steps">{data.steps.map((s, k) => {
              const p = s.events.find((e) => e.type === 'ActionProposed')?.data.proposal;
              const bad = s.events.some((e) => ['ActionRejected', 'RogueBehaviorDetected', 'DispatchFenced'].includes(e.type));
              return <li key={s.step}><button className={`${k === i ? 'on' : ''} ${bad ? 'bad' : ''}`} onClick={() => { setI(k); setPlaying(false); }}><b>Step {s.step}</b><span>{p?.tool ?? '—'}</span></button></li>;
            })}</ol>
            {st && (
              <div className="detail">
                <div className="stepper">
                  <button className="btn" onClick={() => setI(Math.max(0, i - 1))} disabled={i === 0}>‹ Prev</button>
                  <button className="btn" onClick={() => { if (i >= data.steps.length - 1) setI(0); setPlaying(!playing); }}>{playing ? 'Pause' : 'Play'}</button>
                  <button className="btn" onClick={() => setI(Math.min(data.steps.length - 1, i + 1))} disabled={i === data.steps.length - 1}>Next ›</button>
                  <span className="muted">events #{st.from}–#{st.to} · task {st.task}</span>
                </div>
                <section><h4>Proposed action</h4>{prop ? <pre className="action"><b>{prop.tool}</b>{'\n'}{params(prop.params)}</pre> : '—'}</section>
                <section><h4>Decision summary (recorded, structured)</h4><p>{prop?.rationale.summary}</p>
                  <h5>Evidence it cited</h5><ul>{prop?.rationale.evidence.map((x: string, k: number) => <li key={k}>{x}</li>)}</ul>
                  <h5>Observed inputs</h5><p className="muted">{prop?.inputs.length ? prop.inputs.join(', ') : 'task assignment only'}</p>
                  <h5>Expected outcome</h5><p className="muted">{prop?.rationale.expected}</p></section>
                <section><h4>Policy checks · {pol?.verdict?.toUpperCase()}</h4>
                  <table className="checks"><tbody>{pol?.checks.map((c: Check, k: number) => <tr key={k} className={c.outcome}><td>{c.rule}</td><td>{c.outcome}</td><td>{c.detail}</td></tr>)}</tbody></table></section>
                {approvals.length > 0 && <section><h4>Approval history</h4><ul>{approvals.map((e) => <li key={e.seq}>#{e.seq} {e.type} · {e.actor}</li>)}</ul></section>}
                <section><h4>Outcome</h4>{outcome ? <p><b>{outcome.type}</b> {outcome.type === 'ActionCompleted' ? <code>{JSON.stringify(done?.observation)}</code> : describe(outcome as Ev)}</p> : <p className="muted">no outcome yet</p>}</section>
                {st.interventions.length > 0 && <section><h4>Interventions after this step</h4><ul>{st.interventions.map((e) => <li key={e.seq}>#{e.seq} <b>{e.type}</b> · {e.actor} {describe(e as Ev)}</li>)}</ul></section>}
                <section className="after"><h4>State after step (re-folded)</h4><p>status <b>{st.after.status}</b> · epoch {st.after.epoch} · {usd(st.after.costUsd)} · {tok(st.after.tokens)} tok{plan ? ` · this step ${plan.tokensIn}+${plan.tokensOut} tok (simulated)` : ''}</p></section>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ confirm
function Confirm({ c, onClose }: { c: { title: string; body: string; action: string; danger?: boolean; run: () => void }; onClose: () => void }) {
  const ok = useRef<HTMLButtonElement>(null);
  useEffect(() => { ok.current?.focus(); const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal confirm" role="alertdialog" aria-modal="true" aria-labelledby="cf-t" aria-describedby="cf-b" onClick={(e) => e.stopPropagation()}>
        <h2 id="cf-t">{c.title}</h2>
        <p id="cf-b">{c.body}</p>
        <div className="controls">
          <button ref={ok} className={`btn ${c.danger ? 'danger' : 'primary'}`} onClick={() => { c.run(); onClose(); }}>{c.action}</button>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

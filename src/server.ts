// HTTP API + SSE + static UI. Tenant = the workspace named by an HttpOnly cookie; no endpoint takes a workspace id.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { Workspace, type Command, type Ev } from './engine.ts';
import { ConflictError, FencedError, type Store } from './store.ts';
import { view } from './view.ts';
import { exportAudit, exportCsv, replay } from './audit.ts';
import { isAgentId, isRole, type Role } from './model.ts';

export type Opts = { store: Store; tickMs?: number; speed?: number; publicDir?: string; maxLive?: number; idleMs?: number; retentionMs?: number; secureCookies?: boolean; trustProxyHops?: number };
const COOKIE = 'watchshift_ws';
const HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin', 'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

/** Fixed-window per-key rate limiter. ponytail: in-memory, one process; move to the DB if this ever runs >1 instance. */
class Limiter {
  private hits = new Map<string, { n: number; reset: number }>();
  private limit: number; private windowMs: number;
  constructor(limit: number, windowMs: number) { this.limit = limit; this.windowMs = windowMs; }
  ok(key: string, now = Date.now()) {
    const h = this.hits.get(key);
    if (!h || now >= h.reset) { this.hits.set(key, { n: 1, reset: now + this.windowMs }); if (this.hits.size > 10_000) this.hits.clear(); return true; }
    return ++h.n <= this.limit;
  }
}

export function createApp(o: Opts) {
  const { store } = o;
  const tickMs = o.tickMs ?? 250, speed = o.speed ?? 1, maxLive = o.maxLive ?? 150, idleMs = o.idleMs ?? 15 * 60_000, retentionMs = o.retentionMs ?? 6 * 3600_000;
  type Entry = { ws: Workspace; touched: number; streams: number; ends: Set<() => void> };
  const live = new Map<string, Entry>();
  /** Drop a cached writer that lost a stream conflict, and end its SSE streams so clients reconnect to a fresh one. */
  const invalidate = (id: string) => { const e = live.get(id); live.delete(id); for (const end of e?.ends ?? []) end(); };
  let fenced: string | null = null;
  const createLimit = new Limiter(30, 3600_000), cmdLimit = new Limiter(40, 10_000), readLimit = new Limiter(240, 10_000);
  let sse = 0;
  const loading = new Map<string, Promise<Workspace | null>>();

  async function get(id: string | undefined) {
    if (!id || !/^[0-9a-f-]{36}$/.test(id)) return null;
    let e = live.get(id);
    if (!e) {
      // One load per workspace at a time: two concurrent loads would build two writers with separate locks.
      let p = loading.get(id);
      if (!p) { p = Workspace.load(store, id, speed).finally(() => loading.delete(id)); loading.set(id, p); }
      const ws = await p;
      if (!ws) return null;
      e = live.get(id);
      if (!e) { e = { ws, touched: Date.now(), streams: 0, ends: new Set() }; live.set(id, e); evict(); }
    }
    e.touched = Date.now();
    return e;
  }
  function evict() {
    if (live.size <= maxLive) return;
    const idle = [...live.entries()].filter(([, e]) => e.streams === 0).sort((a, b) => a[1].touched - b[1].touched);
    for (const [id] of idle.slice(0, live.size - maxLive)) live.delete(id);
  }

  // The runtime: advance every recently used workspace. Idle ones freeze (and resume from the DB when visited).
  let ticking = false;
  const timer = setInterval(async () => {
    if (ticking || fenced) return;
    ticking = true;
    const now = Date.now();
    try {
      for (const [id, e] of live) {
        if (e.streams === 0 && now - e.touched > idleMs) { live.delete(id); continue; }
        try { await e.ws.tick(now); } catch (err) { if (err instanceof ConflictError) invalidate(id); onError(err, id); }
      }
    } finally { ticking = false; }
  }, tickMs);
  // Workspaces held in memory are in use (viewed or streaming): never prune them out from under their visitors.
  const prune = (before: number) => store.prune(before, [...live.keys(), ...loading.keys()]);
  const pruneTimer = setInterval(() => { prune(Date.now() - retentionMs).catch((err) => onError(err, 'prune')); }, 10 * 60_000);
  function onError(err: unknown, where: string) {
    if (err instanceof FencedError) { fenced = err.message; console.error(`[watchshift] FENCED, refusing writes: ${err.message}`); return; }
    console.error(`[watchshift] ${where}: ${(err as Error).message}`);
  }

  const send = (res: ServerResponse, code: number, body: unknown, extra: Record<string, string> = {}) => {
    const s = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(code, { ...HEADERS, 'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', 'cache-control': 'no-store', ...extra });
    res.end(s);
  };
  const cookieOf = (req: IncomingMessage) => /(?:^|;\s*)watchshift_ws=([0-9a-f-]{36})/.exec(req.headers.cookie ?? '')?.[1];
  // Client address for rate limits. X-Forwarded-For is client-controlled except for the entries appended by proxies we
  // trust, so only the entry `trustProxyHops` from the right is used (0 = ignore the header, use the socket address).
  const hops = o.trustProxyHops ?? 0;
  const ipOf = (req: IncomingMessage) => {
    const xff = hops > 0 ? String(req.headers['x-forwarded-for'] ?? '').split(',').map((x) => x.trim()).filter(Boolean) : [];
    return (xff.length >= hops ? xff[xff.length - hops] : undefined) || req.socket.remoteAddress || '?';
  };
  const roleOf = (v: unknown): Role => (isRole(v) ? v : 'eng-oncall');
  async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
    if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) throw Object.assign(new Error('content-type must be application/json'), { code: 415 });
    let n = 0; const chunks: Buffer[] = [];
    for await (const c of req) { n += (c as Buffer).length; if (n > 4096) throw Object.assign(new Error('body too large'), { code: 413 }); chunks.push(c as Buffer); }
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw Object.assign(new Error('body must be a JSON object'), { code: 400 });
    return v;
  }
  function sameOrigin(req: IncomingMessage) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  }
  const cookie = (id: string, req: IncomingMessage) =>
    `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(retentionMs / 1000)}${o.secureCookies || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`;

  function toCommand(b: Record<string, unknown>): Command | null {
    const t = b.type;
    if ((t === 'approve' || t === 'deny') && typeof b.approvalId === 'string' && b.approvalId.length < 40)
      return { type: t, approvalId: b.approvalId, bindingHash: typeof b.bindingHash === 'string' ? b.bindingHash : undefined, note: typeof b.note === 'string' ? b.note : undefined };
    if ((t === 'pause' || t === 'resume' || t === 'kill' || t === 'quarantine') && isAgentId(b.agent)) return { type: t, agent: b.agent, reason: typeof b.reason === 'string' ? b.reason : undefined };
    if (t === 'raise_budget' && isAgentId(b.agent) && typeof b.usd === 'number') return { type: t, agent: b.agent, usd: b.usd };
    if (t === 'trigger_rogue' || t === 'stale_retry') return { type: t };
    return null;
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname, ip = ipOf(req);
    if (process.env.WATCHSHIFT_DEBUG_PROXY === '1' && p === '/api/health') { // proxy-chain shape for choosing trustProxyHops; addresses hashed, never logged
      const h = (v: unknown) => (v ? createHash('sha256').update(String(v).trim()).digest('hex').slice(0, 8) : '-');
      console.log(`[watchshift] proxy xff=[${String(req.headers['x-forwarded-for'] ?? '').split(',').map(h).join(',')}] socket=${h(req.socket.remoteAddress)} cf=${h(req.headers['cf-connecting-ip'])} tci=${h(req.headers['true-client-ip'])} xri=${h(req.headers['x-real-ip'])}`);
    }
    if (p === '/api/health') return send(res, fenced ? 503 : 200, { ok: !fenced, store: store.kind, fenced, live: live.size, streams: sse, commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? null });
    if (p.startsWith('/api/')) {
      if (req.method === 'POST' && !sameOrigin(req)) return send(res, 403, { error: 'cross-origin request refused' });
      if (!(req.method === 'POST' ? cmdLimit : readLimit).ok(ip)) return send(res, 429, { error: 'rate limited' }, { 'retry-after': '10' });
      if (fenced && req.method === 'POST') return send(res, 503, { error: 'this instance has been fenced by a newer owner' });
    }
    if (p === '/api/demo/start' && req.method === 'POST') {
      const b = await body(req);
      const cur = b.fresh ? null : await get(cookieOf(req));
      if (cur) return send(res, 200, view(cur.ws.S));
      if (!createLimit.ok(ip)) return send(res, 429, { error: 'too many demo workspaces from this address; try again later' });
      if ((await store.count()) > 5000) await prune(Date.now() - 3600_000);
      const id = randomUUID();
      const ws = await Workspace.create(store, id, Math.floor(Math.random() * 1e9), speed);
      live.set(id, { ws, touched: Date.now(), streams: 0, ends: new Set() });
      evict();
      return send(res, 200, view(ws.S), { 'set-cookie': cookie(id, req) });
    }
    if (!p.startsWith('/api/')) return serveStatic(p, res);
    const e = await get(cookieOf(req));
    if (!e && p === '/api/state') return send(res, 200, { workspace: null });
    if (!e) return send(res, 404, { error: 'no demo workspace for this browser; POST /api/demo/start' });
    const S = e.ws.S;
    if (p === '/api/state') return send(res, 200, view(S));
    if (p === '/api/stream') return stream(req, res, e, Number(url.searchParams.get('after') ?? req.headers['last-event-id'] ?? 0));
    if (p === '/api/command' && req.method === 'POST') {
      const b = await body(req);
      const cmd = toCommand(b);
      if (!cmd) return send(res, 400, { error: 'invalid command' });
      const key = typeof b.key === 'string' && b.key.length <= 64 ? b.key : undefined;
      let r;
      try { r = await e.ws.command(cmd, roleOf(b.as), key); }
      catch (err) {
        // Another writer moved this workspace on: drop the stale copy so the next request reloads from the store.
        if (err instanceof ConflictError) { invalidate(e.ws.S.id); return send(res, 409, { error: 'workspace changed underneath this request; retry' }); }
        throw err;
      }
      return send(res, r.ok ? 200 : (r.code ?? 400), r);
    }
    if (p === '/api/replay') {
      const agent = url.searchParams.get('agent');
      if (!isAgentId(agent)) return send(res, 400, { error: 'agent must be releaseops, supportops or infraops' });
      return send(res, 200, replay(S, agent, Number(url.searchParams.get('n') ?? 10)));
    }
    if (p === '/api/audit') {
      const role = roleOf(url.searchParams.get('as'));
      const x = exportAudit(S, role);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      if (url.searchParams.get('format') === 'csv') {
        res.writeHead(200, { ...HEADERS, 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': `attachment; filename="watchshift-audit-${role}-${stamp}.csv"` });
        return res.end(exportCsv(x));
      }
      return send(res, 200, x, { 'content-disposition': `attachment; filename="watchshift-audit-${role}-${stamp}.json"` });
    }
    return send(res, 404, { error: 'not found' });
  }

  function stream(req: IncomingMessage, res: ServerResponse, e: Entry, after: number) {
    if (e.streams >= 4 || sse >= 400) return send(res, 429, { error: 'too many live streams' });
    e.streams++; sse++;
    res.writeHead(200, { ...HEADERS, 'content-type': 'text/event-stream', 'cache-control': 'no-store, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    // Backpressure: a client that stops reading is disconnected once 1 MiB is queued (it resumes with Last-Event-ID).
    const out = (chunk: string) => { if (res.destroyed) return; if (res.writableLength > 1 << 20) { res.destroy(); return; } res.write(chunk); };
    const write = (evs: Ev[]) => { for (const ev of evs) out(`id: ${ev.seq}\nevent: ev\ndata: ${JSON.stringify(ev)}\n\n`); };
    let pending: ReturnType<typeof setTimeout> | null = null;
    const snapshot = () => { pending = null; out(`event: snapshot\ndata: ${JSON.stringify(view(e.ws.S))}\n\n`); };
    // Catch-up: everything after the client's last seen seq (bounded), then the snapshot. Client de-duplicates by seq.
    const start = Math.max(Number.isFinite(after) ? after : 0, e.ws.S.seq - 400);
    write(e.ws.S.events.filter((x) => x.seq > start));
    snapshot();
    const listener = (evs: Ev[]) => { write(evs); pending ??= setTimeout(snapshot, 200); };
    e.ws.listeners.add(listener);
    const ping = setInterval(() => { out(': ping\n\n'); e.touched = Date.now(); }, 15_000);
    const end = () => res.end();
    e.ends.add(end);
    req.on('close', () => { e.ends.delete(end); e.ws.listeners.delete(listener); clearInterval(ping); if (pending) clearTimeout(pending); e.streams--; sse--; });
  }

  async function serveStatic(p: string, res: ServerResponse) {
    const dir = resolve(o.publicDir ?? 'public');
    let rel: string;
    try { rel = decodeURIComponent(p); } catch { return send(res, 400, 'bad path'); }
    let file = resolve(join(dir, rel));
    if (file !== dir && !file.startsWith(dir + sep)) return send(res, 400, 'bad path');
    try { if (!(await stat(file)).isFile()) throw new Error(); } catch { file = join(dir, 'index.html'); }
    try {
      const data = await readFile(file);
      const ext = extname(file);
      res.writeHead(200, { ...HEADERS, 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': p.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
      res.end(data);
    } catch { send(res, 404, 'UI not built: run npm run build'); }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: Error & { code?: number }) => {
      if (err instanceof FencedError) { onError(err, 'request'); return send(res, 503, { error: 'fenced' }); }
      const code = typeof err.code === 'number' ? err.code : err instanceof SyntaxError ? 400 : 500;
      if (code === 500) console.error('[watchshift] request failed:', err.message);
      if (!res.headersSent) send(res, code, { error: code === 500 ? 'internal error' : err.message });
    });
  });
  return { server, live, close: async () => { clearInterval(timer); clearInterval(pruneTimer); server.closeAllConnections(); await new Promise((r) => server.close(r)); } };
}

// Failure modes the directive names that the other files do not: duplicate/stale/cross-team approvals,
// read-only roles, hostile HTTP payloads, and repeated SSE delivery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fresh, run, evs, pendingFor, testStore } from './helpers.ts';
import { APPROVAL_TTL_MS } from '../src/engine.ts';
import { createApp } from '../src/server.ts';

test('duplicate approvals: a second approve is rejected; a retried idempotency key returns the first result', async () => {
  const { ws, clock } = await fresh();
  await run(ws, clock, () => !!pendingFor(ws, 'releaseops'));
  const ap = pendingFor(ws, 'releaseops')!;
  const cmd = { type: 'approve' as const, approvalId: ap.id, bindingHash: ap.hash };
  const first = await ws.command(cmd, 'eng-oncall', 'k1', clock.now);
  assert.equal(first.ok, true);
  const n = ws.S.seq;
  const retry = await ws.command(cmd, 'eng-oncall', 'k1', clock.now);
  assert.deepEqual(retry.events, first.events);
  assert.equal(ws.S.seq, n, 'retried key appends nothing');
  const second = await ws.command(cmd, 'eng-oncall', 'k2', clock.now);
  assert.equal(second.code, 409);
  assert.equal(evs(ws, 'ApprovalGranted').length, 1);
});

test('stale approvals: expired or wrong-hash approvals never release the action', async () => {
  const { ws, clock } = await fresh();
  await run(ws, clock, () => !!pendingFor(ws, 'releaseops'));
  const ap = pendingFor(ws, 'releaseops')!;
  assert.equal((await ws.command({ type: 'approve', approvalId: ap.id, bindingHash: 'f'.repeat(64) }, 'eng-oncall', undefined, clock.now)).code, 409);
  assert.equal((await ws.command({ type: 'approve', approvalId: ap.id }, 'eng-oncall', undefined, clock.now)).code, 409);
  const late = await ws.command({ type: 'approve', approvalId: ap.id, bindingHash: ap.hash }, 'eng-oncall', undefined, ap.expiresAt + 1);
  assert.equal(late.code, 409);
  assert.match(late.error!, /expired/);
  assert.equal(evs(ws, 'ApprovalGranted').length, 0);
  assert.equal(ap.expiresAt - ap.requestedAt, APPROVAL_TTL_MS);
});

test('cross-team and read-only operators are refused in the backend and the refusal is audited', async () => {
  const { ws, clock } = await fresh();
  await run(ws, clock, () => !!pendingFor(ws, 'releaseops'));
  const ap = pendingFor(ws, 'releaseops')!;
  const cx = await ws.command({ type: 'approve', approvalId: ap.id, bindingHash: ap.hash }, 'cx-lead', undefined, clock.now);
  assert.equal(cx.code, 403);
  assert.equal((await ws.command({ type: 'kill', agent: 'releaseops' }, 'cx-lead', undefined, clock.now)).code, 403);
  assert.equal((await ws.command({ type: 'pause', agent: 'supportops' }, 'auditor', undefined, clock.now)).code, 403);
  assert.equal((await ws.command({ type: 'trigger_rogue' }, 'auditor', undefined, clock.now)).code, 403);
  assert.equal(evs(ws, 'AccessDenied').length, 4);
  assert.equal(ws.S.agents.releaseops.status, 'WAITING_APPROVAL');
  assert.equal(ap.status, 'pending');
});

async function server() {
  const dir = mkdtempSync(join(tmpdir(), 'watchshift-pub-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>t</title>');
  const store = await testStore();
  await store.claim('http-test');
  const app = createApp({ store, tickMs: 50, speed: 20, publicDir: dir });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const start = await fetch(`${base}/api/demo/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const cookie = start.headers.get('set-cookie')!.split(';')[0];
  const post = (body: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/command`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, ...headers }, body });
  return { app, base, cookie, post };
}

test('hostile HTTP input: origin, content-type, size, JSON shape, unknown commands, path traversal', async () => {
  const { app, base, cookie, post } = await server();
  try {
    assert.equal((await post('{"type":"kill","agent":"releaseops"}', { origin: 'https://evil.example' })).status, 403);
    assert.equal((await post('{"type":"kill","agent":"releaseops"}', { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await post(JSON.stringify({ type: 'pause', agent: 'releaseops', reason: 'x'.repeat(5000) }))).status, 413);
    assert.equal((await post('{not json')).status, 400);
    assert.equal((await post('[1,2]')).status, 400);
    assert.equal((await post('{"type":"drop_tables"}')).status, 400);
    assert.equal((await post('{"type":"pause","agent":"__proto__"}')).status, 400);
    assert.equal((await post('{"type":"raise_budget","agent":"infraops","usd":1e9}')).status, 400);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    const xss = await post(JSON.stringify({ type: 'pause', agent: 'releaseops', reason: '<img src=x onerror=alert(1)>' }));
    assert.equal(xss.status, 200);
    const state = await (await fetch(`${base}/api/state`, { headers: { cookie } })).json();
    assert.equal(state.agents.find((a: { id: string }) => a.id === 'releaseops').status, 'PAUSED');
    for (const p of ['/%2e%2e/package.json', '/..%2f..%2fpackage.json', '/%E0%A4%A']) {
      const r = await fetch(base + p);
      assert.ok(r.status === 400 || !(await r.text()).includes('"watchshift"'), `${p} must not leak files`);
    }
    const h = (await fetch(`${base}/api/health`)).headers;
    assert.match(h.get('content-security-policy')!, /default-src 'self'/);
    assert.equal(h.get('x-frame-options'), 'DENY');
    assert.equal((await fetch(`${base}/api/command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"type":"trigger_rogue"}' })).status, 404);
  } finally { await app.close(); }
});

test('rate limits cannot be dodged by forging X-Forwarded-For', async () => {
  const { app, post } = await server();
  try {
    const codes: number[] = [];
    for (let i = 0; i < 50; i++) codes.push((await post('{"type":"drop_tables"}', { 'x-forwarded-for': `10.9.${i}.1` })).status);
    assert.ok(codes.includes(429), 'forged addresses must share the real client bucket');
  } finally { await app.close(); }
});

test('repeated SSE delivery: reconnecting with Last-Event-ID resumes after it, with no duplicate or missing seq', async () => {
  const { app, base, cookie } = await server();
  try {
    const read = async (after: number, ms: number) => {
      const ac = new AbortController();
      const r = await fetch(`${base}/api/stream`, { headers: { cookie, 'last-event-id': String(after) }, signal: ac.signal });
      const dec = new TextDecoder(); let buf = '';
      const t = setTimeout(() => ac.abort(), ms);
      try { for await (const c of r.body!) buf += dec.decode(c as Uint8Array, { stream: true }); } catch { /* aborted */ }
      clearTimeout(t);
      return [...buf.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    };
    const a = await read(0, 600);
    assert.ok(a.length > 3, 'first connection receives events');
    const last = a[a.length - 1];
    const b = await read(last, 600);
    assert.ok(b.every((s) => s > last), 'resumed stream skips what the client has');
    const all = [...a, ...b];
    assert.equal(new Set(all).size, all.length, 'no duplicates');
    for (let i = 1; i < all.length; i++) assert.equal(all[i], all[i - 1] + 1, 'no gaps');
  } finally { await app.close(); }
});

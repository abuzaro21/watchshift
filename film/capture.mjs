// Captures REAL footage of the current WATCHSHIFT build for the film: one continuous browser session on a local server
// (in-memory SQLite), driven only by the clicks below. A small dot marks the pointer so viewers can follow clicks.
// Output: film/out/raw/session.webm + session.json (seconds at which each scene starts) + verify.json (real
// verify-audit result on the exported file).
// Usage: npm run build && node film/capture.mjs
import { chromium } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync, rmSync } from 'node:fs';

const F = (p) => new URL(p, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const PORT = 3410, OUT = F('./out/raw/');
mkdirSync(OUT, { recursive: true });
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.ts'], {
  env: { ...process.env, PORT: String(PORT), WATCHSHIFT_SPEED: '1.5', WATCHSHIFT_TICK_MS: '120', WATCHSHIFT_DB: ':memory:' }, stdio: 'inherit',
});
for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }

const POINTER = `addEventListener('DOMContentLoaded', () => {
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;z-index:99999;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;border:2px solid #ffb547;background:#ffb54733;pointer-events:none;transition:transform .12s;left:-50px;top:-50px';
  document.body.appendChild(d);
  addEventListener('mousemove', (e) => { d.style.left = e.clientX + 'px'; d.style.top = e.clientY + 'px'; }, true);
  addEventListener('mousedown', () => { d.style.transform = 'scale(.6)'; }, true);
  addEventListener('mouseup', () => { d.style.transform = 'scale(1)'; }, true);
});`;

const browser = await chromium.launch();
const tmp = F('./out/raw/tmp/');
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, acceptDownloads: true, recordVideo: { dir: tmp, size: { width: 1920, height: 1080 } } });
await ctx.addInitScript(POINTER);
const page = await ctx.newPage();
const t0 = Date.now(), marks = {};
const mark = (k) => { marks[k] = (Date.now() - t0) / 1000; console.log(`${k} @ ${marks[k].toFixed(1)}s`); };
const wait = (ms) => page.waitForTimeout(ms);
const press = async (loc) => { await loc.scrollIntoViewIfNeeded(); await loc.hover(); await wait(700); await loc.click(); };
const card = (name) => page.getByRole('article', { name: new RegExp(`^${name},`) });

try {
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await wait(1500);
  await press(page.getByRole('button', { name: /start live demo/i }));
  mark('fleet');
  await wait(13_000);

  mark('approval');
  const approve = page.getByRole('region', { name: 'Approval queue' }).locator('.approval').filter({ hasText: 'ReleaseOps' }).getByRole('button', { name: 'Approve' });
  await approve.waitFor();
  await approve.hover();
  await wait(8_000);
  await approve.click();
  await wait(4_000);

  mark('pause');
  await press(card('ReleaseOps').getByRole('button', { name: 'Pause' }));
  await wait(3_500);
  await press(card('ReleaseOps').getByRole('button', { name: 'Resume' }));
  await wait(4_500);

  mark('rogue');
  await press(page.getByRole('button', { name: 'Trigger rogue agent' }));
  await wait(1_200);
  await press(page.getByRole('alertdialog').getByRole('button', { name: 'Trigger rogue agent' }));
  await page.getByRole('alert', { name: 'Rogue agent contained' }).waitFor({ timeout: 30_000 });
  await wait(15_000);

  mark('kill');
  const banner = page.getByRole('alert', { name: 'Rogue agent contained' });
  await press(banner.getByRole('button', { name: 'Kill InfraOps' }));
  await wait(1_200);
  await press(page.getByRole('alertdialog').getByRole('button', { name: 'Kill InfraOps' }));
  await wait(3_500);
  await press(banner.getByRole('button', { name: /stale worker retries/ }));
  await wait(7_000);

  mark('replay');
  await press(banner.getByRole('button', { name: 'Replay incident' }));
  await wait(5_000);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('ArrowLeft'); await wait(1_600); }
  await wait(3_000);
  await page.keyboard.press('Escape');
  const [dl] = await Promise.all([page.waitForEvent('download'), press(page.getByRole('link', { name: 'Export audit JSON' }))]);
  const file = F('./out/raw/audit.json');
  await dl.saveAs(file);
  await wait(3_000);
  mark('end');
  const verify = JSON.parse(execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/verify-audit.ts', file], { encoding: 'utf8' }));
  writeFileSync(F('./out/raw/verify.json'), JSON.stringify({ ...verify, file: 'watchshift-audit-eng-oncall.json' }, null, 2));
} finally {
  const video = page.video();
  await ctx.close();
  renameSync(await video.path(), F('./out/raw/session.webm'));
  rmSync(tmp, { recursive: true, force: true });
  writeFileSync(F('./out/raw/session.json'), JSON.stringify(marks, null, 2));
  await browser.close();
  server.kill();
}

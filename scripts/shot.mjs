// Screenshot helper: node scripts/shot.mjs <baseUrl> <outDir>
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const base = process.argv[2] ?? 'http://127.0.0.1:3000';
const out = process.argv[3] ?? 'docs/evidence/screens';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const errors = [];
for (const [name, vp] of [['desktop', { width: 1920, height: 1080 }], ['mobile', { width: 390, height: 844 }]]) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('response', (r) => r.status() >= 400 && errors.push(`${name} ${r.status()} ${r.url()}`));
  await page.goto(base);
  await page.screenshot({ path: `${out}/${name}-0-landing.png`, fullPage: true });
  await page.getByRole('button', { name: /start live demo/i }).click();
  await page.waitForTimeout(9000);
  await page.screenshot({ path: `${out}/${name}-1-running.png`, fullPage: name === 'mobile' });
  const trig = page.getByRole('button', { name: /trigger rogue/i });
  for (let i = 0; i < 20 && !(await trig.isEnabled()); i++) await page.waitForTimeout(500);
  await trig.click();
  const ok = page.getByRole('alertdialog').getByRole('button', { name: /trigger/i });
  if (await ok.count()) await ok.first().click();
  await page.waitForTimeout(6000);
  await page.screenshot({ path: `${out}/${name}-2-rogue.png`, fullPage: name === 'mobile' });
  await ctx.close();
}
await browser.close();
console.log(errors.length ? errors.join('\n') : 'no page errors');

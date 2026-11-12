// Renders the brand ending frame by frame from the real vector mark (ui/public/watchshift.svg geometry): the bezel
// draws on, the sweep hand turns and settles, the wordmark and tagline reveal, then the composition holds.
// Animations are CSS, paused and stepped to exact times, so every frame is deterministic.
// Output: film/out/logo/%04d.png (30 fps) -> encoded by build.mjs. Usage: node film/logo.mjs [seconds]
import { chromium } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';

const F = (p) => new URL(p, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SECONDS = Number(process.argv[2] ?? 9), FPS = 30, DIR = F('./out/logo/');
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });

const html = `<!doctype html><style>
*{margin:0;box-sizing:border-box}
body{width:1920px;height:1080px;background:radial-gradient(1100px 700px at 50% 30%,#10203a 0%,#060a11 70%);display:grid;place-items:center;font-family:'Segoe UI',system-ui,sans-serif;color:#dbe4f0;overflow:hidden}
.c{text-align:center}
svg{width:260px;height:260px;overflow:visible}
.bz{stroke-dasharray:160;stroke-dashoffset:160;animation:draw 1.4s cubic-bezier(.6,.05,.2,1) .2s forwards}
.in{stroke-dasharray:110;stroke-dashoffset:110;animation:draw 1.2s cubic-bezier(.6,.05,.2,1) .7s forwards}
.hand{transform-origin:32px 32px;transform:rotate(-200deg);opacity:0;animation:hand 1.9s cubic-bezier(.2,.8,.2,1) 1.1s forwards}
.dot{opacity:0;animation:fade .3s ease-out 1.1s forwards}
.glow{opacity:0;animation:glow 2.4s ease-out 2.6s forwards}
.w{font-size:118px;font-weight:700;letter-spacing:.5em;margin:34px 0 0 .16em;opacity:0;animation:word 1.3s cubic-bezier(.2,.8,.2,1) 2.3s forwards}
.t{font-size:44px;color:#ffb547;margin-top:18px;opacity:0;transform:translateY(14px);animation:rise .9s ease-out 3.3s forwards}
.d{position:fixed;left:0;right:0;bottom:44px;text-align:center;font-size:21px;color:#56657b;opacity:0;animation:fade .8s ease-out 4.6s forwards}
.u{font-size:28px;color:#7d8ca3;margin-top:46px;font-family:Consolas,monospace;opacity:0;animation:fade .8s ease-out 4.1s forwards}
@keyframes draw{to{stroke-dashoffset:0}}
@keyframes hand{0%{opacity:0}15%{opacity:1}100%{transform:rotate(0deg);opacity:1}}
@keyframes fade{to{opacity:1}}
@keyframes glow{0%{opacity:0}35%{opacity:.9}100%{opacity:.35}}
@keyframes word{from{opacity:0;letter-spacing:.5em}to{opacity:1;letter-spacing:.16em}}
@keyframes rise{to{opacity:1;transform:none}}
</style><div class="c">
<svg viewBox="0 0 64 64" aria-label="WATCHSHIFT">
  <defs><filter id="g" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.4"/></filter></defs>
  <path class="glow" d="M32 7 53.6 19.5v25L32 57 10.4 44.5v-25Z" fill="none" stroke="#ffb547" stroke-width="3.2" filter="url(#g)"/>
  <path class="bz" pathLength="160" d="M32 7 53.6 19.5v25L32 57 10.4 44.5v-25Z" fill="none" stroke="#ffb547" stroke-width="3.2" stroke-linejoin="round"/>
  <path class="in" pathLength="110" d="M32 15.5 46.3 23.75v16.5L32 48.5 17.7 40.25v-16.5Z" fill="none" stroke="#ffb547" stroke-opacity=".35" stroke-width="1.6" stroke-linejoin="round"/>
  <path class="hand" d="M32 32 44 21" stroke="#ffb547" stroke-width="3.2" stroke-linecap="round"/>
  <circle class="dot" cx="32" cy="32" r="3.6" fill="#ffb547"/>
</svg>
<div class="w">WATCHSHIFT</div><div class="t">Agents act. Humans hold the watch.</div><div class="u">github.com/abuzaro21/watchshift</div></div><div class="d">Real captures of the running build · simulated company and tokens · synthetic narration (Kokoro-82M)</div>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.setContent(html);
await page.evaluate(() => document.getAnimations().forEach((a) => a.pause()));
const n = Math.round(SECONDS * FPS);
for (let i = 0; i < n; i++) {
  await page.evaluate((ms) => document.getAnimations().forEach((a) => { a.currentTime = ms; }), (i * 1000) / FPS);
  await page.screenshot({ path: `${DIR}${String(i).padStart(4, '0')}.png` });
}
await browser.close();
console.log(`logo: ${n} frames`);

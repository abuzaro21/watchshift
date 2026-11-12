// Builds the ~90 s WATCHSHIFT film from the REAL capture (film/capture.mjs) and the synthetic narration (film/tts.py).
// Editing is cuts and restrained crops of one continuous session; no UI is faked and no footage is sped up.
// Title, verification and end cards are HTML rendered by Playwright; the verification card shows the real
// verify-audit result on the file exported during the capture.
// Output: film/out/watchshift-film.mp4 (1920x1080, 30 fps, H.264 + AAC, soft subtitles) and film/watchshift-film.srt
// Usage: node film/capture.mjs && <python> film/tts.py && node film/build.mjs
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';

const F = (p) => new URL(p, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const OUT = F('./out/'), TMP = F('./out/build/');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const W = 1920, H = 1080, FPS = 30, LEAD = 0.35, TAIL = 0.55;
const json = (p) => JSON.parse(readFileSync(F(p), 'utf8'));
const voice = json('./out/audio/durations.json');
const text = Object.fromEntries(json('./narration.json').map((n) => [n.id, n.text]));
const marks = json('./out/raw/session.json');
const verify = json('./out/raw/verify.json');
const ff = (...args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' });
const ENC = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-an'];

// ------------------------------------------------------------------ cards (HTML -> PNG)
const css = `*{margin:0;box-sizing:border-box}body{width:${W}px;height:${H}px;background:radial-gradient(1200px 700px at 70% -10%,#10203a,#060a11 65%);color:#dbe4f0;font-family:'Segoe UI',system-ui,sans-serif;display:grid;place-items:center}
.c{text-align:center}.w{font-size:120px;font-weight:700;letter-spacing:.16em;margin-top:28px}.t{color:#ffb547;font-size:46px;margin-top:14px}
.s{color:#7d8ca3;font-size:28px;margin-top:40px}.m{font-family:Consolas,monospace}
.term{width:1300px;background:#0a1019;border:1px solid #24344a;border-radius:16px;padding:44px 52px;text-align:left;font-family:Consolas,monospace;font-size:30px;line-height:1.55}
.term .p{color:#7d8ca3}.ok{color:#3ddc97}.k{color:#5aa9ff}`;
const cards = {
  verify: `<div class="term"><div class="p">$ npm run verify-audit -- ${verify.file}</div><br>{<br>&nbsp;&nbsp;<span class="k">"ok"</span>: <span class="ok">${verify.ok}</span>,<br>&nbsp;&nbsp;<span class="k">"checked"</span>: ${verify.checked},<br>&nbsp;&nbsp;<span class="k">"head"</span>: "${verify.head.slice(0, 24)}…",<br>&nbsp;&nbsp;<span class="k">"redacted"</span>: ${verify.redacted} <span class="p">// other team's events: hash only</span><br>}<br><br><span class="p">exported during this capture · verified offline · every event hash recomputed</span></div>`,
};
const browser = await chromium.launch();
const pg = await browser.newPage({ viewport: { width: W, height: H } });
for (const [k, body] of Object.entries(cards)) {
  await pg.setContent(`<!doctype html><style>${css}</style>${body}`);
  await pg.screenshot({ path: `${TMP}card-${k}.png` });
}
await browser.close();

// ------------------------------------------------------------------ edit decision list
// box = [x, y, width] crop of the 1920x1080 capture (16:9), scaled back to full frame.
const VERIFY_LEN = 5.0;
const shots = [
  { id: 'title', clip: 0.3, box: [0, 0, 1920], voice: 'title', noOut: true },
  { id: 'fleet', clip: 'continue', box: [0, 0, 1920], voice: 'fleet', noIn: true },
  { id: 'approval', clip: marks.approval, box: [0, 0, 1530], voice: 'approval' },
  { id: 'pause', clip: marks.pause - 0.3, box: [0, 0, 1530], voice: 'pause' },
  { id: 'rogue', clip: marks.rogue, box: [0, 0, 1920], voice: 'rogue' },
  { id: 'kill', clip: marks.kill, box: [0, 0, 1700], voice: 'kill' },
  { id: 'replay', clip: marks.replay + 0.8, box: [210, 90, 1500], voice: 'replay', cut: VERIFY_LEN },
  { id: 'verify', card: 'verify', len: VERIFY_LEN },
  { id: 'end', logo: true, voice: 'end', len: +(voice.end + LEAD + 3.4).toFixed(2) },
];
let t = 0, prevEnd = 0;
const timeline = [], segs = [];
for (const s of shots) {
  const len = s.len ?? +(voice[s.voice] + LEAD + TAIL - (s.cut ?? 0)).toFixed(3);
  const out = `${TMP}${String(segs.length).padStart(2, '0')}-${s.id}.mp4`;
  const fade = [s.noIn ? '' : 'fade=t=in:st=0:d=0.25', s.noOut ? '' : `fade=t=out:st=${(len - 0.25).toFixed(2)}:d=0.25`].filter(Boolean).join(',') || 'null';
  if (s.clip === 'continue') s.clip = prevEnd;
  if (typeof s.clip === 'number') prevEnd = s.clip + len;
  if (s.logo) {
    execFileSync(process.execPath, [F('./logo.mjs'), String(len)], { stdio: 'inherit' });
    ff('-framerate', String(FPS), '-i', F('./out/logo/%04d.png'), '-vf', `fade=t=in:st=0:d=0.4`, ...ENC, out);
  } else if (s.card) ff('-loop', '1', '-framerate', String(FPS), '-t', String(len), '-i', `${TMP}card-${s.card}.png`, '-vf', `scale=${W}:${H},${fade}`, ...ENC, out);
  else {
    const [x, y, w] = s.box, h = Math.round((w * 9) / 16);
    ff('-ss', s.clip.toFixed(2), '-t', String(len), '-i', F('./out/raw/session.webm'), '-vf', `fps=${FPS},crop=${w}:${h}:${x}:${y},scale=${W}:${H}:flags=lanczos,tpad=stop_mode=clone:stop_duration=2,trim=duration=${len},${fade}`, ...ENC, out);
  }
  if (s.voice) timeline.push({ id: s.voice, at: t + LEAD });
  segs.push(out);
  t += len;
}
const total = +t.toFixed(3);
writeFileSync(`${TMP}list.txt`, segs.map((p) => `file '${p}'`).join('\n'));
ff('-f', 'concat', '-safe', '0', '-i', `${TMP}list.txt`, '-c', 'copy', `${TMP}video.mp4`);

// ------------------------------------------------------------------ narration track + captions
const inputs = timeline.flatMap((v) => ['-i', F(`./out/audio/${v.id}.wav`)]);
const delays = timeline.map((v, i) => `[${i}]aresample=48000,adelay=${Math.round(v.at * 1000)}|${Math.round(v.at * 1000)}[a${i}]`).join(';');
// Original music bed, synthesised here: a low A-minor drone with slow movement, kept well under the voice.
const bed = `aevalsrc='0.5*sin(2*PI*55*t)*(0.7+0.3*sin(2*PI*0.07*t))+0.35*sin(2*PI*82.41*t)*(0.6+0.4*sin(2*PI*0.05*t+1))+0.25*sin(2*PI*130.81*t)*(0.5+0.5*sin(2*PI*0.11*t+2))':s=48000:d=${total},lowpass=f=700,volume=0.055,afade=t=in:d=2,afade=t=out:st=${(total - 3).toFixed(2)}:d=3[bed]`;
const mix = `${delays};${bed};${timeline.map((_, i) => `[a${i}]`).join('')}[bed]amix=inputs=${timeline.length + 1}:normalize=0,apad=whole_dur=${total},loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[a]`;
ff(...inputs, '-filter_complex', mix, '-map', '[a]', '-t', String(total), '-ac', '2', '-c:a', 'pcm_s16le', `${TMP}voice.wav`);

const ts = (s) => { const ms = Math.round(s * 1000); const p = (n, l = 2) => String(n).padStart(l, '0'); return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`; };
const cues = [];
for (const v of timeline) {
  const parts = text[v.id].match(/[^.!?]+[.!?]+/g).map((x) => x.trim());
  const chars = parts.reduce((n, p) => n + p.length, 0);
  let at = v.at;
  for (const p of parts) {
    const d = (voice[v.id] * p.length) / chars;
    const lines = p.length > 46 ? (() => { const mid = p.lastIndexOf(' ', Math.ceil(p.length / 2) + 6); return `${p.slice(0, mid)}\n${p.slice(mid + 1)}`; })() : p;
    cues.push(`${cues.length + 1}\n${ts(at)} --> ${ts(at + d - 0.05)}\n${lines}\n`);
    at += d;
  }
}
const srt = F('./watchshift-film.srt');
writeFileSync(srt, cues.join('\n'));

const final = `${OUT}watchshift-film.mp4`;
ff('-i', `${TMP}video.mp4`, '-i', `${TMP}voice.wav`, '-i', srt, '-map', '0:v', '-map', '1:a', '-map', '2:s', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
  '-c:s', 'mov_text', '-metadata:s:s:0', 'language=eng', '-movflags', '+faststart', '-shortest', final);
writeFileSync(F('./out/edl.json'), JSON.stringify({ total, shots: shots.map((s) => ({ id: s.id, clip: s.clip ?? null, box: s.box ?? null })), timeline }, null, 2));
console.log(`built ${final} (${total.toFixed(1)} s)`);

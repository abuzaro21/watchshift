// Automated checks for the rendered film. Writes film/out/check/report.json and the contact sheet; exits 1 on failure.
// Usage: node film/check.mjs
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const F = (p) => new URL(p, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const MP4 = F('./out/watchshift-film.mp4'), DIR = F('./out/check/');
mkdirSync(DIR, { recursive: true });
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
const ffLog = (args) => spawnSync('ffmpeg', ['-hide_banner', ...args], { encoding: 'utf8', maxBuffer: 64 << 20 }).stderr;

const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-count_frames', '-of', 'json', MP4]));
const v = probe.streams.find((s) => s.codec_type === 'video'), a = probe.streams.find((s) => s.codec_type === 'audio'), sub = probe.streams.find((s) => s.codec_type === 'subtitle');
const duration = Number(probe.format.duration);
const [fn, fd] = v.r_frame_rate.split('/').map(Number);

const black = [...ffLog(['-i', MP4, '-vf', 'blackdetect=d=0.4:pix_th=0.06', '-an', '-f', 'null', '-']).matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
const astats = ffLog(['-i', MP4, '-vn', '-af', 'astats=metadata=0', '-f', 'null', '-']);
const peak = Math.max(...[...astats.matchAll(/Peak level dB: (-?[\d.inf]+)/g)].map((m) => Number(m[1])).filter(Number.isFinite));
const ebur = ffLog(['-i', MP4, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-']);
const lufs = Number(/I:\s+(-?[\d.]+) LUFS/.exec(ebur.slice(ebur.lastIndexOf('Summary')))?.[1]);
const truePeak = Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(ebur.slice(ebur.lastIndexOf('Summary')))?.[1]);
const silences = [...ffLog(['-i', MP4, '-vn', '-af', 'silencedetect=n=-45dB:d=2.5', '-f', 'null', '-']).matchAll(/silence_start: ([\d.]+)[\s\S]*?silence_end: ([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);

// captions: monotonic, inside the film, each starting while narration is audible
const srt = readFileSync(F('./watchshift-film.srt'), 'utf8').trim().split(/\r?\n\r?\n/).map((b) => {
  const [, tl, ...txt] = b.split(/\r?\n/);
  const s = (x) => { const [h, m, r] = x.split(':'); const [sec, ms] = r.split(','); return +h * 3600 + +m * 60 + +sec + +ms / 1000; };
  const [from, to] = tl.split(' --> ').map(s);
  return { from, to, text: txt.join(' ') };
});
const capOk = srt.every((c, i) => c.to > c.from && c.to <= duration + 0.01 && (i === 0 || c.from >= srt[i - 1].to - 0.001));
const capInSilence = srt.filter((c) => silences.some(([s, e]) => c.from > s + 0.3 && c.to < e - 0.3)).map((c) => c.text);

// ending: last frame shows the logo composition (bright amber pixels present, not black), and the last 2 s are stable
const frame = (t, out) => run('ffmpeg', ['-v', 'error', '-y', '-ss', String(t), '-i', MP4, '-frames:v', '1', out]);
frame(duration - 0.1, `${DIR}last.png`);
const sig = (t) => run('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', MP4, '-frames:v', '1', '-vf', 'scale=64:36,format=gray', '-f', 'rawvideo', '-']);
const lum = (buf) => [...Buffer.from(buf, 'latin1')].reduce((s, x) => s + x, 0) / buf.length;
const sA = sig(duration - 2.0), sB = sig(duration - 0.1);
const endDiff = [...Buffer.from(sA, 'latin1')].reduce((s, x, i) => s + Math.abs(x - Buffer.from(sB, 'latin1')[i]), 0) / sA.length;
const satmax = Number(/SATMAX=([\d.]+)/.exec(run('ffprobe', ['-v', 'error', '-f', 'lavfi', '-i', `movie=${DIR.replace(/:/g, '\\:')}last.png,signalstats`, '-show_entries', 'frame_tags=lavfi.signalstats.SATMAX', '-of', 'default=nw=1']))?.[1] ?? 0);

// contact sheet: 12 evenly spaced frames
const n = 12;
for (let i = 0; i < n; i++) frame(((i + 0.5) * duration) / n, `${DIR}cs-${String(i).padStart(2, '0')}.png`);
run('ffmpeg', ['-v', 'error', '-y', '-framerate', '1', '-i', `${DIR}cs-%02d.png`, '-vf', 'scale=480:-1,tile=4x3:padding=6:color=0x060a11', '-frames:v', '1', F('./contact-sheet.png')]);

const checks = {
  duration: { value: +duration.toFixed(2), ok: duration >= 85 && duration <= 92 },
  resolution: { value: `${v.width}x${v.height}`, ok: v.width === 1920 && v.height === 1080 },
  fps: { value: fn / fd, ok: fn / fd === 30 },
  frames: { value: Number(v.nb_read_frames), ok: Math.abs(Number(v.nb_read_frames) - duration * 30) <= 3 },
  codecs: { value: `${v.codec_name}/${v.pix_fmt} + ${a?.codec_name} ${a?.sample_rate}Hz ${a?.channels}ch + ${sub?.codec_name ?? 'no subtitles'}`, ok: v.codec_name === 'h264' && v.pix_fmt === 'yuv420p' && a?.codec_name === 'aac' && !!sub },
  blackFrames: { value: black, ok: black.every(([s, e]) => e - s < 0.6) },
  audioClipping: { value: { samplePeakDb: peak, truePeakDbtp: truePeak }, ok: peak < -0.5 && truePeak <= -1.0 },
  loudness: { value: lufs, ok: lufs >= -18 && lufs <= -14 },
  captions: { value: { cues: srt.length, lastEnd: srt.at(-1).to, inSilence: capInSilence }, ok: capOk && capInSilence.length === 0 },
  endingLogoVisible: { value: { saturationMax: satmax }, ok: satmax > 100 },
  endingStable: { value: { meanAbsDiffLast2s: +endDiff.toFixed(2), lastFrameLuma: +lum(sB).toFixed(1) }, ok: endDiff < 2 && lum(sB) > 8 },
};
const ok = Object.values(checks).every((c) => c.ok);
writeFileSync(`${DIR}report.json`, JSON.stringify({ file: 'film/out/watchshift-film.mp4', ok, checks, note: 'Automated checks only; no human listening review is claimed.' }, null, 2));
for (const [k, c] of Object.entries(checks)) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${k}: ${JSON.stringify(c.value)}`);
process.exit(ok ? 0 : 1);

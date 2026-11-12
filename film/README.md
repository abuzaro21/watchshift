# WATCHSHIFT film (90 s)

Every frame of the product is a real capture of the running build (Playwright `recordVideo`, 1920×1080). The company,
customers and token counts are simulated; the narration is synthetic (Kokoro-82M, voice `am_michael`). The end card says so.

- Output: `film/out/watchshift-film.mp4` (not committed; published as a release asset)
- Captions: [`watchshift-film.srt`](watchshift-film.srt) (also muxed as a soft `mov_text` track)
- Contact sheet: [`contact-sheet.png`](contact-sheet.png) (12 evenly spaced frames)
- Automated check report: [`../docs/evidence/film-check.json`](../docs/evidence/film-check.json)

## Storyboard

Scene length = narration + 0.3 s lead + 0.4 s tail, so the picture is paced to the voice, not the other way round.

| Time (s) | Scene | Picture (real capture unless noted) | Narration |
|---|---|---|---|
| 0.0–5.3 | Problem | Cockpit opening; three agents start | "Three AI agents are at work. Who is actually in control?" |
| 5.3–20.9 | Fleet | Fleet cards, live execution stream, spend panel | The three agents and their jobs; every step is a proposal |
| 20.9–33.1 | Approval | Operator approves the ReleaseOps canary card (tool, params, evidence, rule) | Consent bound to this action only |
| 33.1–40.4 | Pause | Pause SupportOps: pending approval revoked; resume re-plans | Pause revokes, resume revalidates |
| 40.4–57.1 | Rogue | Rogue trigger: export blocked, banner, auto-quarantine, 12,408 vs 0 counterfactual | Poisoned runbook; blocked before any effect |
| 57.1–65.5 | Kill | Kill InfraOps; stale worker retry refused by the commit gate | Epoch fencing |
| 65.5–75.0 | Replay | Replay inspector over the persisted log | Proposal, policy, cost, intervention |
| 75.0–80.0 | Verify | Card (rendered) showing the real `verify-audit` result of the export taken during this capture | Audit export verifies offline |
| 80.0–89.9 | Brand | Animated logo (rendered from the product's SVG mark), tagline, repo URL, disclosure line | "WATCHSHIFT. The agent can think anything. It can only do what the control plane allows." |

## Audio report (automated measurements, `node film/check.mjs`)

- Voice: Kokoro-82M (Apache-2.0, local), 24 kHz mono, speed 1.05; 8 segments, 81.3 s of speech.
- Bed: synthesized low drone (`aevalsrc`, three sines, low-passed), fade in 2 s / out 3 s, mixed well under the voice.
- Master: `loudnorm I=-16 TP=-1.5 LRA=11`, AAC 48 kHz stereo.
- Measured: integrated loudness -17.2 LUFS, sample peak -4.25 dBFS, true peak -4.2 dBTP (no clipping);
  21 caption cues, none placed in a silence; ending frame matches the logo master (mean abs diff 0.5) and is stable.
- These are machine measurements only. No human listening review is claimed.

## Rendering instructions

Requirements: Node 24, ffmpeg/ffprobe on PATH, Playwright Chromium (`npx playwright install chromium`),
Python 3.11+ with `pip install "kokoro>=0.9.4" soundfile` (first run downloads the Kokoro weights).

```bash
npm ci && npm run build           # the capture serves the built UI
python film/tts.py                # narration -> film/out/audio/*.wav + durations.json
node film/capture.mjs             # paced real capture -> film/out/raw/ (+ audit export and verify.json)
node film/logo.mjs                # deterministic logo frames -> film/out/logo/
node film/build.mjs               # crops, cards, mix, captions -> film/out/watchshift-film.mp4 + film/watchshift-film.srt
node film/check.mjs               # automated checks -> film/out/check/report.json + film/contact-sheet.png (exit 1 on failure)
```

Captures run against an in-memory database on port 3410 at 1.5× simulation speed, so they never touch other data.

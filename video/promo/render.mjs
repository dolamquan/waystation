// Frame-accurate render of vid2's promo composition to MP4.
// The comp exposes window.__ready (Promise), window.__seek(t) -> Promise and window.__duration.
//   node video/promo/render.mjs                    full render -> out/waystation-promo.mp4 (+ mix.wav muxed)
//   node video/promo/render.mjs --times 1,3,7.5    stills -> out/check/t<sec>.png + a contact sheet
//   node video/promo/render.mjs --preview          every frame at 960x540, quick MP4 for look checks
// Sources are copied in first (comp from vid2, mix.wav from vid1) so this branch is self-contained.
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire('C:/Users/jackd/AppData/Local/agent-tower/teams/55d58c/recorder/Agent_Inspection/package.json');
const { chromium } = require('playwright-core');
const HERE = dirname(fileURLToPath(import.meta.url));
const TEAM = join(HERE, '..', '..', '..');
const SRC_COMP = join(TEAM, 'vid2', 'video', 'promo', 'comp');
const SRC_MIX = join(TEAM, 'vid1', 'video', 'promo', 'audio', 'mix.wav');
const COMP = join(HERE, 'comp');
const MIX = join(HERE, 'audio', 'mix.wav');
const OUT = join(HERE, 'out');
const FPS = 30;

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] ?? true; };
const times = opt('--times');
const preview = args.includes('--preview');
const noCopy = args.includes('--no-copy');

if (!noCopy) {
  if (!existsSync(SRC_COMP)) throw new Error(`composition not found: ${SRC_COMP}`);
  rmSync(COMP, { recursive: true, force: true });
  cpSync(SRC_COMP, COMP, { recursive: true });
  if (existsSync(SRC_MIX)) { mkdirSync(dirname(MIX), { recursive: true }); cpSync(SRC_MIX, MIX); }
}
mkdirSync(OUT, { recursive: true });

const scale = preview ? 0.5 : 1;
const browser = await chromium.launch({ channel: 'chrome', args: ['--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: scale });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
// Serve the comp over local HTTP so its fetch() of manifests/assets behaves exactly as in a normal page.
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.webm': 'video/webm', '.mp4': 'video/mp4', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.wav': 'audio/wav' };
const server = createServer((req, res) => {
  const path = normalize(join(COMP, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!path.startsWith(COMP) || !existsSync(path) || statSync(path).isDirectory()) { res.writeHead(404); res.end(); return; }
  const data = readFileSync(path);
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
  const type = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
  if (range) {
    const start = Number(range[1] || 0), end = range[2] ? Number(range[2]) : data.length - 1;
    res.writeHead(206, { 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${data.length}`, 'content-length': end - start + 1 });
    res.end(data.subarray(start, end + 1));
  } else {
    res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': data.length });
    res.end(data);
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
await page.waitForFunction(() => typeof window.__seek === 'function' && window.__duration > 0, null, { timeout: 30000 });
await page.evaluate(() => window.__ready);
const health = await page.evaluate(() => ({ degraded: window.__degraded ?? null, errors: window.__assetErrors ?? null }));
console.log(`health: __degraded=${JSON.stringify(health.degraded)} __assetErrors=${JSON.stringify(health.errors)}`);
if (health.degraded === true || (Array.isArray(health.errors) && health.errors.length)) {
  if (!args.includes('--allow-degraded')) throw new Error('composition is degraded (asset fallback in use); pass --allow-degraded to render anyway');
}
const duration = await page.evaluate(() => window.__duration);
const seek = t => page.evaluate(t => window.__seek(t), t);
console.log(`composition ${duration}s`);

if (times) {
  const dir = join(OUT, 'check');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const list = String(times).split(',').map(Number);
  for (const [i, t] of list.entries()) {
    await seek(t);
    const shot = join(dir, `s${String(i).padStart(2, '0')}.png`);
    await page.screenshot({ path: shot });
    cpSync(shot, join(dir, `t${t.toFixed(2).padStart(6, '0')}.png`));
  }
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(dir, 's%02d.png'),
    '-vf', `scale=640:-1,tile=4x${Math.ceil(list.length / 4)}`, '-frames:v', '1', join(dir, 'sheet.png')]);
  console.log(`stills + sheet in ${dir}`);
} else {
  const frames = Math.round(duration * FPS);
  const file = join(OUT, preview ? 'waystation-promo-preview.mp4' : 'waystation-promo.mp4');
  const hasMix = existsSync(MIX);
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-',
    ...(hasMix ? ['-i', MIX] : []),
    '-c:v', 'libx264', '-crf', preview ? '23' : '16', '-preset', preview ? 'veryfast' : 'slow', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    ...(hasMix ? ['-c:a', 'aac', '-b:a', '256k', '-ar', '48000'] : []),
    '-t', (frames / FPS).toFixed(4), '-movflags', '+faststart', file], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((res, rej) => ff.on('close', c => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}`)))));
  const t0 = Date.now();
  for (let i = 0; i < frames; i++) {
    await seek(i / FPS);
    const buf = await page.screenshot({ type: 'png' });
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
    if (i % 150 === 0) console.log(`  frame ${i}/${frames} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  ff.stdin.end();
  await done;
  console.log(`wrote ${file}${hasMix ? ' (with mix.wav)' : ' (no audio: mix.wav missing)'}`);
}
await browser.close();
server.close();
if (errors.length) console.warn(`page errors:\n  ${[...new Set(errors)].join('\n  ')}`);

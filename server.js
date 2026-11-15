#!/usr/bin/env node
'use strict';

/**
 * 视频合并控制台 —— 零依赖本地服务
 *
 *   node server.js          →  http://127.0.0.1:8787
 *
 * 环境变量：
 *   PORT=8787              监听端口
 *   BROWSE_ROOT=~/         目录浏览器可访问的根（默认用户主目录）
 *   KEEP_TEMP=1            任务结束后保留临时分段
 *
 * 设计要点：
 *   1. 队列串行：一次只跑一个目录任务，避免磁盘与 CPU 互相争抢
 *   2. 任务内并行：单目录的归一化阶段用 worker pool 并发，拼接阶段串行
 *   3. 方向自适应：按目录内横竖屏数量占比推荐画布，可手动覆盖
 *   4. 安全：仅绑定回环地址；ffmpeg 参数走 argv 数组，不经 shell
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
// 逻辑根；启动时会再 realpath 一次（macOS 的 /tmp 是指向 /private/tmp 的符号链接）
let BROWSE_ROOT = path.resolve(process.env.BROWSE_ROOT || os.homedir());
const APP_DIR = __dirname;
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const RUNS_DIR = path.join(APP_DIR, 'runs');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';
const KEEP_TEMP = process.env.KEEP_TEMP === '1';

const FPS = 30;
const VIDEO_EXT = new Set([
  '.mp4', '.mov', '.m4v', '.mkv', '.avi', '.flv', '.webm', '.wmv',
  '.ts', '.m2ts', '.mpg', '.mpeg', '.3gp',
]);
const THREADS_TOTAL = Math.max(1, os.cpus().length);
const DEFAULT_CONCURRENCY = THREADS_TOTAL >= 8 ? 3 : (THREADS_TOTAL >= 4 ? 2 : 1);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'variant' });
const naturalCompare = (a, b) => collator.compare(a, b);

// ---------------------------------------------------------------- 进程工具

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { if (out.length < 4e6) out += d; });
    child.stderr.on('data', (d) => { if (err.length < 2e5) err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout: out, stderr: err });
      else reject(new Error(`${path.basename(cmd)} 退出码 ${code}：${err.trim().slice(-500)}`));
    });
  });
}

async function pool(items, limit, worker) {
  const n = items.length;
  if (!n) return [];
  const results = new Array(n);
  let next = 0;
  let failure = null;
  const width = Math.max(1, Math.min(limit, n));
  const runners = [];
  for (let k = 0; k < width; k++) {
    runners.push((async () => {
      for (;;) {
        if (failure) return;
        const i = next++;
        if (i >= n) return;
        try {
          results[i] = await worker(items[i], i);
        } catch (e) {
          if (!failure) failure = e;
          return;
        }
      }
    })());
  }
  await Promise.all(runners);
  if (failure) throw failure;
  return results;
}

function killGroup(child) {
  if (!child || child.killed) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* 已退出 */ }
  setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 已退出 */ }
  }, 3000).unref?.();
}

// ---------------------------------------------------------------- 媒体探测

async function probe(file) {
  const { stdout } = await run(FFPROBE, [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', file,
  ]);
  const json = JSON.parse(stdout || '{}');
  const streams = json.streams || [];
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  if (!v) return null;

  let rotation = 0;
  const sd = (v.side_data_list || []).find((x) => typeof x.rotation === 'number');
  if (sd) rotation = Number(sd.rotation) || 0;
  else if (v.tags && v.tags.rotate) rotation = Number(v.tags.rotate) || 0;

  const dStream = Number(v.duration);
  const dFormat = Number(json.format && json.format.duration);
  const duration = Number.isFinite(dStream) && dStream > 0
    ? dStream
    : (Number.isFinite(dFormat) ? dFormat : 0);

  return {
    width: Number(v.width) || 0,
    height: Number(v.height) || 0,
    rotation,
    duration,
    hasAudio: Boolean(a),
    codec: v.codec_name || '',
  };
}

/** 应用旋转元数据后再判方向：手机竖拍常是宽>高 + rotation=90 */
function classify(width, height, rotation) {
  let w = width;
  let h = height;
  if (Math.abs(rotation) % 180 === 90) { const t = w; w = h; h = t; }
  if (!w || !h) return 'square';
  const ratio = w / h;
  if (ratio >= 1.05) return 'landscape';
  if (ratio <= 0.95) return 'portrait';
  return 'square';
}

// ---------------------------------------------------------------- 目录扫描

async function findVideos(dir, out = [], depth = 0) {
  if (depth > 24) return out;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === '__MACOSX') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await findVideos(p, out, depth + 1);
    else if (e.isFile() && VIDEO_EXT.has(path.extname(e.name).toLowerCase())) out.push(p);
  }
  return out;
}

const scanCache = new Map();

async function scanDir(dir) {
  const abs = path.resolve(dir);
  const hit = scanCache.get(abs);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.value;

  const files = await findVideos(abs);
  const metas = await pool(files, 4, (f) => probe(f).catch(() => null));

  const items = [];
  for (let i = 0; i < files.length; i++) {
    const m = metas[i];
    if (!m || !m.width) continue;
    items.push({
      path: files[i],
      rel: path.relative(abs, files[i]),
      name: path.basename(files[i]),
      width: m.width,
      height: m.height,
      rotation: m.rotation,
      duration: m.duration,
      hasAudio: m.hasAudio,
      kind: classify(m.width, m.height, m.rotation),
    });
  }
  items.sort((x, y) => naturalCompare(x.name, y.name) || naturalCompare(x.path, y.path));

  const by = (k) => items.filter((x) => x.kind === k);
  const landscape = by('landscape');
  const portrait = by('portrait');
  const square = by('square');
  const sumDur = (arr) => arr.reduce((s, x) => s + (x.duration || 0), 0);

  const value = {
    dir: abs,
    total: items.length,
    counts: { landscape: landscape.length, portrait: portrait.length, square: square.length },
    durations: { landscape: sumDur(landscape), portrait: sumDur(portrait), square: sumDur(square) },
    recommend: landscape.length > portrait.length ? 'landscape' : 'portrait',
    items,
    scannedAt: Date.now(),
  };
  scanCache.set(abs, { at: Date.now(), value });
  return value;
}

function scanBrief(scan) {
  return {
    dir: scan.dir,
    total: scan.total,
    counts: scan.counts,
    durations: scan.durations,
    recommend: scan.recommend,
    scannedAt: scan.scannedAt,
    items: scan.items.map((x) => ({
      rel: x.rel, name: x.name, kind: x.kind,
      width: x.width, height: x.height, rotation: x.rotation,
      duration: x.duration, hasAudio: x.hasAudio,
    })),
  };
}

// ---------------------------------------------------------------- 队列与任务

const tasks = [];
let busy = false;

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

/** 输出落在源目录的上一级：避免成品被下次递归扫描当成素材 */
function makeOutputPath(srcDir) {
  const base = path.basename(srcDir) || 'merged';
  const parent = path.dirname(srcDir);
  const ts = stamp();
  let p = path.join(parent, `${base}_${ts}.mp4`);
  let n = 2;
  while (fs.existsSync(p)) p = path.join(parent, `${base}_${ts}_${n++}.mp4`);
  return p;
}

function makeTask(input) {
  const dir = path.resolve(input.dir);
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    dir,
    outFile: input.outFile ? path.resolve(input.outFile) : makeOutputPath(dir),
    orient: ['auto', 'portrait', 'landscape'].includes(input.orient) ? input.orient : 'auto',
    preset: ['ultrafast', 'veryfast', 'fast', 'medium', 'slow'].includes(input.preset)
      ? input.preset : 'medium',
    crf: Math.min(35, Math.max(10, Number(input.crf) || 20)),
    concurrency: Math.min(6, Math.max(1, Number(input.concurrency) || DEFAULT_CONCURRENCY)),
    status: 'pending',
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    canceled: false,
    children: new Set(),
    progress: null,
    scan: null,
    resolvedOrient: null,
    canvas: null,
    error: null,
    outputSize: null,
  };
}

function publicTask(t) {
  return {
    id: t.id,
    dir: t.dir,
    outFile: t.outFile,
    orient: t.orient,
    preset: t.preset,
    crf: t.crf,
    concurrency: t.concurrency,
    status: t.status,
    createdAt: t.createdAt,
    startedAt: t.startedAt,
    finishedAt: t.finishedAt,
    durationMs: t.durationMs,
    resolvedOrient: t.resolvedOrient,
    canvas: t.canvas,
    error: t.error,
    outputSize: t.outputSize,
    progress: t.progress,
    summary: t.scan
      ? { total: t.scan.total, counts: t.scan.counts, durations: t.scan.durations, recommend: t.scan.recommend }
      : null,
  };
}

async function normalize(src, out, o) {
  return new Promise((resolve, reject) => {
    const vf = `scale=${o.W}:${o.H}:force_original_aspect_ratio=decrease:force_divisible_by=2,`
      + `pad=${o.W}:${o.H}:(ow-iw)/2:(oh-ih)/2:black,`
      + `fps=${FPS},setsar=1,format=yuv420p`;
    const gop = FPS * 2;

    const args = [
      '-nostdin', '-y', '-hide_banner', '-loglevel', 'error',
      '-progress', 'pipe:1', '-nostats',
      '-i', src,
    ];
    if (!o.hasAudio) {
      args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
    }
    args.push(...(o.hasAudio
      ? ['-map', '0:v:0', '-map', '0:a:0']
      : ['-map', '0:v:0', '-map', '1:a:0']));
    args.push(
      '-vf', vf,
      '-c:v', 'libx264', '-crf', String(o.crf), '-preset', o.preset,
      '-profile:v', 'high', '-level', '4.0', '-pix_fmt', 'yuv420p',
      '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0',
      '-threads', String(o.threads),
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
      '-video_track_timescale', '90000',
    );
    if (!o.hasAudio) args.push('-shortest');
    args.push(out);

    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    o.task.children.add(child);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    let buf = '';
    let err = '';
    let lastSpeed = 0;

    child.stdout.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const us = /^out_time_us=(\d+)/.exec(line);
        if (us && o.duration > 0) {
          const sec = Number(us[1]) / 1e6;
          o.onProgress(Math.min(1, sec / o.duration), lastSpeed);
        }
        const sp = /^speed=\s*([\d.]+)x/.exec(line);
        if (sp) lastSpeed = Number(sp[1]) || 0;
      }
    });
    child.stderr.on('data', (d) => { if (err.length < 1e5) err += d; });

    child.on('error', (e) => {
      o.task.children.delete(child);
      reject(e);
    });
    child.on('close', (code) => {
      o.task.children.delete(child);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 处理 ${path.basename(src)} 失败（退出码 ${code}）：${err.trim().slice(-400)}`));
    });
  });
}

async function concat(task, segDir, outFile) {
  const names = (await fsp.readdir(segDir)).filter((n) => /^\d{4}\.mp4$/.test(n)).sort();
  if (!names.length) throw new Error('没有可拼接的分段文件');

  let list = '';
  let missing = 0;
  for (const name of names) {
    let dur = 0;
    try {
      const { stdout } = await run(FFPROBE, [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        path.join(segDir, name),
      ]);
      const raw = String(stdout).replace(/\r/g, '').split('\n')[0].trim();
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) dur = n; else missing++;
    } catch {
      missing++;
    }
    list += `file '${name}'\n`;
    if (dur > 0) list += `duration ${dur.toFixed(6)}\n`;
  }
  await fsp.writeFile(path.join(segDir, 'filelist.txt'), list);

  await fsp.mkdir(path.dirname(outFile), { recursive: true });

  await new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, [
      '-nostdin', '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-i', 'filelist.txt',
      '-map', '0:v:0', '-map', '0:a:0',
      '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
      '-af', 'aresample=async=1:first_pts=0',
      '-movflags', '+faststart',
      outFile,
    ], { cwd: segDir, stdio: ['ignore', 'ignore', 'pipe'], detached: true });

    task.children.add(child);
    child.stderr.setEncoding('utf8');
    let err = '';
    child.stderr.on('data', (d) => { if (err.length < 1e5) err += d; });
    child.on('error', (e) => { task.children.delete(child); reject(e); });
    child.on('close', (code) => {
      task.children.delete(child);
      if (code === 0) resolve();
      else reject(new Error(`拼接失败（退出码 ${code}）：${err.trim().slice(-400)}`));
    });
  });

  return { segments: names.length, missingDuration: missing };
}

async function execute(task) {
  const scan = await scanDir(task.dir);
  task.scan = scan;
  if (!scan.total) throw new Error('该目录（含子目录）内没有可用的视频文件');

  const orient = task.orient === 'auto' ? scan.recommend : task.orient;
  task.resolvedOrient = orient;
  const W = orient === 'portrait' ? 1080 : 1920;
  const H = orient === 'portrait' ? 1920 : 1080;
  task.canvas = { width: W, height: H };

  const taskDir = path.join(RUNS_DIR, task.id);
  const segDir = path.join(taskDir, 'seg');
  await fsp.rm(taskDir, { recursive: true, force: true });
  await fsp.mkdir(segDir, { recursive: true });

  const threads = Math.max(1, Math.floor(THREADS_TOTAL / task.concurrency));

  task.status = 'running';
  task.startedAt = Date.now();
  task.progress = {
    done: 0, total: scan.total, percent: 0,
    current: scan.items[0] ? scan.items[0].rel : '',
    index: 1, speed: 0, threads, concurrency: task.concurrency,
  };
  broadcast();

  const partials = new Map();
  let done = 0;

  await pool(scan.items, task.concurrency, async (item, idx) => {
    if (task.canceled) throw new Error('__canceled__');
    const out = path.join(segDir, String(idx + 1).padStart(4, '0') + '.mp4');

    task.progress.current = item.rel;
    task.progress.index = idx + 1;
    broadcast();

    await normalize(item.path, out, {
      W, H,
      crf: task.crf,
      preset: task.preset,
      threads,
      task,
      hasAudio: item.hasAudio,
      duration: item.duration,
      onProgress: (frac, speed) => {
        partials.set(idx, frac);
        let sum = 0;
        for (const v of partials.values()) sum += v;
        task.progress.percent = Math.min(99.5, ((done + sum) / scan.total) * 100);
        task.progress.speed = speed;
        broadcast();
      },
    });

    partials.delete(idx);
    done += 1;
    task.progress.done = done;
    task.progress.percent = Math.min(99.5, ((done + 0) / scan.total) * 100);
    broadcast();
  });

  task.status = 'concatenating';
  task.progress.percent = 99.6;
  broadcast();

  await concat(task, segDir, task.outFile);

  task.progress.percent = 100;
}

async function pump() {
  if (busy) return;
  const task = tasks.find((t) => t.status === 'pending');
  if (!task) return;

  busy = true;
  try {
    await execute(task);
    task.status = 'done';
    const st = await fsp.stat(task.outFile).catch(() => null);
    task.outputSize = st ? st.size : null;
  } catch (e) {
    if (task.canceled) {
      task.status = 'canceled';
      task.error = '已取消';
    } else {
      task.status = 'failed';
      task.error = String((e && e.message) || e);
    }
  } finally {
    task.finishedAt = Date.now();
    task.durationMs = task.startedAt ? task.finishedAt - task.startedAt : null;
    if (!KEEP_TEMP) {
      await fsp.rm(path.join(RUNS_DIR, task.id), { recursive: true, force: true }).catch(() => {});
    }
    busy = false;
    broadcast();
    setImmediate(() => { pump(); });
  }
}

// ---------------------------------------------------------------- SSE 广播

const clients = new Set();
let broadcastTimer = null;

function snapshot() {
  return { tasks: tasks.map(publicTask), server: { busy, cpus: THREADS_TOTAL, defaultConcurrency: DEFAULT_CONCURRENCY } };
}

function broadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const res of clients) {
      try { res.write(payload); } catch { clients.delete(res); }
    }
  }, 400);
}

// ---------------------------------------------------------------- HTTP

function sendJson(res, data, code = 200) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJson(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (d) => {
      body += d;
      if (body.length > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('JSON 格式错误')); }
    });
    req.on('error', reject);
  });
}

function insideRoot(p) {
  return p === BROWSE_ROOT || p.startsWith(BROWSE_ROOT + path.sep);
}

async function browse(target) {
  const wanted = target ? path.resolve(target) : BROWSE_ROOT;
  const real = await fsp.realpath(wanted).catch(() => null);
  if (!real) throw new Error('目录不存在');
  if (!insideRoot(real)) throw new Error(`只能在 ${BROWSE_ROOT} 内浏览`);

  const entries = await fsp.readdir(real, { withFileTypes: true }).catch(() => []);
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== '__MACOSX')
    .map((e) => ({ name: e.name, path: path.join(real, e.name) }))
    .sort((a, b) => naturalCompare(a.name, b.name));

  const parent = path.dirname(real);
  return {
    path: real,
    parent: parent !== real && insideRoot(parent) ? parent : null,
    root: BROWSE_ROOT,
    dirs,
    shortcuts: [
      { name: '主目录', path: os.homedir() },
      { name: '下载', path: path.join(os.homedir(), 'Downloads') },
      { name: '桌面', path: path.join(os.homedir(), 'Desktop') },
      { name: '影片', path: path.join(os.homedir(), 'Movies') },
    ].filter((s) => insideRoot(path.resolve(s.path))),
  };
}

let ffmpegVersion = 'unknown';

function systemInfo() {
  return {
    cpus: THREADS_TOTAL,
    memGB: Math.round(os.totalmem() / 1073741824),
    platform: `${os.type()} ${os.release()}`,
    ffmpeg: ffmpegVersion,
    browseRoot: BROWSE_ROOT,
    defaults: { concurrency: DEFAULT_CONCURRENCY, preset: 'medium', crf: 20, fps: FPS },
    presets: ['ultrafast', 'veryfast', 'fast', 'medium', 'slow'],
  };
}

async function serveStatic(urlPath, res) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(404); res.end('not found'); return; }
  const data = await fsp.readFile(file).catch(() => null);
  if (!data) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  res.end(data);
}

function handleSSE(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
  clients.add(res);

  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* ignore */ }
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  try {
    if (req.method === 'GET' && p === '/api/events') return handleSSE(req, res);
    if (req.method === 'GET' && p === '/api/system') return sendJson(res, systemInfo());
    if (req.method === 'GET' && p === '/api/tasks') return sendJson(res, snapshot());

    if (req.method === 'GET' && p === '/api/browse') {
      return sendJson(res, await browse(url.searchParams.get('path')));
    }

    if (req.method === 'POST' && p === '/api/scan') {
      const body = await readJson(req);
      if (!body.dir) throw new Error('缺少 dir 参数');
      const st = await fsp.stat(body.dir).catch(() => null);
      if (!st || !st.isDirectory()) throw new Error('目录不存在或不可读');
      return sendJson(res, scanBrief(await scanDir(body.dir)));
    }

    if (req.method === 'POST' && p === '/api/tasks') {
      const body = await readJson(req);
      if (!body.dir) throw new Error('缺少 dir 参数');
      const st = await fsp.stat(body.dir).catch(() => null);
      if (!st || !st.isDirectory()) throw new Error('目录不存在或不可读');

      const scan = await scanDir(body.dir);
      if (!scan.total) throw new Error('该目录内没有可用的视频文件');

      const task = makeTask(body);
      tasks.push(task);
      broadcast();
      setImmediate(() => { pump(); });
      return sendJson(res, { task: publicTask(task) });
    }

    const m = /^\/api\/tasks\/([\w-]+)(\/cancel|\/reveal)?$/.exec(p);
    if (m) {
      const task = tasks.find((t) => t.id === m[1]);
      if (!task) throw new Error('任务不存在');

      if (req.method === 'POST' && m[2] === '/cancel') {
        if (task.status === 'pending') {
          task.status = 'canceled';
          task.finishedAt = Date.now();
          task.error = '已取消';
        } else if (['scanning', 'running', 'concatenating'].includes(task.status)) {
          task.canceled = true;
          for (const child of task.children) killGroup(child);
        }
        broadcast();
        return sendJson(res, { task: publicTask(task) });
      }

      if (req.method === 'POST' && m[2] === '/reveal') {
        spawn('open', ['-R', task.outFile], { detached: true, stdio: 'ignore' }).unref();
        return sendJson(res, { ok: true });
      }

      if (req.method === 'DELETE' && !m[2]) {
        if (['running', 'concatenating', 'scanning'].includes(task.status)) {
          throw new Error('任务运行中，请先取消');
        }
        const i = tasks.indexOf(task);
        if (i >= 0) tasks.splice(i, 1);
        broadcast();
        return sendJson(res, { ok: true });
      }
    }

    if (req.method === 'GET') return serveStatic(p, res);

    sendJson(res, { error: '不支持的请求' }, 405);
  } catch (e) {
    sendJson(res, { error: String((e && e.message) || e) }, 400);
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，试试 PORT=8788 node server.js`);
    process.exit(1);
  }
  throw e;
});

(async () => {
  await fsp.mkdir(RUNS_DIR, { recursive: true });
  await fsp.mkdir(PUBLIC_DIR, { recursive: true });

  // 根目录规范化：macOS 的 /tmp 是 /private/tmp 的符号链接，
  // 不统一会导致「浏览根内的目录却提示越界」。
  BROWSE_ROOT = await fsp.realpath(BROWSE_ROOT).catch(() => BROWSE_ROOT);

  try {
    const { stdout } = await run(FFMPEG, ['-version']);
    ffmpegVersion = (stdout.split('\n')[0] || '').trim();
  } catch {
    console.warn('警告：未找到 ffmpeg，任务将无法执行');
  }

  server.listen(PORT, HOST, () => {
    console.log('视频合并控制台');
    console.log(`  地址      http://${HOST}:${PORT}`);
    console.log(`  浏览根    ${BROWSE_ROOT}`);
    console.log(`  CPU       ${THREADS_TOTAL} 核，默认并发 ${DEFAULT_CONCURRENCY}`);
    console.log(`  ffmpeg    ${ffmpegVersion}`);
    console.log(KEEP_TEMP ? '  临时文件  保留（KEEP_TEMP=1）' : '  临时文件  任务结束后清理');
  });
})();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n正在停止服务...');
    for (const t of tasks) for (const c of t.children) killGroup(c);
    process.exit(0);
  });
}

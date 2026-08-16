#!/usr/bin/env node
//
// Headless render harness for the 1 Punch viewer.
//
// Serves the repo over plain HTTP, drives index.html in headless Chromium
// (ANGLE/SwiftShader software GL) and asserts — from the DOM only, never from a
// screenshot — that the model actually loaded, that the animation sidecar bound
// its movers, and that the UI responds. Screenshots are written as a side
// artifact for humans; they are never the pass/fail criterion.
//
// Run:  node test/render.mjs        (or: npm test)
// Env:  CHROME_PATH, PLAYWRIGHT_MODULE, RENDER_VENDOR_DIR, RENDER_SHOT_DIR,
//       RENDER_PORT, RENDER_LOAD_TIMEOUT_MS, RENDER_HEADED=1
//
// See test/README.md for why the Draco decoder has to be vendored.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SHOT_DIR = process.env.RENDER_SHOT_DIR || HERE;
const LOAD_TIMEOUT = Number(process.env.RENDER_LOAD_TIMEOUT_MS || 420000);
const SHOT_TIMEOUT = 180000; // SwiftShader rasterises 1429 meshes slowly; 30s default is not enough
const FIREBASE_HOST = 'gstatic.com/firebasejs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── assertion bookkeeping ───────────────────────────────────────────────────
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

// ── vendored off-host dependencies ──────────────────────────────────────────
// Every CDN is blocked in CI, so the viewer's off-host files are pulled straight
// from the npm registry (which is reachable) and replayed to the page through
// Playwright's request interception. They are cached outside the repo so no
// binaries can ever be committed.
const JS = 'text/javascript; charset=utf-8';
const VENDOR_DIR = process.env.RENDER_VENDOR_DIR
  || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), '1punch-render-harness', 'vendor');

const DEPS = [
  // [ url substring to intercept, local file name, content type, npm spec, path inside the tarball ]
  ['model-viewer', 'model-viewer.min.js', JS,
    '@google/model-viewer@3.5.0', 'package/dist/model-viewer.min.js'],
  ['three.module', 'three.module.js', JS,
    'three@0.166.1', 'package/build/three.module.js'],
  ['draco_wasm_wrapper.js', 'draco_wasm_wrapper.js', JS,
    'three@0.166.1', 'package/examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js'],
  ['draco_decoder.wasm', 'draco_decoder.wasm', 'application/wasm',
    'three@0.166.1', 'package/examples/jsm/libs/draco/gltf/draco_decoder.wasm'],
];

function ensureVendor() {
  fs.mkdirSync(VENDOR_DIR, { recursive: true });
  const missing = DEPS.filter(([, file]) => !fs.existsSync(path.join(VENDOR_DIR, file)));
  if (!missing.length) return;

  console.log(`vendoring ${missing.length} file(s) from npm into ${VENDOR_DIR}`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'punch-vendor-'));
  try {
    for (const spec of [...new Set(missing.map(d => d[3]))]) {
      const out = execFileSync('npm', ['pack', spec, '--silent', '--pack-destination', work], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
      });
      const tgz = path.join(work, out.trim().split('\n').pop().trim());
      const members = missing.filter(d => d[3] === spec).map(d => d[4]);
      execFileSync('tar', ['-xzf', tgz, '-C', work, ...members], { stdio: 'inherit' });
    }
    for (const [, file, , , member] of missing) {
      fs.copyFileSync(path.join(work, member), path.join(VENDOR_DIR, file));
      console.log(`  + ${file}`);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// ── local static server ─────────────────────────────────────────────────────
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function portOpen(port) {
  return new Promise(resolve => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => { s.destroy(); resolve(false); });
  });
}

async function startServer(port) {
  const proc = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', ROOT],
    { stdio: ['ignore', 'ignore', 'ignore'] });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {           // poll the port, never sleep blindly
    if (await portOpen(port)) return proc;
    if (proc.exitCode !== null) throw new Error(`http.server exited with code ${proc.exitCode}`);
    await sleep(100);
  }
  proc.kill('SIGKILL');
  throw new Error(`http.server did not come up on port ${port}`);
}

// ── browser plumbing ────────────────────────────────────────────────────────
function chromePath() {
  const candidates = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  try { // any other Playwright chromium build that happens to be installed
    const base = '/opt/pw-browsers';
    for (const d of fs.readdirSync(base)) {
      const p = path.join(base, d, 'chrome-linux', 'chrome');
      if (d.startsWith('chromium') && fs.existsSync(p)) return p;
    }
  } catch { /* no bundled browsers */ }
  return undefined; // let Playwright fall back to its own default
}

async function loadPlaywright() {
  const explicit = process.env.PLAYWRIGHT_MODULE;
  const tries = explicit
    ? [explicit]
    : ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs'];
  let last;
  for (const t of tries) {
    try {
      return await import(t.startsWith('/') ? pathToFileURL(t).href : t);
    } catch (e) { last = e; }
  }
  throw new Error(`cannot load Playwright (set PLAYWRIGHT_MODULE): ${last?.message}`);
}

// ── main ────────────────────────────────────────────────────────────────────
let server, browser;
try {
  ensureVendor();
  const payloads = DEPS.map(([key, file, type]) => [key, fs.readFileSync(path.join(VENDOR_DIR, file)), type]);

  const port = Number(process.env.RENDER_PORT) || await freePort();
  const origin = `http://127.0.0.1:${port}`;
  server = await startServer(port);
  console.log(`serving ${ROOT} at ${origin}`);

  const { chromium } = await loadPlaywright();
  browser = await chromium.launch({
    executablePath: chromePath(),
    headless: process.env.RENDER_HEADED !== '1',
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });

  const served = new Set(), blocked = new Set();
  await ctx.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(origin)) return route.continue();
    const hit = payloads.find(([key]) => url.includes(key));
    if (hit) { served.add(hit[0]); return route.fulfill({ contentType: hit[2], body: hit[1] }); }
    blocked.add(url);          // Firebase lands here on purpose — the page try/catches it
    return route.abort();
  });

  const page = await ctx.newPage();
  const pageErrors = [], consoleErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const where = m.location()?.url || '';
    const tolerated = (where + ' ' + m.text()).includes(FIREBASE_HOST);
    if (!tolerated) consoleErrors.push(`${m.text()} @ ${where}`);
  });

  await page.goto(`${origin}/index.html`, { waitUntil: 'domcontentloaded' });

  const state = () => page.evaluate(() => {
    const mv = document.querySelector('model-viewer');
    return { src: mv?.src ?? null, loaded: mv?.loaded ?? null, pct: document.getElementById('pct')?.textContent ?? null };
  });

  // 1 ── the model itself loaded (the Draco tripwire)
  const t0 = Date.now();
  let loaded = false;
  try {
    await page.waitForFunction(() => document.querySelector('model-viewer')?.loaded === true, null, { timeout: LOAD_TIMEOUT });
    loaded = true;
  } catch { /* reported below with the state that explains it */ }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const s = await state();
  check('model-viewer.loaded === true', loaded,
    loaded
      ? `in ${secs}s, progress ${s.pct}`
      : `stuck after ${secs}s — loaded=${s.loaded}, #pct=${s.pct}, src=${s.src}. `
        + 'a src that is set and progress that stops advancing (usually 100%) while loaded stays '
        + 'false is the missing/broken-Draco-decoder signature — the GLB lists '
        + 'KHR_draco_mesh_compression in extensionsRequired, so no decoder means no first frame.');

  // 2 ── #openBtn is display:none until the anim sidecar resolves every mover
  //      against the GLB, so its visibility is DOM proof the sidecar bound.
  const btnVisible = await page.waitForSelector('#openBtn', { state: 'visible', timeout: 90000 })
    .then(() => true).catch(() => false);
  check('#openBtn visible (anim sidecar bound its movers)', btnVisible);

  await page.waitForTimeout(4000); // let the first frames settle before the artifact shot
  await shoot(page, 'render-01-closed.png');

  // 3 ── clicking the button toggles the label
  let labelBefore = null, labelAfter = null, toggled = false;
  if (btnVisible) {
    labelBefore = await page.textContent('#openLbl');
    await page.click('#openBtn');
    toggled = await page.waitForFunction(
      () => document.getElementById('openLbl')?.textContent?.trim() === 'Close doors',
      null, { timeout: 30000 }).then(() => true).catch(() => false);
    labelAfter = (await page.textContent('#openLbl'))?.trim() ?? null;
    toggled = toggled && labelBefore?.trim() === 'Open doors';
  }
  check('#openBtn click flips #openLbl to "Close doors"', toggled,
    `"${labelBefore?.trim() ?? 'n/a'}" -> "${labelAfter ?? 'n/a'}"`);

  await page.waitForTimeout(4000);
  await shoot(page, 'render-02-open.png');

  // 4 ── the dimension inputs are populated
  const dims = await page.evaluate(() => Object.fromEntries(
    ['dW', 'dD', 'dH'].map(id => [id, document.getElementById(id)?.value ?? ''])));
  const dimsOk = ['dW', 'dD', 'dH'].every(id => String(dims[id]).trim().length > 0);
  check('#dW / #dD / #dH are non-empty', dimsOk,
    Object.entries(dims).map(([k, v]) => `${k}=${v || '(empty)'}`).join(' '));

  // 5 ── nothing threw; only the expected Firebase failures on the console
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 5).join(' | ') || 'none');
  check('no unexpected console errors (Firebase failures tolerated)', consoleErrors.length === 0,
    consoleErrors.slice(0, 5).join(' | ') || 'none');

  console.log(`vendored files served: ${[...served].join(', ') || 'none'}`);
  console.log(`off-host requests left blocked: ${[...blocked].join(', ') || 'none'}`);

  await ctx.close();
} catch (err) {
  check('harness ran to completion', false, err?.stack || String(err));
} finally {
  await browser?.close().catch(() => {});
  server?.kill('SIGKILL');
}

async function shoot(page, name) {
  try {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const file = path.join(SHOT_DIR, name);
    await page.screenshot({ path: file, timeout: SHOT_TIMEOUT, animations: 'disabled' });
    console.log(`artifact: ${file}`);
  } catch (e) {
    console.log(`artifact: ${name} not written (${e.message.split('\n')[0]}) — screenshots are not a pass criterion`);
  }
}

const failed = results.filter(r => !r.ok);
console.log(`\n${failed.length ? 'FAIL' : 'PASS'}: ${results.length - failed.length}/${results.length} assertions passed`);
process.exit(failed.length ? 1 : 0);

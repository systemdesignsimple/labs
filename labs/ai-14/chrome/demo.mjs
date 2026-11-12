// ai-14 Chrome demo: one real browser, one moved Save button.
// Starts headless Google Chrome, loads page.html with Save moved, and runs two bots on the Save step:
//   replay: clicks the position recorded on the old layout, then reports done without looking
//   look + check: finds the button by its visible text, clicks it, then reads the page to confirm
// Clicks are real mouse events (Chrome DevTools Protocol Input.dispatchMouseEvent).
// Screenshots go to ./out/. Node 22 (global WebSocket), no packages. No network beyond 127.0.0.1.
// The demo starts after steps 1 to 3 (Dark mode On, name Calm R) so it shows only the moved control.

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9347;
const OUT = join(HERE, 'out');
const RECORDED_SAVE = { x: 310, y: 620 }; // centre of Save on the original layout
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'ai14-chrome-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-device-scale-factor=2',
  '--window-size=400,700', 'about:blank',
], { stdio: 'ignore' });

let ws, id = 0;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
}
const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value;

async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error('Chrome did not start');
}

async function load(url) {
  await send('Page.navigate', { url });
  for (let i = 0; i < 50 && (await evalJs('document.readyState')) !== 'complete'; i++) await sleep(100);
}
async function click(x, y) {
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  await sleep(300); // settle
}
async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'webp', quality: 90 });
  writeFileSync(join(OUT, name), Buffer.from(data, 'base64'));
}
// Observe: visible buttons and their positions, like a label list a vision step would return.
const look = () => evalJs(`[...document.querySelectorAll('button')].map(b => { const r = b.getBoundingClientRect();
  return { text: b.textContent.trim(), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })`);
const statusText = () => evalJs(`document.getElementById('status').textContent`);
const truth = () => evalJs('window.__truth()');

try {
  ws = new WebSocket(await connect());
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    }
  };
  await new Promise((r) => (ws.onopen = r));
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 400, height: 700, deviceScaleFactor: 2, mobile: false });
  const url = pathToFileURL(join(HERE, 'page.html')).href + '?moved=1';
  const version = (await send('Browser.getVersion')).product;

  // Bot 1: replay the recorded position.
  await load(url);
  await click(RECORDED_SAVE.x, RECORDED_SAVE.y);
  const replay = { clickedAt: RECORDED_SAVE, reported: 'done', status: await statusText(), saved: await truth() };
  await shot('replay.webp');

  // Bot 2: look, act, check.
  await load(url);
  const before = await look();
  const save = before.find((b) => b.text === 'Save');
  await click(save.x, save.y);
  const after = await statusText();
  const confirmed = after.startsWith('Saved');
  const check = { found: save, reported: confirmed ? 'done' : 'failed', status: after, saved: await truth() };
  await shot('look-check.webp');

  const result = { chrome: version, page: 'page.html?moved=1', replay, lookCheck: check };
  writeFileSync(join(OUT, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  try { ws?.close(); } catch {}
  chrome.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}

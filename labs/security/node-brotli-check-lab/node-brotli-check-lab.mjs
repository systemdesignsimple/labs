// SDS Security Lab: Node.js Brotli decoder flaw, CVE-2026-111497 (Node.js security release 2026-10-21).
// Read-only and defensive. It never sends malformed Brotli data; it checks versions and normal behaviour only.
//   1. reproduce: is the Node.js on this Mac an affected build? (fixed: 22.23.4, 24.22.1, 26.12.1)
//   2. experiment: normal Brotli round trips on the installed build and on the official fixed build
//   3. fix: the official fixed build, downloaded to a temp folder and checked against nodejs.org SHASUMS256 (nothing installed)
//   4. report: counts, plus how many Brotli decompression call sites our own code has
//   node labs/security/node-brotli-check-lab/node-brotli-check-lab.mjs
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, arch } from 'node:os';
import { report } from '../lib/report.mjs';

const FIXED = { 22: '22.23.4', 24: '24.22.1', 26: '26.12.1' };
const ROOT = resolve(import.meta.dirname, '../../..');
const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
const affected = (v) => { const major = Number(v.split('.')[0]); return !FIXED[major] ? 'end of life or unknown line' : cmp(v, FIXED[major]) < 0; };

// The official fixed build for this line, into a cache folder under the OS temp dir, verified by SHA-256.
const here = process.versions.node, major = Number(here.split('.')[0]);
const want = FIXED[major] ?? FIXED[22];
const cache = join(tmpdir(), 'sds-node-fixed', want);
const bin = join(cache, `node-v${want}-darwin-${arch()}`, 'bin', 'node');
if (!existsSync(bin)) {
  mkdirSync(cache, { recursive: true });
  const name = `node-v${want}-darwin-${arch()}.tar.gz`;
  const sums = await (await fetch(`https://nodejs.org/dist/v${want}/SHASUMS256.txt`)).text();
  const expect = (sums.split('\n').find((l) => l.endsWith(`  ${name}`)) ?? '').split(' ')[0];
  const buf = Buffer.from(await (await fetch(`https://nodejs.org/dist/v${want}/${name}`)).arrayBuffer());
  const got = createHash('sha256').update(buf).digest('hex');
  if (!expect || got !== expect) throw new Error(`checksum mismatch for ${name}`);
  writeFileSync(join(cache, name), buf);
  execFileSync('tar', ['-xzf', join(cache, name), '-C', cache]);
}
const fixedVersion = execFileSync(bin, ['-p', 'process.versions.node'], { encoding: 'utf8' }).trim();

// Every node on PATH (the one your service uses may differ from your shell's).
const nodes = [...new Set(execFileSync('/usr/bin/which', ['-a', 'node'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean))];
const rows = [];
for (const n of nodes) {
  const v = execFileSync(n, ['-p', 'process.versions.node'], { encoding: 'utf8' }).trim();
  rows.push({ test: `affected build (${n})`, input: `node ${v}`, kind: 'attack', unsafe: affected(v), fixed: affected(fixedVersion),
    bad: (x) => x !== false });
}

// Normal Brotli use must keep working on the fixed build: same output on both.
const roundTrip = (nodeBin, kb) => execFileSync(nodeBin, ['-e', `
  const z = require('node:zlib'), c = require('node:crypto');
  const data = Buffer.from(JSON.stringify(Array.from({ length: ${kb} * 16 }, (_, i) => ({ i, name: 'item-' + i, ok: i % 3 === 0 }))));
  const out = z.brotliDecompressSync(z.brotliCompressSync(data));
  process.stdout.write(out.equals(data) ? 'ok ' + c.createHash('sha256').update(out).digest('hex').slice(0, 8) : 'MISMATCH');
`], { encoding: 'utf8' }).trim();
for (const kb of [4, 256]) rows.push({ test: 'brotli round trip, sync API', input: `${kb * 16} JSON rows`, kind: 'normal', unsafe: roundTrip(process.execPath, kb), fixed: roundTrip(bin, kb) });

// Where does OUR code decompress Brotli? (read-only scan of this repo's own source, node_modules excluded)
const PAT = /brotliDecompress|createBrotliDecompress|BrotliDecompress|accept-encoding[^\n]*\bbr\b/i;
let sites = 0, files = 0;
const walk = (d) => { for (const f of readdirSync(d)) { if (/^(node_modules|\.git|dist|\.astro|labs)$/.test(f)) continue; const p = join(d, f); const st = statSync(p);
  if (st.isDirectory()) walk(p); else if (/\.(m?js|ts|astro)$/.test(f) && st.size < 2e6) { files++; sites += (readFileSync(p, 'utf8').match(new RegExp(PAT, 'gi')) ?? []).length; } } };
walk(ROOT);

report(import.meta.url, {
  id: 'node-brotli-check-lab', title: 'Node.js Brotli decoder flaw (CVE-2026-111497) check', env: `Node.js ${here} (installed) vs ${fixedVersion} (official fixed build)`,
  unsafe: `Node.js ${here}: bundled Brotli decoder before the 2026-10-21 fix (fixed: ${Object.values(FIXED).join(', ')})`,
  fix: [`upgrade to Node.js ${want} (same major line), restart every process, then check process.versions.node in the running service`,
    `verified here: nodejs.org node-v${want}-darwin-${arch()} build, SHA-256 matched SHASUMS256.txt, run from a temp folder`],
  rows,
  notes: [`our own code: ${sites} Brotli decompression call sites in ${files} source files (node_modules excluded); fetch() and dependencies can still decode br`,
    'this lab does not send malformed Brotli data; it proves which build is affected and that normal Brotli use is unchanged after the fix'],
});

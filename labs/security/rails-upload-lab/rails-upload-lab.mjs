// Security lab rails-upload-lab: image upload checks, the unsafe check next to the fix, on throwaway files made inside this run.
// Part A: upload pipeline. Unsafe = trust the file name / Content-Type, then hand the bytes to an image tool that picks
//         the format from the CONTENT (ImageMagick does this). Fixed = magic-byte allowlist, dimension limit, then
//         decode and re-encode to a fresh PNG (only pixels survive).
// Part B: ImageMagick policy.xml self-check. Reads two throwaway policy files (default-style vs locked-down) and reports
//         which risky coders, paths and limits each one allows. Also checks this Mac for ImageMagick, read-only.
// Offline, no network, temp dir deleted at the end, pure Node 22 (node:zlib), deterministic.
//   NODE_NO_WARNINGS=1 node labs/security/rails-upload-lab/rails-upload-lab.mjs
import { deflateSync, inflateSync, crc32 } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { report } from '../lib/report.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'sds-sec24-'));
const rows = [];
const add = (r) => rows.push(r);

// ---------- tiny PNG writer / reader (8-bit RGB or RGBA, no interlace) ----------
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
};
function makePng(w, h, alpha, px, { claimW = w, claimH = h } = {}) {
  const ch = alpha ? 4 : 3;
  const raw = Buffer.alloc((w * ch + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * (w * ch + 1) + 1 + x * ch;
    const c = px(x, y);
    for (let i = 0; i < ch; i++) raw[o + i] = c[i];
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(claimW, 0); ihdr.writeUInt32BE(claimH, 4);
  ihdr[8] = 8; ihdr[9] = alpha ? 6 : 2; // bit depth 8, colour type RGBA or RGB
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function pngChunks(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not PNG');
  const out = []; let o = 8;
  while (o + 12 <= buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString('latin1', o + 4, o + 8);
    if (o + 12 + len > buf.length) throw new Error('truncated chunk');
    const data = buf.subarray(o + 8, o + 8 + len);
    if ((crc32(buf.subarray(o + 4, o + 8 + len)) >>> 0) !== buf.readUInt32BE(o + 8 + len)) throw new Error('bad CRC');
    out.push({ type, data, start: o, end: o + 12 + len });
    o += 12 + len;
    if (type === 'IEND') break;
  }
  return { chunks: out, trailing: buf.length - o };
}
const ihdrOf = (buf) => { const d = pngChunks(buf).chunks[0].data; return { w: d.readUInt32BE(0), h: d.readUInt32BE(4), depth: d[8], type: d[9], interlace: d[12] }; };
function decodePng(buf) {
  const { chunks } = pngChunks(buf);
  const { w, h, depth, type, interlace } = ihdrOf(buf);
  if (depth !== 8 || ![2, 6].includes(type) || interlace) throw new Error('unsupported PNG layout');
  const ch = type === 6 ? 4 : 3, stride = w * ch;
  const raw = inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)), { maxOutputLength: (stride + 1) * h });
  const px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= ch ? px[y * stride + x - ch] : 0, b = y ? px[(y - 1) * stride + x] : 0, c = x >= ch && y ? px[(y - 1) * stride + x - ch] : 0;
      let p = v;
      if (f === 1) p = v + a; else if (f === 2) p = v + b; else if (f === 3) p = v + ((a + b) >> 1);
      else if (f === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); p = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      px[y * stride + x] = p & 255;
    }
  }
  return { w, h, alpha: ch === 4, px };
}
const reencode = ({ w, h, alpha, px }) => makePng(w, h, alpha, (x, y) => { const ch = alpha ? 4 : 3, o = (y * w + x) * ch; return [...px.subarray(o, o + ch)]; });
// bytes in a stored PNG that are not needed to show the picture: ancillary chunks (text, metadata) + data after IEND
const extras = (buf) => { const { chunks, trailing } = pngChunks(buf); return trailing + chunks.filter((c) => !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(c.type)).reduce((s, c) => s + c.end - c.start, 0); };

// ---------- what an image tool sees: format picked from the content, not the name (simplified magic table) ----------
function sniff(b) {
  const head = b.subarray(0, 64).toString('latin1');
  if (b.subarray(0, 8).equals(SIG)) return 'PNG';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'JPEG';
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'GIF';
  if (head.startsWith('%PDF')) return 'PDF';
  if (head.startsWith('%!')) return 'PS';
  if (/^\s*(<\?xml[^>]*>\s*)?<svg/i.test(head)) return 'SVG';
  if (/^\s*<\?xml[^>]*>\s*<image/i.test(head)) return 'MSL';
  if (/^\s*(push graphic-context|viewbox)/i.test(head)) return 'MVG';
  return 'TEXT';
}

// ---------- the two upload checks ----------
const MAX_PIXELS = 40_000_000; // 40 MP, same idea as policy.xml "area" / "width" / "height" limits
// UNSAFE: name contains an image extension OR the client says image/*, then the original bytes go to the image tool.
function unsafeUpload({ name, type, bytes }) {
  const okName = /\.(png|jpe?g|gif)/i.test(name); // no end anchor: "x.png.svg" passes
  if (!okName && !String(type).startsWith('image/')) return 'reject: name';
  const fmt = sniff(bytes);
  if (fmt !== 'PNG') return `accept, tool reads ${fmt}`;
  const { w, h } = ihdrOf(bytes);
  if (w * h > MAX_PIXELS) return `accept, tool allocs ${((w * h * 4) / 1e9).toFixed(0)} GB`;
  return `accept PNG ${w}x${h}, extras ${extras(bytes)} B`; // stored as uploaded
}
// FIXED: ignore name and Content-Type; magic bytes must be PNG; check dimensions from the header BEFORE decoding;
// decode, re-encode to a fresh PNG, store that under a server-chosen name with .png.
function fixedUpload({ bytes }) {
  const fmt = sniff(bytes);
  if (fmt !== 'PNG') return `reject: content is ${fmt}`;
  let hdr;
  try { hdr = ihdrOf(bytes); } catch { return 'reject: broken PNG'; }
  if (hdr.w * hdr.h > MAX_PIXELS) return `reject: ${hdr.w}x${hdr.h} > 40 MP`;
  let img;
  try { img = decodePng(bytes); } catch (e) { return `reject: ${e.message}`; }
  const out = reencode(img);
  const back = decodePng(out);
  const same = back.px.equals(img.px) ? '' : ', PIXELS CHANGED';
  const file = join(tmp, `stored-${rows.length}.png`); // server-chosen name, never the client's
  writeFileSync(file, out);
  return `accept PNG ${img.w}x${img.h}, extras ${extras(readFileSync(file))} B${same}`;
}

// ---------- throwaway uploads (harmless content: only file headers / comments, nothing that does anything) ----------
const grad = (x, y) => [x * 4 & 255, y * 4 & 255, 128, 255];
const clean64 = makePng(64, 64, true, grad);
const withText = Buffer.concat([clean64.subarray(0, 33), chunk('tEXt', Buffer.from('Comment\0lab note: GPS 35.0,139.0 (fake)')), clean64.subarray(33)]);
const withTail = Buffer.concat([makePng(8, 8, false, () => [200, 200, 200]), Buffer.from('LAB-EXTRA-DATA: bytes after the end of the image\n')]);
const huge = makePng(1, 1, false, () => [0, 0, 0], { claimW: 50000, claimH: 50000 });
const uploads = [
  ['name only: .png with SVG inside', { name: 'avatar.png', type: 'image/png', bytes: Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>') }, 'attack'],
  ['name only: .jpg with MVG inside', { name: 'photo.jpg', type: 'image/jpeg', bytes: Buffer.from('viewbox 0 0 1 1\n# lab file, draws nothing\n') }, 'attack'],
  ['name only: .gif with PostScript header', { name: 'anim.gif', type: 'image/gif', bytes: Buffer.from('%!PS-Adobe-3.0\n%% lab file, comment only\n') }, 'attack'],
  ['name only: .png with MSL inside', { name: 'logo.png', type: 'image/png', bytes: Buffer.from('<?xml version="1.0"?><image><!-- lab file --></image>') }, 'attack'],
  ['double extension', { name: 'cat.png.svg', type: 'image/svg+xml', bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') }, 'attack'],
  ['Content-Type trusted', { name: 'notes.txt', type: 'image/png', bytes: Buffer.from('plain text pretending to be an image\n') }, 'attack'],
  ['real PNG + data after IEND', { name: 'icon.png', type: 'image/png', bytes: withTail }, 'attack'],
  ['real PNG + metadata text chunk', { name: 'me.png', type: 'image/png', bytes: withText }, 'attack'],
  ['header claims 50000x50000', { name: 'big.png', type: 'image/png', bytes: huge }, 'attack'],
  ['normal avatar 64x64 RGBA', { name: 'avatar.png', type: 'image/png', bytes: clean64 }, 'normal'],
  ['normal banner 1200x300, .PNG', { name: 'Banner.PNG', type: 'image/png', bytes: makePng(1200, 300, false, (x, y) => [x & 255, y & 255, 90]) }, 'normal'],
  ['normal screenshot, odd name', { name: 'my photo (1).png', type: 'application/octet-stream', bytes: makePng(300, 200, false, (x, y) => [(x ^ y) & 255, 40, 200]) }, 'normal'],
];
for (const [test, up, kind] of uploads) {
  const path = join(tmp, `upload-${rows.length}`); // the run really writes and reads the throwaway file
  writeFileSync(path, up.bytes);
  const u = { ...up, bytes: readFileSync(path) };
  add({ test, input: `${up.name} (${up.type}, ${up.bytes.length} B)`, kind, unsafe: unsafeUpload(u), fixed: fixedUpload(u),
    bad: (v) => v.startsWith('accept') && (!v.startsWith('accept PNG') || !/extras 0 B$/.test(v)) });
}

// ---------- Part B: policy.xml self-check ----------
// Default-style policy: everything allowed (no coder, path or resource rules).
const policyUnsafe = `<policymap>\n  <!-- lab copy of a policy with no restrictions -->\n</policymap>\n`;
// Locked-down policy for an upload service: deny all coders, then allow only the image formats you accept.
const policyFixed = `<policymap>
  <policy domain="resource" name="width" value="8KP"/>
  <policy domain="resource" name="height" value="8KP"/>
  <policy domain="resource" name="area" value="40MP"/>
  <policy domain="resource" name="memory" value="256MiB"/>
  <policy domain="delegate" rights="none" pattern="*"/>
  <policy domain="filter" rights="none" pattern="*"/>
  <policy domain="path" rights="none" pattern="@*"/>
  <policy domain="coder" rights="none" pattern="*"/>
  <policy domain="coder" rights="read|write" pattern="{PNG,JPEG,GIF,WEBP}"/>
</policymap>\n`;
function parsePolicy(xml) {
  const body = xml.replace(/<!--[\s\S]*?-->/g, '');
  return [...body.matchAll(/<policy\s+([^>]*?)\/?>/g)].map((m) => Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], a[2]])));
}
const globRe = (p) => new RegExp('^' + p.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\{([^}]*)\}/g, (_, l) => `(${l.split(',').join('|')})`).replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
// ImageMagick 7 applies the rules in order; for a given name the last matching rule decides.
function rights(pol, domain, name) {
  let r = 'read|write';
  for (const p of pol) if (p.domain === domain && p.pattern && globRe(p.pattern).test(name)) r = p.rights;
  return /read/.test(r) ? 'allowed' : 'denied';
}
const limit = (pol, name) => pol.find((p) => p.domain === 'resource' && p.name === name)?.value ?? 'no limit';
const polFile = (n, x) => { const f = join(tmp, n); writeFileSync(f, x); return parsePolicy(readFileSync(f, 'utf8')); };
const pu = polFile('policy-unsafe.xml', policyUnsafe), pf = polFile('policy-fixed.xml', policyFixed);
const pol = (test, input, fn, kind, bad) => add({ test, input, kind, unsafe: fn(pu), fixed: fn(pf), bad });
for (const c of ['MVG', 'MSL', 'SVG', 'PS', 'EPS', 'PDF', 'TEXT', 'URL', 'HTTPS']) pol(`policy.xml coder ${c}`, `${c} reader for uploads`, (p) => rights(p, 'coder', c), 'attack', (v) => v === 'allowed');
pol('policy.xml path @file', 'indirect read @/some/path', (p) => rights(p, 'path', '@/some/path'), 'attack', (v) => v === 'allowed');
pol('policy.xml delegates', 'external helper programs', (p) => rights(p, 'delegate', 'gs'), 'attack', (v) => v === 'allowed');
pol('policy.xml area limit', 'pixel area cap', (p) => limit(p, 'area'), 'attack', (v) => v === 'no limit');
for (const c of ['PNG', 'JPEG', 'GIF', 'WEBP']) pol(`policy.xml coder ${c}`, `${c} reader for uploads`, (p) => rights(p, 'coder', c), 'normal');

// ---------- read-only check of this Mac: is ImageMagick installed, and what does its policy allow? ----------
const notes = [];
let im = null;
for (const bin of ['magick', 'convert']) {
  try { im = execFileSync(bin, ['-version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).split('\n')[0]; break; } catch {}
}
notes.push(im ? `this Mac: ${im}` : 'this Mac: ImageMagick not installed (nothing to check here). On your servers run: magick -version ; magick -list policy');
const policyPaths = ['/opt/homebrew/etc/ImageMagick-7/policy.xml', '/usr/local/etc/ImageMagick-7/policy.xml', '/etc/ImageMagick-7/policy.xml', '/etc/ImageMagick-6/policy.xml'];
for (const f of policyPaths.filter(existsSync)) {
  const p = parsePolicy(readFileSync(f, 'utf8'));
  const open = ['MVG', 'MSL', 'SVG', 'PS', 'EPS', 'PDF', 'TEXT', 'URL'].filter((c) => rights(p, 'coder', c) === 'allowed');
  notes.push(`${f}: risky coders allowed: ${open.join(',') || 'none'}; area limit: ${limit(p, 'area')}`);
}
notes.push('Rails: for the CVE number and fixed versions use the official Rails security announcement / rails GitHub advisory');

rmSync(tmp, { recursive: true, force: true });
report(import.meta.url, {
  id: 'rails-upload-lab', title: 'image upload checks and ImageMagick policy.xml', env: `Node ${process.versions.node}, pure-Node PNG decode/encode, simulated content-sniffing image tool`,
  unsafe: 'accept when the name has .png/.jpg/.gif or Content-Type is image/*, pass the original bytes to an image tool that reads the format from the content; policy.xml with no rules',
  fix: [
    'check magic bytes against an allowlist (PNG here), ignore file name and Content-Type',
    'read width x height from the header and reject > 40 MP before decoding',
    'decode and re-encode to a fresh PNG; store under a server-chosen name',
    'policy.xml: coder rights="none" pattern="*", then rights="read|write" pattern="{PNG,JPEG,GIF,WEBP}"; deny delegates, path "@*"; set width/height/area limits',
  ],
  rows, notes,
});

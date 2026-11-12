// redact.mjs: pre-send redaction at the request boundary (supporting code for the ai-9 article).
// An explicit request schema (unknown fields are rejected, the outgoing request is rebuilt from allowed
// fields), session-stable placeholders with a 16-byte random session tag, class-aware restore with an
// owner check, single-use write grants held privately per session, and fixed-code errors.
// Node 22, no packages, no network. Every value is fake.
//
// Trust assumption for the local write: the approved directory and every parent of it are writable only
// by you. The realpath checks below run once; they do not stop another process from swapping a directory
// for a symlink between the check and the write. The 'wx' flag only protects the final path component.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

// 1. Shape-based patterns. Group 1 is the context, group 2 the value. The value is replaced
//    by position, so a value equal to its own key (TOKEN=TOKEN) cannot survive.
const PATTERNS = [
  { cls: 'SECRET', re: /(\b[A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|API_KEY)[A-Z0-9_]*=)(\S+)/g }, // KEY=value
  { cls: 'SECRET', re: /(\/\/[^:/\s]+:)([^@\s]+)@/g },                                     // user:pass@host
  { cls: 'EMAIL',  re: /()([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z.]{2,})/g },
  { cls: 'PHONE',  re: /()(\+?\d{1,3}[-. ]\d{3}[-. ]\d{4})\b/g },
];
const SECRET_KEY = /pass|pwd|secret|token|api_?key|credential/i; // JSON keys that name a secret value
const RANK = { EMAIL: 1, PHONE: 1, SECRET: 2 };                  // higher = more restrictive
const POLICY = {                                                 // classes the public restore may expand
  display: new Set(['EMAIL', 'PHONE']),                          // text the session owner reads
  'tool-call': new Set(),                                        // anything that can leave the machine
};                                                               // SECRET: only via writeRestored
const NONE = new Set();
const ALL = new Set(['EMAIL', 'PHONE', 'SECRET']);
const SYNCED = /\/(Library\/Mobile Documents|Library\/CloudStorage|Dropbox|OneDrive|Google Drive)(\/|$)/;

// 2. Fixed error codes. Nothing from the input is ever put into an error, a log line or telemetry.
class Reject extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const reject = (status, code) => { throw new Reject(status, code); };
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const onlyKeys = (o, allowed) => {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) reject(422, 'unsupported field');
};
const ident = (v) => (typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(v) ? v : reject(422, 'invalid identifier'));

export function createSession({ owner } = {}) {
  if (typeof owner !== 'string' || owner === '') throw new Error('a session needs an owner');
  // 16 random bytes: collision resistance only. A placeholder the session issued is visible in the
  // conversation and can be copied or replayed; the tag does not authorize anything. Authorization is
  // the owner check and the sink policy in restore, and the private grant in writeRestored.
  const tag = randomBytes(16).toString('hex');
  const byValue = new Map(); // real value -> { token, cls }   (never leaves this process)
  const byToken = new Map(); // token -> real value             (never leaves this process)
  const grants = new WeakMap(); // opaque handle -> { file }   (private to this session)
  const counts = {};
  const ISSUED = new RegExp(`<[A-Z]+_${tag}_\\d+>`, 'g');
  const tokenFor = (cls, value) => {
    // A placeholder this session issued can come back (history, a pasted transcript). Resolve it to
    // its entry so a stricter context still promotes it, and keep the token as it is.
    let e = byValue.get(byToken.get(value) ?? value);
    if (!e) {
      counts[cls] = (counts[cls] ?? 0) + 1;
      e = { token: `<${cls}_${tag}_${counts[cls]}>`, cls };
      byValue.set(value, e);
      byToken.set(e.token, value);
    } else if (RANK[cls] > RANK[e.cls]) {
      e.cls = cls; // seen again as something more sensitive: promote; the token spelling stays
    }
    return e.token;
  };
  const redactText = (text) => {
    if (typeof text !== 'string') reject(422, 'expected a string');
    let out = text;
    for (const { cls, re } of PATTERNS) {
      out = out.replace(re, (whole, pre, value) =>
        pre + tokenFor(cls, value) + whole.slice(pre.length + value.length));
    }
    return out;
  };
  // Tool-call arguments are JSON: rebuild them, redact every string, and treat a value under a
  // secret-looking key as a secret whatever its shape.
  const redactJson = (v, depth = 0) => {
    if (depth > 32) reject(422, 'nesting too deep');
    if (typeof v === 'string') return redactText(v);
    if (typeof v === 'number' || typeof v === 'boolean' || v === null) return v;
    if (Array.isArray(v)) return v.map((x) => redactJson(x, depth + 1));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => {
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(k)) reject(422, 'unsupported field');
      const secret = SECRET_KEY.test(k) && (typeof x === 'string' || typeof x === 'number');
      return [k, secret ? tokenFor('SECRET', String(x)) : redactJson(x, depth + 1)];
    }));
  };
  // 3. The schema. Every outgoing object is built from allowed fields; nothing is spread from input.
  const part = (p) => {
    if (!isObject(p)) reject(422, 'unsupported content part');
    switch (p.type) {
      case 'text':
        onlyKeys(p, ['type', 'text']);
        return { type: 'text', text: redactText(p.text) };
      case 'tool_use':
        onlyKeys(p, ['type', 'id', 'name', 'input']);
        if (!isObject(p.input)) reject(422, 'unsupported content part');
        return { type: 'tool_use', id: ident(p.id), name: ident(p.name), input: redactJson(p.input) };
      case 'tool_result':
        onlyKeys(p, ['type', 'tool_use_id', 'content']);
        return { type: 'tool_result', tool_use_id: ident(p.tool_use_id), content: redactText(p.content) };
      default:
        return reject(422, 'unsupported content part'); // images, files, new types: never forwarded unscanned
    }
  };
  const message = (m) => {
    if (!isObject(m)) reject(422, 'unsupported message');
    onlyKeys(m, ['role', 'content']); // tool_calls, name, metadata ...: rejected, not forwarded
    if (m.role !== 'user' && m.role !== 'assistant') reject(422, 'unsupported role');
    if (typeof m.content === 'string') return { role: m.role, content: redactText(m.content) };
    if (!Array.isArray(m.content) || m.content.length === 0) reject(422, 'unsupported content');
    return { role: m.role, content: m.content.map(part) };
  };
  const redactRequest = (body) => {
    if (!isObject(body)) reject(422, 'unsupported request');
    onlyKeys(body, ['model', 'system', 'max_tokens', 'messages']);
    if (!Array.isArray(body.messages)) reject(422, 'unsupported request');
    const out = { model: ident(body.model) };
    if (body.system !== undefined) out.system = redactText(body.system);
    if (body.max_tokens !== undefined) {
      if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1) reject(422, 'unsupported request');
      out.max_tokens = body.max_tokens;
    }
    out.messages = body.messages.map(message);
    return out;
  };
  // 4. Restore by stored class, never by the label spelled in the token, in one pass, and only
  //    tokens this session issued.
  const restoreWith = (reply, allowed) => reply.replace(ISSUED, (token) => {
    const value = byToken.get(token);
    if (value === undefined) return token;              // matches the pattern, never issued
    return allowed.has(byValue.get(value).cls) ? value : token;
  });
  return {
    tag,
    redactText,
    // Public restore: personal data only, only for the session owner, only into an allowed sink.
    // No argument to this function can make it return a SECRET.
    restore(reply, sink, viewer) {
      if (viewer !== owner) return reply;
      return restoreWith(reply, Object.hasOwn(POLICY, sink) ? POLICY[sink] : NONE);
    },
    // The boundary: parse, validate, redact, serialize. Any failure means nothing is forwarded.
    prepare(rawJson, requestId = randomUUID()) {
      let body;
      try { body = JSON.parse(rawJson); } catch { return { ok: false, status: 400, error: 'invalid JSON', requestId }; }
      try { return { ok: true, requestId, wire: JSON.stringify(redactRequest(body)) }; }
      catch (e) {
        if (e instanceof Reject) return { ok: false, status: e.status, error: e.code, requestId };
        return { ok: false, status: 500, error: 'internal error', requestId }; // never e.message
      }
    },
    // 5. Writing a secret to disk is its own authorized operation. The grant record (the checked file
    //    path) lives in this session's private WeakMap; the caller gets an empty frozen handle that
    //    cannot be edited, forged or used by another session.
    authorizeLocalWrite(target, { approvedRoot, operation, viewer }) {
      if (viewer !== owner) return { ok: false, reason: 'not the session owner' };
      if (operation !== 'write-config') return { ok: false, reason: 'operation not approved' };
      const root = fs.realpathSync(approvedRoot);
      let dir;
      try { dir = fs.realpathSync(path.dirname(path.resolve(target))); }
      catch { return { ok: false, reason: 'directory missing' }; }
      const file = path.join(dir, path.basename(target));
      if (dir !== root && !dir.startsWith(root + path.sep)) return { ok: false, reason: 'outside approved directory' };
      if (SYNCED.test(file)) return { ok: false, reason: 'synced location' };
      for (let d = dir; ; d = path.dirname(d)) {
        if (fs.existsSync(path.join(d, '.git'))) return { ok: false, reason: 'inside a git work tree' };
        if (d === path.dirname(d)) break;
      }
      if (fs.existsSync(file)) return { ok: false, reason: 'target exists' };
      const handle = Object.freeze(Object.create(null));
      grants.set(handle, { file });
      return { ok: true, handle };
    },
    // The only path that expands a SECRET: it consumes the grant first, then writes one new
    // owner-only file at the privately stored path. 'wx' fails if the path exists, symlinks included.
    writeRestored(reply, handle, viewer) {
      const rec = grants.get(handle);
      if (!rec || viewer !== owner) reject(403, 'no write grant');
      grants.delete(handle);
      fs.writeFileSync(rec.file, restoreWith(reply, ALL), { flag: 'wx', mode: 0o600 });
      return rec.file;
    },
    // Placeholders this session actually issued, removed so other detectors do not scan them.
    withoutIssued: (text) => text.replace(ISSUED, (t) => (byToken.has(t) ? ' ' : t)),
    size: () => byToken.size,
  };
}

// 6. A second, independent detector: Shannon entropy in bits per character.
export function entropy(s) {
  const freq = {};
  for (const c of s) freq[c] = (freq[c] ?? 0) + 1;
  return Object.values(freq).reduce((h, n) => h - (n / s.length) * Math.log2(n / s.length), 0);
}
// Entropy flags any random-looking string, harmless ones included; a flag does not prove a credential.
// Issued placeholders carry a random tag, so the caller removes them first (session.withoutIssued).
const suspicious = (text) => (text.match(/[A-Za-z0-9+/_-]{20,}/g) ?? []).filter((t) => entropy(t) > 4.0);

// ---------- demo ----------
const CANARY = 'CANARY-7Q2X-FAKE';
const ME = 'owner-1';
const folder = [
  'DB_PASSWORD=CANARY-7Q2X-FAKE',
  'DATABASE_URL=postgres://shop_app:CANARY-7Q2X-FAKE@db.internal:5433/shop',
  'TOKEN=TOKEN',                                           // regression: value equals its key
  '- If the database is down, call the on-call phone +1-555-0142.',
  // Four things the patterns were never written for:
  'DB_PASS=hunter-fake-22',                                // key name has no PASSWORD
  '{"password": "json-fake-pw"}',                          // JSON, lower case, colon
  'backup line: (415) 555-0199',                           // phone with brackets
  'payments key in prose: q8Zr2LwT9xVb4NcK7mPd3HsY6fJ1',   // random-looking token, no key name
].join('\n');
const history = [                                          // turn 1, as the app sent it
  { role: 'user', content: 'Help me debug the config.\n\n' + folder },
  { role: 'assistant', content: [
    { type: 'tool_use', id: 't1', name: 'read_rota', input: { file: 'rota.txt', password: 'tool-fake-pw' } },
  ] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'on-call rota: 202-555-0173' }] },
];
const request1 = { model: 'stand-in-model', system: 'Ops assistant. SERVICE_TOKEN=sys-fake-token-9', messages: history };
const s = createSession({ owner: ME });
const T = s.tag;
const show = (x) => x.replaceAll(T, 'TAG');               // the tag is random; print it as TAG
const turn1 = s.prepare(JSON.stringify(request1), 'req-1');
const sent = JSON.parse(turn1.wire);
console.log('session tag length:', T.length, 'hex chars (16 bytes)');
console.log('--- system ---\n' + show(sent.system));
console.log('--- message 1 (decoded) ---\n' + show(sent.messages[0].content));
console.log('--- messages 2 and 3 ---\n' + show(JSON.stringify(sent.messages.slice(1).map((m) => m.content))));
console.log('\ncanary in outgoing body:', turn1.wire.includes(CANARY), '| placeholders in local map:', s.size());

const naive = createSession({ owner: ME }).redactText(JSON.stringify(request1)); // regex over JSON
let parses = true;
try { JSON.parse(naive); } catch { parses = false; }
console.log('regex over serialized JSON: canary left =', naive.includes(CANARY), '| valid JSON =', parses);

const reply = `Set DB_PORT to 5432 in DATABASE_URL=postgres://shop_app:<SECRET_${T}_2>@db.internal:5432/shop. ` +
  `On-call: <PHONE_${T}_1>. Rota: <PHONE_${T}_2>. Look-alikes: <SECRET_1> <SECRET_${T}_99>.`;
console.log('\nafter turn 1, display (owner):', show(s.restore(reply, 'display', ME)));
console.log('after turn 1, display (other):', show(s.restore(reply, 'display', 'someone-else')));

// Turn 2: the issued placeholder comes back in a secret context and must be promoted.
const turn2 = s.prepare(JSON.stringify({ model: 'stand-in-model', messages: [...history,
  { role: 'user', content: `staging also uses ADMIN_PASSWORD=<PHONE_${T}_2>` }] }), 'req-2');
console.log('turn 2 sent:', show(JSON.parse(turn2.wire).messages[3].content));
for (const sink of ['display', 'tool-call', 'local-file']) {
  console.log(`after turn 2, ${sink.padEnd(10)}`, show(s.restore(reply, sink, ME)));
}

// Local write: one grant, one new file in an approved directory; escapes and reuse are refused.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redact-approved-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'redact-outside-'));
fs.symlinkSync(outside, path.join(root, 'link'));
const tries = [
  ['app.env', 'write-config', ME], ['link/app.env', 'write-config', ME], ['../app.env', 'write-config', ME],
  ['app2.env', 'upload', ME], ['app3.env', 'write-config', 'someone-else'],
];
for (const [rel, operation, viewer] of tries) {
  const g = s.authorizeLocalWrite(path.join(root, rel), { approvedRoot: root, operation, viewer });
  console.log(`grant ${rel.padEnd(13)} ${operation.padEnd(13)}`, g.ok ? 'ok' : g.reason);
  if (!g.ok) continue;
  const file = s.writeRestored(reply, g.handle, ME);
  const text = fs.readFileSync(file, 'utf8');
  const fails = (fn) => { try { fn(); return false; } catch { return true; } };
  const other = createSession({ owner: ME });
  const g2 = s.authorizeLocalWrite(path.join(root, 'app4.env'), { approvedRoot: root, operation, viewer: ME });
  console.log('  written: canary restored =', text.includes(CANARY),
    '| mode =', (fs.statSync(file).mode & 0o777).toString(8),
    '| grant reusable =', !fails(() => s.writeRestored(reply, g.handle, ME)),
    '| handle editable =', !fails(() => { g2.handle.file = '/tmp/x'; }), // modules are strict: a frozen object throws
    '| other session accepts it =', !fails(() => other.writeRestored(reply, g2.handle, ME)));
}
fs.rmSync(root, { recursive: true }); fs.rmSync(outside, { recursive: true });

// Fail closed with fixed codes; nothing from the input is echoed.
console.log('');
const bad = {
  'image part': { model: 'm', messages: [{ role: 'user', content: [{ type: 'image', data: 'fake' }] }] },
  'type with a secret': { model: 'm', messages: [{ role: 'user', content: [{ type: 'image DB_PASSWORD=leak-fake-1', text: 'x' }] }] },
  'tool_calls field': { model: 'm', messages: [{ role: 'assistant', content: 'x',
    tool_calls: [{ function: { arguments: '{"password":"leak-fake-2"}' } }] }] },
  'unknown top-level': { model: 'm', metadata: { note: 'DB_PASSWORD=leak-fake-3' }, messages: [] },
};
for (const [name, body] of Object.entries(bad)) {
  const r = s.prepare(JSON.stringify(body), 'req-x');
  console.log(name.padEnd(19), JSON.stringify(r), '| input echoed:', /leak-fake/.test(JSON.stringify(r)));
}
console.log('broken JSON'.padEnd(19), JSON.stringify(s.prepare('{"messages": [oops', 'req-y')));

console.log('\nmissed by the 4 patterns:');
for (const v of ['hunter-fake-22', 'json-fake-pw', '555-0199', 'q8Zr2LwT9xVb4NcK7mPd3HsY6fJ1']) {
  if (turn1.wire.includes(v)) console.log('  still in outgoing:', v);
}
console.log('entropy detector flags:',
  suspicious(s.withoutIssued(sent.messages[0].content)).map((t) => `${t} (${entropy(t).toFixed(2)} bits/char)`));

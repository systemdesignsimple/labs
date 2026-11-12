// Security lab nodejs-security-lab: four common Node.js mistakes, unsafe version next to the fix, on throwaway data on this Mac.
// Offline, no server, no network. Node 22+ (node:sqlite). Every number in the article comes from this output.
//   NODE_NO_WARNINGS=1 node labs/security/nodejs-security-lab/nodejs-security-lab.mjs
import { DatabaseSync } from 'node:sqlite';
import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { report } from '../lib/report.mjs';

const rows = [];
const add = (test, input, unsafe, fixed, kind = 'attack', bad) => rows.push({ test, input, unsafe, fixed, kind, ...(bad ? { bad } : {}) });
const many = (v) => v > 1; // a lookup for one email must never return several users

// 1. SQL injection: string concatenation vs placeholder
const db = new DatabaseSync(':memory:');
db.exec("CREATE TABLE users (id INTEGER, email TEXT, role TEXT)");
const ins = db.prepare('INSERT INTO users VALUES (?, ?, ?)');
[[1, 'a@example.test', 'user'], [2, 'b@example.test', 'user'], [3, 'admin@example.test', 'admin']].forEach((r) => ins.run(...r));
for (const email of ['a@example.test', "x' OR '1'='1"]) {
  const unsafe = db.prepare(`SELECT * FROM users WHERE email = '${email}'`).all().length;
  const safe = db.prepare('SELECT * FROM users WHERE email = ?').all(email).length;
  add('SQL lookup (rows returned)', email, unsafe, safe, email.includes("'") ? 'attack' : 'normal', many);
}

// 2. Path traversal: path.join(base, name) vs resolve + prefix check
const base = mkdtempSync(join(tmpdir(), 'sec1-'));
const pub = join(base, 'public'); mkdirSync(pub);
writeFileSync(join(pub, 'hello.txt'), 'hi');
writeFileSync(join(base, 'secret.env'), 'FAKE_KEY=not-a-real-key');
const unsafeOpen = (name) => existsSync(join(pub, name));
const safeOpen = (name) => { const p = resolve(pub, name); return p.startsWith(pub + sep) && existsSync(p); };
add('File download (file reachable)', 'hello.txt', unsafeOpen('hello.txt'), safeOpen('hello.txt'), 'normal');
add('File download (secret reachable)', '../secret.env', unsafeOpen('../secret.env'), safeOpen('../secret.env'));

// 3. Prototype pollution: naive deep merge vs merge that skips __proto__/constructor/prototype
const naiveMerge = (t, s) => { for (const k in s) { if (typeof s[k] === 'object' && s[k]) { t[k] ??= {}; naiveMerge(t[k], s[k]); } else t[k] = s[k]; } return t; };
const BAD = new Set(['__proto__', 'constructor', 'prototype']);
const safeMerge = (t, s) => { for (const k of Object.keys(s)) { if (BAD.has(k)) continue; if (typeof s[k] === 'object' && s[k]) { if (!Object.hasOwn(t, k)) t[k] = {}; safeMerge(t[k], s[k]); } else t[k] = s[k]; } return t; };
const body = '{"__proto__": {"isAdmin": true}}';
naiveMerge({}, JSON.parse(body)); const pollutedU = ({}).isAdmin === true; delete Object.prototype.isAdmin;
safeMerge({}, JSON.parse(body)); const pollutedS = ({}).isAdmin === true; delete Object.prototype.isAdmin;
add('JSON settings merge (every object gets isAdmin)', body, pollutedU, pollutedS);

// 4. Command injection: exec with a shell string vs execFile with an argument array
const marker = join(base, 'injected.txt');
const fname = `hello.txt; touch ${marker}`;
try { execSync(`ls ${join(pub, fname)}`, { stdio: 'ignore' }); } catch {} // the shell sees ';' and runs a second command
const injU = existsSync(marker); rmSync(marker, { force: true });
try { execFileSync('ls', [join(pub, fname)], { stdio: 'ignore' }); } catch {}
const injS = existsSync(marker);
add('ls on a user file name (extra command ran)', fname.replace(base, '<tmp>'), injU, injS);

rmSync(base, { recursive: true, force: true });
report(import.meta.url, {
  id: 'nodejs-security-lab', title: 'four common Node.js mistakes', env: `Node.js ${process.version}`,
  unsafe: 'SQL by string concat, path.join(base, name), naive deep merge, execSync with a shell string',
  fix: ["db.prepare('... WHERE email = ?').all(email)", 'resolve(base, name) and require it to start with base + sep',
    "merge skips __proto__, constructor, prototype and uses Object.hasOwn", "execFileSync('ls', [path]) with an argument array, no shell"],
  rows,
});

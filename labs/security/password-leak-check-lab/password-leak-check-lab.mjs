// Security lab password-leak-check-lab: "is my password leaked?" with the Pwned Passwords range API (k-anonymity).
// The password is hashed with SHA-1 on this Mac; only the first 5 hex characters of the hash are sent. The service answers
// with every hash suffix that starts with that prefix, and the match is found locally. Free, no API key.
// Test passwords only: three famous weak ones and one random 20-character password made fresh for this run.
//   node labs/security/password-leak-check-lab/password-leak-check-lab.mjs
import { createHash, randomBytes } from 'node:crypto';

const sha1 = (s) => createHash('sha1').update(s).digest('hex').toUpperCase();
const random = randomBytes(15).toString('base64url').slice(0, 20);
const tests = [['password123', 'famous weak'], ['letmein', 'famous weak'], ['Summer2024!', 'looks strong'], [random, 'random, made now']];
console.log(`password-leak-check-lab Pwned Passwords range API · ${new Date().toISOString().slice(0, 10)} · only 5 hash characters leave this Mac\n`);
const fmt = (a) => a.map((c, i) => String(c).padEnd([24, 18, 8, 8, 8, 10, 8, 12][i])).join(' ');
const ROW = /^[0-9A-F]{35}:[0-9]+$/;
console.log(fmt(['password', 'kind', 'sent', 'status', 'rows', 'positive', 'zero', 'times seen']));
for (const [pw, kind] of tests) {
  const h = sha1(pw), prefix = h.slice(0, 5), suffix = h.slice(5);
  const r = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, { headers: { 'Add-Padding': 'true', 'user-agent': 'sds-security-lab' } });
  const rows = (await r.text()).trim().split(/\r?\n/);
  const bad = rows.filter((l) => !ROW.test(l)).length;
  if (!r.ok || bad) throw new Error(`invalid response for ${prefix}: status ${r.status}, ${bad} malformed rows`);
  const lines = rows.map((l) => l.split(':'));
  const real = lines.filter(([, n]) => Number(n) > 0); // padding rows have count 0
  const hit = real.find(([s]) => s === suffix);
  console.log(fmt([kind === 'random, made now' ? '(random 20 chars)' : pw, kind, prefix, r.status, rows.length, real.length, rows.length - real.length, hit ? Number(hit[1]).toLocaleString('en-US') : 0]));
}

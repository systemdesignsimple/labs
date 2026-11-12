// Security lab apt-signature-lab: apt-style repository signature checks, each common verification mistake next to the fix,
// on a throwaway repo signed inside this run. Offline, no network, temp dir deleted at the end. Node 22+.
// Signing uses Ed25519 from fixed seeds (deterministic), standing in for the OpenPGP signature apt checks with gpgv/sqv.
//   NODE_NO_WARNINGS=1 node labs/security/apt-signature-lab/apt-signature-lab.mjs
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const NOW = Date.parse('2026-11-06T00:00:00Z'); // fixed lab clock so the run is deterministic
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const keyFromSeed = (seedText) => {
  const seed = createHash('sha256').update(seedText).digest(); // 32 bytes
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const priv = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const pub = createPublicKey(priv);
  const fpr = sha256(pub.export({ format: 'der', type: 'spki' })).slice(0, 16);
  return { priv, pub, fpr };
};
const repoKey = keyFromSeed('apt-signature-lab lab repo key (throwaway)');
const otherKey = keyFromSeed('apt-signature-lab lab other repo key (throwaway)');
// The machine trusts both keys (two repos configured). Only repoKey is meant for THIS repo.
const keyring = [repoKey, otherKey];

const BEGIN = '-----BEGIN SIGNED MESSAGE-----\n', SIG = '-----BEGIN SIGNATURE-----\n', END = '-----END SIGNATURE-----\n';

// Build a repo: pool/*.deb -> Packages (lists each .deb hash) -> InRelease (signed, lists the Packages hash)
function buildRepo(dir, { debs, key, date, validUntil, signed = true }) {
  mkdirSync(join(dir, 'pool'), { recursive: true });
  mkdirSync(join(dir, 'main'), { recursive: true });
  let packages = '';
  for (const [name, ver, body] of debs) {
    const file = `pool/${name}_${ver}.deb`;
    writeFileSync(join(dir, file), body);
    packages += `Package: ${name}\nVersion: ${ver}\nFilename: ${file}\nSHA256: ${sha256(body)}\n\n`;
  }
  writeFileSync(join(dir, 'main/Packages'), packages);
  const release = `Origin: sec22-lab\nSuite: stable\nDate: ${date}\nValid-Until: ${validUntil}\nSHA256:\n ${sha256(packages)} ${packages.length} main/Packages\n`;
  const inRelease = signed
    ? BEGIN + release + SIG + sign(null, Buffer.from(release), key.priv).toString('base64') + '\n' + END
    : release;
  writeFileSync(join(dir, 'InRelease'), inRelease);
}

const field = (text, name) => { // last match wins, like a careless line-by-line parser
  let v = null;
  for (const m of text.matchAll(new RegExp(`^${name}: (.*)$`, 'gm'))) v = m[1];
  return v;
};
const indexHash = (text) => { let v = null; for (const m of text.matchAll(/^ ([0-9a-f]{64}) \d+ main\/Packages$/gm)) v = m[1]; return v; };

// One verifier. "fixed" turns every check on; each "unsafe" row turns exactly one check off.
const FIXED = { requireSig: true, pinKey: true, parseSignedOnly: true, checkValidUntil: true, checkIndexHash: true, checkDebHash: true };
function verifyRepo(dir, opts = FIXED) {
  const inRelease = readFileSync(join(dir, 'InRelease'), 'utf8');
  const m = inRelease.match(/^-----BEGIN SIGNED MESSAGE-----\n([\s\S]*?)-----BEGIN SIGNATURE-----\n([A-Za-z0-9+/=]+)\n-----END SIGNATURE-----\n/);
  let signedPart = null;
  if (m) {
    const good = (k) => verify(null, Buffer.from(m[1]), k.pub, Buffer.from(m[2], 'base64'));
    const signer = keyring.find(good);
    if (!signer) return 'REJECT bad signature';
    if (opts.pinKey && signer.fpr !== repoKey.fpr) return 'REJECT wrong key';
    signedPart = m[1];
  } else if (opts.requireSig) return 'REJECT unsigned';
  const meta = opts.parseSignedOnly && signedPart !== null ? signedPart : inRelease;
  if (opts.checkValidUntil && Date.parse(field(meta, 'Valid-Until')) < NOW) return 'REJECT expired';
  const packages = readFileSync(join(dir, 'main/Packages'));
  if (opts.checkIndexHash && indexHash(meta) !== sha256(packages)) return 'REJECT index hash';
  for (const stanza of packages.toString().split('\n\n').filter(Boolean)) {
    const file = field(stanza, 'Filename'), want = field(stanza, 'SHA256');
    if (opts.checkDebHash && sha256(readFileSync(join(dir, file))) !== want) return `REJECT ${file.slice(5)}`;
  }
  return 'accept';
}

const base = mkdtempSync(join(tmpdir(), 'sec22-'));
const goodDebs = [['hello', '1.0', 'hello 1.0 original build'], ['tool', '2.1', 'tool 2.1 original build']];
const changed = 'hello 1.0 CHANGED after signing';
const fresh = { date: '2026-11-01T00:00:00Z', validUntil: '2026-11-15T00:00:00Z' };
let n = 0;
const repo = (spec) => { const d = join(base, `r${++n}`); buildRepo(d, { key: repoKey, ...fresh, debs: goodDebs, ...spec }); return d; };
const rows = [];
const add = (test, input, dir, offFlag) => rows.push({ test, input, unsafe: verifyRepo(dir, { ...FIXED, [offFlag]: false }), fixed: verifyRepo(dir) });

// 1. control: nothing changed
add('all checks on (control)', 'untouched repo', repo({}), 'checkDebHash');

// 2. one .deb replaced after signing; unsafe skips the .deb hash compare
let d = repo({}); writeFileSync(join(d, 'pool/hello_1.0.deb'), changed);
add('unsafe: no .deb hash check', 'one .deb changed after signing', d, 'checkDebHash');

// 3. .deb and Packages both changed to match; unsafe skips the Packages-vs-InRelease hash compare
d = repo({}); writeFileSync(join(d, 'pool/hello_1.0.deb'), changed);
writeFileSync(join(d, 'main/Packages'), readFileSync(join(d, 'main/Packages'), 'utf8').replace(sha256(goodDebs[0][2]), sha256(changed)));
add('unsafe: no index hash check', '.deb + Packages changed together', d, 'checkIndexHash');

// 4. same change, plus a hash line appended AFTER the signature; unsafe parses the whole file, not the verified bytes
d = join(base, 'r4b'); mkdirSync(d); execFileSync('cp', ['-R', join(base, `r${n}`) + '/.', d]);
const pk = readFileSync(join(d, 'main/Packages'));
writeFileSync(join(d, 'InRelease'), readFileSync(join(d, 'InRelease'), 'utf8') + `SHA256:\n ${sha256(pk)} ${pk.length} main/Packages\n`);
add('unsafe: reads unsigned text', 'text added outside the signed block', d, 'parseSignedOnly');

// 5. whole repo re-signed with a different key the machine also trusts; unsafe accepts any keyring key
d = repo({ key: otherKey, debs: [['hello', '1.0', changed], goodDebs[1]] });
add('unsafe: any key in keyring', 'signed by another trusted key', d, 'pinKey');

// 6. an old, correctly signed index replayed after its Valid-Until; unsafe ignores the date
d = repo({ date: '2026-09-01T00:00:00Z', validUntil: '2026-09-08T00:00:00Z', debs: [['hello', '0.9', 'hello 0.9 old build'], goodDebs[1]] });
add('unsafe: ignores Valid-Until', 'old index replayed (expired)', d, 'checkValidUntil');

// 7. signature stripped; unsafe treats "unsigned" as a warning (like allow-insecure)
d = repo({ signed: false, debs: [['hello', '1.0', changed], goodDebs[1]] });
add('unsafe: allows unsigned repo', 'signature removed', d, 'requireSig');

rmSync(base, { recursive: true, force: true });

// Read-only apt version check: prints the installed apt version, changes nothing.
let aptLine;
try { aptLine = execFileSync('apt-get', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n')[0]; }
catch { aptLine = `apt not installed on this ${process.platform === 'darwin' ? 'Mac' : 'machine'} (on Debian/Ubuntu: apt-get --version, apt-cache policy apt)`; }

console.log(`apt-signature-lab Node.js ${process.version} · ${new Date().toISOString().slice(0, 10)} · apt-style repo verification, unsafe vs fixed on a throwaway signed repo\n`);
const w = [34, 36, 8, 22];
const line = (a) => a.map((c, i) => String(c).padEnd(w[i]).slice(0, w[i])).join(' ');
console.log(line(['test', 'input', 'unsafe', 'fixed']));
for (const r of rows) console.log(line([r.test, r.input, r.unsafe, r.fixed]));
console.log(`\napt version (read-only): ${aptLine}`);

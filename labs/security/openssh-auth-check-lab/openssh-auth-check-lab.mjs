// Security lab openssh-auth-check-lab: read-only OpenSSH version and sshd_config self-check against the fixed release.
// Official record: Portable OpenSSH 10.6p2 (2026-11-05) release notes, "sshd(8): avoid password authentication bypass
// ... affects some Linux systems when built and run with PAM support disabled" (musl libc), fix commit 90f9c2f733
// "avoid password authn bypass" in openssh-portable. The fix adds one guard in sys_auth_passwd(): a password is only
// accepted when the stored hash is at least MIN_PASSWORD_HASH_LEN (4) characters long.
//
// Part A, the condition (REPRODUCE = the affected version + config is detected, never an exploit):
//   each row is a throwaway host profile in a temp dir: the `ssh -V` line, the libc, and an sshd_config (with Include
//   and Match blocks). The self-check reads them and says AFFECTED or ok.
//   unsafe = the host as it is; fixed = the same host after the fix (upgrade to 10.6p2, or the mitigation:
//   PasswordAuthentication no everywhere, keys only). Both are judged by the same self-check.
// Part B, the fix itself: the old and the new sshd password rule side by side, on throwaway accounts made in the run.
//   Normal rows use a real salted hash (Node scrypt stand-in for crypt()). The attack rows ask one question: if crypt()
//   ever returned a string equal to a very short stored entry (locked "!", "*", "x"), would the rule accept it?
//   The old rule trusts crypt() to never do that; the new rule refuses short entries before comparing.
//
//   NODE_NO_WARNINGS=1 node labs/security/openssh-auth-check-lab/openssh-auth-check-lab.mjs
//   SSHD_CONFIG=/etc/ssh/sshd_config NODE_NO_WARNINGS=1 node labs/security/openssh-auth-check-lab/openssh-auth-check-lab.mjs   (also check this machine, read-only)
// Offline, temp dir deleted at the end, deterministic.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, cpSync } from 'node:fs';
import { join, dirname, isAbsolute, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { scryptSync, timingSafeEqual } from 'node:crypto';
import { report } from '../lib/report.mjs';

const FIXED = '10.6p2';
const tmp = mkdtempSync(join(tmpdir(), 'sds-openssh-'));

// ---------- version: `ssh -V` ("OpenSSH_10.6p1 ...") or an Alpine package version ("10.6_p1-r0") ----------
function parseVersion(s) {
  const m = String(s).match(/(?:OpenSSH_)?(\d+)\.(\d+)(?:_?p(\d+))?/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}
const cmpV = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };

// ---------- sshd_config reader: first value wins (as in sshd), Include globs, Match blocks, comments ----------
function readConfig(file, out = { global: {}, match: [] }, ctx = { inMatch: null }) {
  if (!existsSync(file)) return out;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const [kw, ...rest] = line.split(/\s+/); const key = kw.toLowerCase(); const val = rest.join(' ');
    if (key === 'include') {
      for (const pat of rest) {
        const p = isAbsolute(pat) ? pat : join(dirname(file), pat);
        const dir = dirname(p), re = new RegExp('^' + basename(p).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
        if (existsSync(dir)) for (const f of readdirSync(dir).filter((n) => re.test(n)).sort()) readConfig(join(dir, f), out, ctx);
      }
      continue;
    }
    if (key === 'match') { ctx.inMatch = { when: val, opts: {} }; out.match.push(ctx.inMatch); continue; }
    const target = ctx.inMatch ? ctx.inMatch.opts : out.global;
    if (!(key in target)) target[key] = val.toLowerCase(); // first obtained value wins
  }
  return out;
}

// ---------- the self-check ----------
// Affected condition from the 10.6p2 notes: version below 10.6p2, Linux with musl libc, PAM off, password auth reachable.
function selfCheck(dir) {
  const host = JSON.parse(readFileSync(join(dir, 'host.json'), 'utf8'));
  const v = parseVersion(host.sshV);
  const cfg = readConfig(join(dir, 'etc/ssh/sshd_config'));
  const pam = host.builtWithPam && cfg.global.usepam === 'yes'; // sshd default UsePAM is no
  const pwGlobal = (cfg.global.passwordauthentication ?? 'yes') === 'yes'; // sshd default is yes
  const pwMatch = cfg.match.filter((m) => m.opts.passwordauthentication === 'yes').map((m) => m.when);
  const why = [];
  if (!v) return { result: 'CHECK', why: ['no OpenSSH version found'] };
  const old = cmpV(v, parseVersion(FIXED)) < 0;
  if (!old) return { result: 'ok', why: [`${host.sshV} >= ${FIXED}`] };
  if (host.libc !== 'musl') return { result: 'ok', why: [`libc ${host.libc}: the 10.6p2 notes name musl systems`] };
  if (pam) return { result: 'ok', why: ['UsePAM yes: passwords go through PAM, not this code path'] };
  if (!pwGlobal && !pwMatch.length) return { result: 'ok', why: ['PasswordAuthentication no everywhere (keys only)'] };
  why.push(`${host.sshV} is below ${FIXED}`, `libc musl`, host.builtWithPam ? 'UsePAM not yes' : 'sshd built without PAM');
  why.push(pwGlobal ? `PasswordAuthentication ${cfg.global.passwordauthentication ? 'yes' : 'yes (default, line missing)'}` : `PasswordAuthentication yes in Match ${pwMatch.join(', ')}`);
  return { result: 'AFFECTED', why };
}

// ---------- throwaway host profiles ----------
function makeHost(name, { sshV, libc = 'musl', builtWithPam = false, config = '', dropins = {} }) {
  const root = join(tmp, name, 'unsafe');
  mkdirSync(join(root, 'etc/ssh/sshd_config.d'), { recursive: true });
  writeFileSync(join(root, 'host.json'), JSON.stringify({ sshV, libc, builtWithPam }));
  writeFileSync(join(root, 'etc/ssh/sshd_config'), `# lab copy, throwaway\nInclude sshd_config.d/*.conf\nPort 22\nPubkeyAuthentication yes\n${config}Subsystem sftp internal-sftp\n`);
  for (const [f, body] of Object.entries(dropins)) writeFileSync(join(root, 'etc/ssh/sshd_config.d', f), body);
  return root;
}
// the fix, applied to a copy the way an owner would: upgrade (apk upgrade openssh) or the mitigation (keys only)
function applyFix(src, how) {
  const dst = join(dirname(src), 'fixed');
  cpSync(src, dst, { recursive: true });
  if (selfCheck(dst).result === 'ok') return dst; // nothing to fix, leave the host as it is
  if (how === 'upgrade') {
    const h = JSON.parse(readFileSync(join(dst, 'host.json'), 'utf8'));
    writeFileSync(join(dst, 'host.json'), JSON.stringify({ ...h, sshV: `OpenSSH_${FIXED}, OpenSSL 3.5.4 30 Sep 2025` }));
  } else {
    // mitigation: one explicit "PasswordAuthentication no" at the TOP (first value wins), and none enabled in Match blocks
    const files = [join(dst, 'etc/ssh/sshd_config'), ...readdirSync(join(dst, 'etc/ssh/sshd_config.d')).map((f) => join(dst, 'etc/ssh/sshd_config.d', f))];
    for (const f of files) writeFileSync(f, readFileSync(f, 'utf8').replace(/^(\s*)PasswordAuthentication\s+yes/gim, '$1PasswordAuthentication no'));
    const main = files[0];
    writeFileSync(main, 'PasswordAuthentication no\nKbdInteractiveAuthentication no\n' + readFileSync(main, 'utf8'));
  }
  return dst;
}

const CASES = [
  // [test, input, kind, fix, host]
  ['Alpine host, default config', '10.6p1, musl, no PasswordAuthentication line', 'attack', 'upgrade', { sshV: 'OpenSSH_10.6p1, OpenSSL 3.5.4 30 Sep 2025' }],
  ['older release, passwords on', '9.9p2, musl, PasswordAuthentication yes', 'attack', 'upgrade', { sshV: 'OpenSSH_9.9p2, OpenSSL 3.3.2 3 Sep 2024', config: 'PasswordAuthentication yes\n' }],
  ['Alpine package version string', 'apk 10.4_p1-r0, UsePAM no', 'attack', 'upgrade', { sshV: '10.4_p1-r0', builtWithPam: true, config: 'UsePAM no\n' }],
  ['passwords only in a Match block', 'global no, Match Group staff yes', 'attack', 'mitigate', { sshV: 'OpenSSH_10.6p1', config: 'PasswordAuthentication no\nMatch Group staff\n  PasswordAuthentication yes\n' }],
  ['drop-in turns passwords on first', 'sshd_config.d/50-cloud.conf yes', 'attack', 'mitigate', { sshV: 'OpenSSH_10.6p1', config: 'PasswordAuthentication no\n', dropins: { '50-cloud.conf': 'PasswordAuthentication yes\n' } }],
  ['two lines, first one wins', 'yes then no later in the file', 'attack', 'mitigate', { sshV: 'OpenSSH_10.5p1', config: 'PasswordAuthentication yes\nX11Forwarding no\nPasswordAuthentication no\n' }],
  ['glibc distro, same version', '10.6p1, glibc, UsePAM yes', 'normal', 'upgrade', { sshV: 'OpenSSH_10.6p1 Debian-1', libc: 'glibc', builtWithPam: true, config: 'UsePAM yes\n' }],
  ['already on the fixed release', '10.6p2, musl, passwords on', 'normal', 'upgrade', { sshV: 'OpenSSH_10.6p2, OpenSSL 3.5.4 30 Sep 2025', config: 'PasswordAuthentication yes\n' }],
  ['newer release', '10.7p1, musl', 'normal', 'upgrade', { sshV: 'OpenSSH_10.7p1' }],
  ['keys only on an old release', '10.6p1, musl, PasswordAuthentication no', 'normal', 'mitigate', { sshV: 'OpenSSH_10.6p1', config: 'PasswordAuthentication no\n' }],
  ['commented-out yes line', '#PasswordAuthentication yes + no', 'normal', 'mitigate', { sshV: 'OpenSSH_10.6p1', config: '#PasswordAuthentication yes\nPasswordAuthentication no\n' }],
  ['musl build with PAM on', '10.6p1, musl, UsePAM yes', 'normal', 'upgrade', { sshV: 'OpenSSH_10.6p1', builtWithPam: true, config: 'UsePAM yes\n' }],
  ['macOS client and server', 'OpenSSH_10.2p1, LibreSSL, darwin libc', 'normal', 'upgrade', { sshV: 'OpenSSH_10.2p1, LibreSSL 3.3.6', libc: 'darwin' }],
];

// ---------- Part B: the sshd password rule, before and after commit 90f9c2f733 ----------
const MIN_PASSWORD_HASH_LEN = 4;
// stand-in for crypt(): "$lab$<salt>$<hex>" with scrypt. Real systems use $6$ (SHA-512) or $y$ (yescrypt).
const labCrypt = (password, stored) => {
  const m = stored.match(/^\$lab\$([^$]+)\$/);
  return m ? `$lab$${m[1]}$${scryptSync(password, m[1], 32, { N: 1024 }).toString('hex')}` : null;
};
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const oldRule = (crypt, stored, pw) => { if (stored === '' && pw === '') return true; const e = crypt(pw, stored); return e != null && same(e, stored); };
const newRule = (crypt, stored, pw) => { if (stored === '' && pw === '') return true; const e = crypt(pw, stored); return e != null && stored.length >= MIN_PASSWORD_HASH_LEN && same(e, stored); };
// "what if the libc's crypt() returned a string equal to the stored entry" (the cause the notes place outside sshd)
const echoCrypt = (_pw, stored) => stored;

const rows = [], details = [];
try {
  for (const [i, [test, input, kind, how, opts]] of CASES.entries()) {
    const src = makeHost(`case-${i}`, opts);
    const u = selfCheck(src), f = selfCheck(applyFix(src, how));
    rows.push({ test, input, kind, unsafe: u.result, fixed: f.result, bad: (v) => v !== 'ok' });
    if (u.result !== 'ok') details.push(`   ${test}: ${u.why.join('; ')} -> fix: ${how === 'upgrade' ? `upgrade to ${FIXED}` : 'PasswordAuthentication no everywhere'}`);
  }

  const acct = `$lab$labsalt01$${scryptSync('lab-only correct horse', 'labsalt01', 32, { N: 1024 }).toString('hex')}`;
  rows.push({ test: 'rule: right password, real hash', input: 'throwaway account, $lab$ hash', kind: 'normal', unsafe: oldRule(labCrypt, acct, 'lab-only correct horse'), fixed: newRule(labCrypt, acct, 'lab-only correct horse') });
  rows.push({ test: 'rule: wrong password, real hash', input: 'throwaway account, $lab$ hash', kind: 'normal', unsafe: oldRule(labCrypt, acct, 'wrong'), fixed: newRule(labCrypt, acct, 'wrong') });
  rows.push({ test: 'rule: very long password, real hash', input: '1024 chars (MAX_PASSWORD_LEN), wrong', kind: 'normal', unsafe: oldRule(labCrypt, acct, 'a'.repeat(1024)), fixed: newRule(labCrypt, acct, 'a'.repeat(1024)) });
  for (const locked of ['!', '*', 'x', '!!']) {
    rows.push({ test: `rule: short stored entry "${locked}"`, input: 'crypt() result equals stored entry', kind: 'attack',
      unsafe: oldRule(echoCrypt, locked, 'any') ? 'accepted' : 'refused', fixed: newRule(echoCrypt, locked, 'any') ? 'accepted' : 'refused', bad: (v) => v === 'accepted' });
  }

  const notes = [
    `official record: Portable OpenSSH ${FIXED} release notes (openssh.com/releasenotes.html, 2026-11-05) and openssh-portable commit 90f9c2f733; Linux distributions may ship the fix as a patched package, so also read your distro's advisory (Alpine: apk info -v openssh)`,
    'results: AFFECTED = version below the fix + musl libc + PAM off + password authentication reachable; ok = at least one of those is not true',
    'part B never produces a real crypt() collision; echoCrypt only asks whether the rule itself would refuse a short stored entry',
  ];
  // this machine, read-only
  { // ssh -V prints its version on stderr
    const r = spawnSync('ssh', ['-V'], { encoding: 'utf8', timeout: 5000 });
    const line = `${r.stderr || ''}${r.stdout || ''}`.trim();
    const v = parseVersion(line);
    notes.push(`this machine: ${line || 'ssh not found'}${v ? ` (${cmpV(v, parseVersion(FIXED)) < 0 ? `below ${FIXED}, but` : `>= ${FIXED},`} ${process.platform === 'darwin' ? 'macOS has no musl libc, so not the affected setup' : 'check the libc: ldd --version'})` : ''}`);
  }
  const local = process.env.SSHD_CONFIG || '/etc/ssh/sshd_config';
  if (existsSync(local)) {
    try {
      const c = readConfig(local);
      notes.push(`${local}: PasswordAuthentication ${c.global.passwordauthentication ?? 'yes (default)'}, UsePAM ${c.global.usepam ?? 'no (default)'}, Match blocks with passwords on: ${c.match.filter((m) => m.opts.passwordauthentication === 'yes').length}; libc ${process.platform === 'linux' ? 'check with: ldd --version' : `${process.platform} (not musl)`}`);
    } catch (e) { notes.push(`${local}: not readable (${e.code}), run as an admin of this machine`); }
  }

  console.log('self-check findings on the unsafe hosts (what the check tells the owner):');
  console.log(details.join('\n'));
  console.log();
  report(import.meta.url, {
    id: 'openssh-auth-check-lab', title: 'OpenSSH password authentication self-check against 10.6p2',
    env: `Node ${process.versions.node}, ${CASES.length} throwaway host profiles (ssh -V, libc, sshd_config), sshd password rule before and after 90f9c2f733`,
    unsafe: `OpenSSH below ${FIXED} on musl Linux with PAM off and password authentication reachable; old sys_auth_passwd() trusts crypt() alone`,
    fix: [
      `upgrade to OpenSSH ${FIXED} or your distro's patched package (Alpine: apk upgrade openssh), then restart sshd`,
      'or, until then: PasswordAuthentication no at the top of sshd_config, and in every drop-in and Match block (keys only)',
      'sshd -T | grep -i passwordauthentication   (the value sshd really uses)',
      `the code fix: accept only if strlen(stored hash) >= ${MIN_PASSWORD_HASH_LEN} && strcmp(crypt(password, salt), stored) == 0`,
    ],
    rows, notes,
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

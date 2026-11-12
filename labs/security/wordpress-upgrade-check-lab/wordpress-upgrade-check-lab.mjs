// Security lab wordpress-upgrade-check-lab: WordPress core version and auto-update self-check, read-only, for an install you own.
// Each row is a throwaway WordPress-shaped install (only the files the check reads: wp-includes/version.php,
// wp-config.php, a few wp-content PHP files, maybe a .git folder). No WordPress code, no database, no web server.
//   unsafe = the install as it is (old core, or a setting that turns core auto-updates off)
//   fixed  = the same install after the fix (core on the fixed release for its branch, the blocking setting removed)
// Both are judged by the same self-check: read-install.php reads the files with PHP's tokenizer (runs nothing from the
// install), then judge() applies the rules WordPress core uses to decide if minor (security) releases install themselves.
// Version numbers in the lab advisory are LAB EXAMPLES (branch 9.x does not exist), so nothing here can be mistaken for
// the official fixed versions. For your own install, pass the official ones:
//   NODE_NO_WARNINGS=1 node labs/security/wordpress-upgrade-check-lab/wordpress-upgrade-check-lab.mjs
//   WP_PATH=/path/to/your/wordpress WP_FIXED=<branch fixed versions, comma separated> NODE_NO_WARNINGS=1 node labs/security/wordpress-upgrade-check-lab/wordpress-upgrade-check-lab.mjs
// Offline, temp dir deleted at the end, deterministic.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, renameSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { report } from '../lib/report.mjs';

const READER = new URL('./read-install.php', import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), 'sds-sec25-'));

// ---------- the advisory: fixed release per branch ----------
const LAB_ADVISORY = ['9.1.7', '9.2.3']; // LAB EXAMPLE numbers, not real WordPress versions
const parseV = (s) => String(s).split(/[.-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0);
const cmp = (a, b) => { const x = parseV(a), y = parseV(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
const branch = (v) => parseV(v).slice(0, 2).join('.');
function versionVerdict(v, fixedList) {
  if (!v) return { code: 'NOVER', why: 'no $wp_version found' };
  const fixed = fixedList.find((f) => branch(f) === branch(v));
  if (fixed) return cmp(v, fixed) < 0 ? { code: 'OLD', why: `${v} is below ${fixed}, the fixed release for branch ${branch(v)}`, target: fixed } : { code: 'ok', why: `${v} >= ${fixed}` };
  const newest = [...fixedList].sort(cmp).at(-1), oldest = [...fixedList].sort(cmp)[0];
  if (cmp(v, newest) > 0) return { code: 'ok', why: `${v} is a newer branch than any listed fix, so it already contains it` };
  if (cmp(v, oldest) < 0) return { code: 'NOFIX', why: `branch ${branch(v)} has no fixed release in the advisory, move to ${newest}`, target: newest };
  return { code: 'NOFIX', why: `branch ${branch(v)} is not in the advisory`, target: newest };
}

// ---------- WordPress core's own rules for "will a minor (security) release install itself?" ----------
// WP_Automatic_Updater::is_disabled(): DISALLOW_FILE_MODS, AUTOMATIC_UPDATER_DISABLED, filter automatic_updater_disabled.
// WP_Automatic_Updater::is_vcs_checkout(): .git/.svn/.hg/.bzr in the install folder or a parent.
// Core_Upgrader::should_update_to_version(): WP_AUTO_UPDATE_CORE (false = none, true/'beta'/'rc'/'development' = all,
//   'minor' = minor, undefined = minor on), then filter allow_minor_auto_core_updates; finally filter auto_update_core.
function autoVerdict(f) {
  const d = (n) => f.defines[n] && f.defines[n].value;
  const filt = (h) => f.filters.filter((x) => x.hook === h);
  const returnsTrue = (h) => filt(h).find((x) => x.cb === '__return_true');
  const returnsFalse = (h) => filt(h).find((x) => x.cb === '__return_false');
  if (d('DISALLOW_FILE_MODS') === true) return { code: 'OFF', why: "wp-config: define('DISALLOW_FILE_MODS', true) turns every update off" };
  if (d('AUTOMATIC_UPDATER_DISABLED') === true) return { code: 'OFF', why: "wp-config: define('AUTOMATIC_UPDATER_DISABLED', true)" };
  const dis = returnsTrue('automatic_updater_disabled');
  if (dis) return { code: 'OFF', why: `${dis.file}: add_filter('automatic_updater_disabled', '__return_true')` };
  if (f.vcs) return { code: 'VCS-OFF', why: `${f.vcs} found: WordPress treats this as a version-control checkout and skips core auto-updates` };
  const c = f.defines.WP_AUTO_UPDATE_CORE;
  let minor = true, why = 'default: minor releases on';
  if (c && c.value === false) { minor = false; why = "wp-config: define('WP_AUTO_UPDATE_CORE', false)"; }
  else if (c) why = `wp-config: WP_AUTO_UPDATE_CORE = ${JSON.stringify(c.value)}`;
  const m = returnsFalse('allow_minor_auto_core_updates');
  if (m) return { code: 'MINOR-OFF', why: `${m.file}: add_filter('allow_minor_auto_core_updates', '__return_false') blocks security releases` };
  const fin = returnsFalse('auto_update_core');
  if (fin) return { code: 'OFF', why: `${fin.file}: add_filter('auto_update_core', '__return_false')` };
  if (!minor && !returnsTrue('auto_update_core') && !returnsTrue('allow_minor_auto_core_updates')) return { code: 'OFF', why };
  const custom = f.filters.find((x) => x.cb === 'custom code');
  if (custom) return { code: 'CHECK', why: `${custom.file}: ${custom.hook} uses custom code, read it by hand` };
  return { code: 'ok', why };
}

const read = (dir) => JSON.parse(execFileSync('php', [READER, dir], { encoding: 'utf8' }));
function selfCheck(dir, fixedList) {
  const f = read(dir);
  const v = versionVerdict(f.version, fixedList), a = autoVerdict(f);
  const codes = [v.code, a.code].filter((c) => c !== 'ok');
  return { result: codes.length ? codes.join('+') : 'ok', v, a, facts: f };
}

// ---------- throwaway installs ----------
const CONFIG_BASE = `<?php
define( 'DB_NAME', 'lab_db' );
define( 'DB_USER', 'lab_user' );
define( 'DB_PASSWORD', 'lab-only-not-a-secret' );
define( 'DB_HOST', 'localhost' );
$table_prefix = 'wp_';
`;
function makeInstall(name, { version = '9.2.3', config = '', files = {}, dirs = [] }) {
  const root = join(tmp, name, 'public_html');
  mkdirSync(join(root, 'wp-includes'), { recursive: true });
  mkdirSync(join(root, 'wp-content', 'mu-plugins'), { recursive: true });
  writeFileSync(join(root, 'wp-includes', 'version.php'), `<?php\n/** WordPress Version (lab copy, only the lines the check reads) */\n$wp_version = '${version}';\n$wp_db_version = 60000;\n$required_php_version = '7.4';\n`);
  writeFileSync(join(root, 'wp-config.php'), CONFIG_BASE + config + `\nif ( ! defined( 'ABSPATH' ) ) { define( 'ABSPATH', __DIR__ . '/' ); }\nrequire_once ABSPATH . 'wp-settings.php';\n`);
  for (const [p, body] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), body); }
  for (const p of dirs) mkdirSync(join(root, p), { recursive: true });
  return root;
}
const muPlugin = (hook, cb) => ({ 'wp-content/mu-plugins/site-tweaks.php': `<?php\n/* Plugin Name: Site tweaks (lab) */\nadd_filter( '${hook}', '${cb}' );\n` });

// ---------- the fix, applied to a copy the way an owner would do it ----------
//   1. update core to the fixed release for its branch (here: rewrite $wp_version, standing in for the update itself)
//   2. remove the setting that blocks automatic security releases
function applyFix(src, dst, fixedList) {
  execFileSync('cp', ['-R', src, dst]);
  const before = selfCheck(dst, fixedList);
  if (before.v.target) {
    const p = join(dst, 'wp-includes', 'version.php');
    writeFileSync(p, readFileSync(p, 'utf8').replace(/\$wp_version = '[^']*';/, `$wp_version = '${before.v.target}';`));
  }
  const cfg = join(dst, 'wp-config.php');
  writeFileSync(cfg, readFileSync(cfg, 'utf8')
    .replace(/^\s*define\(\s*'(AUTOMATIC_UPDATER_DISABLED|DISALLOW_FILE_MODS)'\s*,\s*true\s*\);\s*$/gm, '')
    .replace(/define\(\s*'WP_AUTO_UPDATE_CORE'\s*,\s*false\s*\)/g, "define( 'WP_AUTO_UPDATE_CORE', 'minor' )"));
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
  for (const p of walk(join(dst, 'wp-content')).filter((x) => x.endsWith('.php'))) {
    writeFileSync(p, readFileSync(p, 'utf8')
      .replace(/^\s*add_filter\(\s*'automatic_updater_disabled'\s*,\s*'__return_true'\s*\);\s*$/gm, '')
      .replace(/^\s*add_filter\(\s*'(auto_update_core|allow_minor_auto_core_updates)'\s*,\s*'__return_false'\s*\);\s*$/gm, ''));
  }
  // a git checkout as web root: keep the repo outside the web root and deploy files only (or own updates in the pipeline)
  if (existsSync(join(dst, '.git'))) renameSync(join(dst, '.git'), join(dirname(dst), 'repo.git'));
  return dst;
}

const CASES = [
  // [test, input, kind, install options]
  ['core below fixed release', '$wp_version 9.2.1, fix is 9.2.3', 'attack', { version: '9.2.1' }],
  ['older branch below its fix', '$wp_version 9.1.5, branch fix 9.1.7', 'attack', { version: '9.1.5' }],
  ['branch with no fixed release', '$wp_version 8.9.9, branch not listed', 'attack', { version: '8.9.9' }],
  ['updater turned off in wp-config', "AUTOMATIC_UPDATER_DISABLED true", 'attack', { config: "define( 'AUTOMATIC_UPDATER_DISABLED', true );\n" }],
  ['core auto-updates set to false', "WP_AUTO_UPDATE_CORE false", 'attack', { config: "define( 'WP_AUTO_UPDATE_CORE', false );\n" }],
  ['file changes disallowed', 'DISALLOW_FILE_MODS true', 'attack', { config: "define( 'DISALLOW_FILE_MODS', true );\n" }],
  ['mu-plugin turns updater off', "automatic_updater_disabled __return_true", 'attack', { files: muPlugin('automatic_updater_disabled', '__return_true') }],
  ['mu-plugin vetoes core updates', "auto_update_core __return_false", 'attack', { files: muPlugin('auto_update_core', '__return_false') }],
  ['plugin blocks minor releases', 'allow_minor_auto_core_updates false', 'attack', { files: { 'wp-content/plugins/speed-pack/speed-pack.php': "<?php\n/* Plugin Name: Speed pack (lab) */\nadd_filter( 'allow_minor_auto_core_updates', '__return_false' );\n" } }],
  ['git checkout as web root', '.git folder in install root', 'attack', { dirs: ['.git'] }],
  ['old core and updater off', '9.2.1 + AUTOMATIC_UPDATER_DISABLED', 'attack', { version: '9.2.1', config: "define( 'AUTOMATIC_UPDATER_DISABLED', true );\n" }],
  ['current core, default config', '$wp_version 9.2.3, no update settings', 'normal', {}],
  ['newer branch than the fix', '$wp_version 9.3.0', 'normal', { version: '9.3.0' }],
  ['minor auto-updates (default)', "WP_AUTO_UPDATE_CORE 'minor'", 'normal', { config: "define( 'WP_AUTO_UPDATE_CORE', 'minor' );\n" }],
  ['all core auto-updates on', 'WP_AUTO_UPDATE_CORE true', 'normal', { config: "define( 'WP_AUTO_UPDATE_CORE', true );\n" }],
  ['editor locked, debug off', 'DISALLOW_FILE_EDIT true, WP_DEBUG false', 'normal', { config: "define( 'DISALLOW_FILE_EDIT', true );\ndefine( 'WP_DEBUG', false );\n" }],
  ['disable line commented out', "// and /* */ around AUTOMATIC_UPDATER_DISABLED", 'normal', { config: "// define( 'AUTOMATIC_UPDATER_DISABLED', true );\n/* define( 'DISALLOW_FILE_MODS', true ); */\n" }],
  ['only major updates held back', 'allow_major_auto_core_updates false', 'normal', { files: muPlugin('allow_major_auto_core_updates', '__return_false') }],
  ['git repo inside one plugin', '.git in wp-content/plugins/my-plugin', 'normal', { dirs: ['wp-content/plugins/my-plugin/.git'] }],
];

const rows = [], details = [];
try {
  CASES.forEach(([test, input, kind, opts], i) => {
    const src = makeInstall(`case-${i}`, opts);
    const fixedDir = applyFix(src, join(tmp, `case-${i}`, 'fixed_html'), LAB_ADVISORY);
    const u = selfCheck(src, LAB_ADVISORY), f = selfCheck(fixedDir, LAB_ADVISORY);
    rows.push({ test, input, kind, unsafe: u.result, fixed: f.result, bad: (v) => v !== 'ok' });
    if (u.result !== 'ok') details.push(`   ${test}: ${[u.v, u.a].filter((x) => x.code !== 'ok').map((x) => x.why).join('; ')}`);
  });

  // optional: the same self-check on YOUR install, read-only (nothing is changed, nothing executed from it)
  const notes = [
    `lab advisory: fixed releases ${LAB_ADVISORY.join(', ')} are LAB EXAMPLE numbers (branch 9.x does not exist); take the real ones from the WordPress security release notes on wordpress.org/news and the CVE record`,
    'results: ok, OLD (below the fixed release), NOFIX (branch has no fixed release), OFF / MINOR-OFF / VCS-OFF (security releases will not install themselves)',
  ];
  if (process.env.WP_PATH) {
    const fixedList = (process.env.WP_FIXED || '').split(',').map((s) => s.trim()).filter(Boolean);
    const r = read(process.env.WP_PATH);
    const a = autoVerdict(r), v = fixedList.length ? versionVerdict(r.version, fixedList) : { code: 'n/a', why: 'set WP_FIXED to compare the version' };
    notes.push(`your install ${process.env.WP_PATH}: version ${r.version} -> ${v.code} (${v.why}); auto-updates -> ${a.code} (${a.why})`);
  } else notes.push('your own install: WP_PATH=/path/to/wordpress WP_FIXED=<official fixed versions> node labs/security/wordpress-upgrade-check-lab/wordpress-upgrade-check-lab.mjs (read-only)');

  console.log('self-check findings on the unsafe installs (what the check tells the owner):');
  console.log(details.join('\n'));
  console.log();
  const php = read(makeInstall('probe', {})).php;
  report(import.meta.url, {
    id: 'wordpress-upgrade-check-lab', title: 'WordPress core version and auto-update self-check',
    env: `Node ${process.versions.node}, PHP ${php} tokenizer, ${CASES.length} throwaway WordPress-shaped installs, lab advisory (example versions)`,
    unsafe: 'core below the fixed release for its branch, or a setting that stops minor (security) releases installing themselves',
    fix: [
      'update core to the fixed release for your branch (Dashboard > Updates, or: wp core update --minor)',
      "remove define('AUTOMATIC_UPDATER_DISABLED', true) and define('DISALLOW_FILE_MODS', true), or own updates in your deploy",
      "define( 'WP_AUTO_UPDATE_CORE', 'minor' );   // the default: security releases install themselves",
      "remove add_filter('automatic_updater_disabled' / 'auto_update_core' / 'allow_minor_auto_core_updates', ...) blockers",
      'keep .git outside the web root (deploy files only), or make the pipeline ship each security release',
    ],
    rows, notes,
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

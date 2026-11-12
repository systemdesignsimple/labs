// SDS Security Lab: PHP2Shell, CVE-2026-109618 and CVE-2026-109619 (php.net security release 2026-10-21).
// Read-only and defensive: no requests, no exploit. It runs php2shell-check-lab.php (version + php.ini check) twice:
//   unsafe = PHP as installed on this Mac, fixed = the same PHP with php.net's temporary mitigations applied (-d flags),
// and checks that normal session use still works with the mitigations. Updating PHP is the only complete fix.
//   node labs/security/php2shell-check-lab/php2shell-check-lab.mjs
import { execFileSync } from 'node:child_process';
import { report } from '../lib/report.mjs';

const PHP = new URL('./php2shell-check-lab.php', import.meta.url).pathname;
const MITIGATE = ['-d', 'session.upload_progress.enabled=0', '-d', 'memory_limit=-1', '-d', 'fatal_error_backtraces=0'];
const check = (extra) => JSON.parse(execFileSync('php', [...extra, PHP, '--json'], { encoding: 'utf8' }));
const a = check([]), b = check(MITIGATE);
const session = (extra) => execFileSync('php', [...extra, '-r', 'session_save_path(sys_get_temp_dir()); echo @session_start() ? "session ok" : "session failed"; session_destroy();'], { encoding: 'utf8' }).trim();
const rows = [
  { test: 'PHP is a fixed release', input: `PHP ${a.version} (${a.sapi})`, kind: 'attack', unsafe: a.fixed ? 'fixed' : 'affected', fixed: b.fixed ? 'fixed' : 'affected, update needed', bad: (v) => String(v).startsWith('affected') },
  { test: 'session.upload_progress.enabled (CVE-2026-109619)', input: 'php.ini as installed', kind: 'attack', unsafe: a.upload_progress ? 'On' : 'Off', fixed: b.upload_progress ? 'On' : 'Off', bad: (v) => v === 'On' },
  { test: 'memory_limit (CVE-2026-109618)', input: 'php.ini as installed', kind: 'attack', unsafe: a.memory_limit, fixed: b.memory_limit, bad: (v) => v !== '-1' },
  ...(a.version.startsWith('8.5') ? [{ test: 'fatal_error_backtraces, 8.5 only (CVE-2026-109619)', input: 'php.ini as installed', kind: 'attack', unsafe: a.backtraces ? 'On' : 'Off', fixed: b.backtraces ? 'On' : 'Off', bad: (v) => v === 'On' }] : []),
  { test: 'normal use: session_start()', input: 'CLI session in temp dir', kind: 'normal', unsafe: session([]), fixed: session(MITIGATE) },
];
report(import.meta.url, {
  id: 'php2shell-check-lab', title: 'PHP2Shell (CVE-2026-109618, CVE-2026-109619) check', env: `PHP ${a.version}, ${a.sapi} SAPI`,
  unsafe: `PHP ${a.version} with its installed php.ini (fixed releases: 8.5.12, 8.4.27, 8.3.36, 8.2.35)`,
  fix: ['complete fix: update PHP to the fixed release of its branch, restart PHP-FPM / Apache, re-run this check in the web SAPI',
    'until then, php.net mitigations set in php.ini or the FPM pool (not ini_set or .user.ini):',
    'session.upload_progress.enabled=0, memory_limit=-1 via php_admin_value, fatal_error_backtraces=0 on 8.5, small post_max_size'],
  rows,
  notes: ['the version row stays "affected" until PHP itself is updated: mitigations reduce risk, they do not fix the bug',
    'the CLI can read a different php.ini than PHP-FPM or mod_php; run the same check through the web server you use'],
});

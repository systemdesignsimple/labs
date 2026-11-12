<?php
// Security lab php2shell-check-lab: PHP2Shell self-check (CVE-2026-109618, CVE-2026-109619; php.net advisory 2026-10-21).
// Read-only: compares this PHP's version with the fixed releases and reads the php.ini settings the advisory names as
// temporary mitigations. It sends nothing and attacks nothing. Run it on servers you own, with the same php.ini as the web
// SAPI (for PHP-FPM: `php-fpm -i` or a page that includes this file; the CLI can use a different php.ini).
//   php labs/security/php2shell-check-lab/php2shell-check-lab.php
$fixed = ['8.5' => '8.5.12', '8.4' => '8.4.27', '8.3' => '8.3.36', '8.2' => '8.2.35'];
$branch = PHP_MAJOR_VERSION . '.' . PHP_MINOR_VERSION;
$rows = [];
if (isset($fixed[$branch])) {
  $ok = version_compare(PHP_VERSION, $fixed[$branch], '>=');
  $rows[] = ['PHP version', PHP_VERSION, ">= {$fixed[$branch]}", $ok ? 'OK' : 'UPDATE NOW'];
} elseif (version_compare(PHP_VERSION, '8.2.0', '<')) {
  $rows[] = ['PHP version', PHP_VERSION, 'supported branch', 'END OF LIFE: vendor patch or upgrade'];
} else {
  $rows[] = ['PHP version', PHP_VERSION, 'release notes', 'check php.net (newer branch)'];
}
$updated = isset($fixed[$branch]) && version_compare(PHP_VERSION, $fixed[$branch], '>=');
$mit = fn($cond) => $updated ? 'not needed (updated)' : ($cond ? 'mitigated' : 'exposed until update');
$up = ini_get('session.upload_progress.enabled');
$rows[] = ['session.upload_progress.enabled', $up ? 'On' : 'Off', 'Off (109619)', $mit(!$up)];
$ml = ini_get('memory_limit');
$rows[] = ['memory_limit', $ml, '-1, not overridable (109618)', $mit($ml === '-1')];
$rows[] = ['post_max_size', ini_get('post_max_size'), '8M, or 32M with uploads', ''];
if (PHP_MAJOR_VERSION === 8 && PHP_MINOR_VERSION === 5) {
  $fb = ini_get('fatal_error_backtraces');
  $rows[] = ['fatal_error_backtraces (8.5)', $fb ? 'On' : 'Off', 'Off (109619)', $mit(!$fb)];
}
if (in_array('--json', $argv ?? [], true)) {
  echo json_encode(['version' => PHP_VERSION, 'sapi' => PHP_SAPI, 'fixed' => $updated, 'upload_progress' => (bool) ini_get('session.upload_progress.enabled'),
    'memory_limit' => ini_get('memory_limit'), 'backtraces' => (bool) ini_get('fatal_error_backtraces')]);
  exit;
}
printf("php2shell-check-lab PHP2Shell self-check · PHP %s (%s SAPI) · %s · read-only\n\n", PHP_VERSION, PHP_SAPI, date('Y-m-d'));
$fmt = "%-33s %-9s %-29s %s\n";
printf($fmt, 'check', 'value', 'advisory says', 'status');
foreach ($rows as $r) printf($fmt, ...$r);
printf("\nRESULT: %s\n", $updated ? 'patched release, keep it updated' : 'not a fixed release: update PHP (mitigations only reduce risk)');

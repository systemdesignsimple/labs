<?php
// wordpress-upgrade-check-lab read-only reader for a WordPress install you own. Usage: php read-install.php <install dir>
// It never includes or runs any file from the install. It uses PHP's own tokenizer, so comments are ignored the same
// way PHP ignores them, and prints JSON facts for wordpress-upgrade-check-lab.mjs to judge:
//   version  : $wp_version from wp-includes/version.php
//   defines  : define('NAME', literal) calls in wp-config.php (true, false, string, number)
//   filters  : add_filter('<update hook>', '<callback>') calls in wp-content/**/*.php (update hooks only)
//   vcs      : .git / .svn / .hg / .bzr in the install root or a parent folder (WordPress turns core auto-updates off then)
$root = rtrim($argv[1] ?? '', '/');
if ($root === '' || !is_dir($root)) { fwrite(STDERR, "usage: php read-install.php <install dir>\n"); exit(2); }

function toks(string $file): array {
  $src = @file_get_contents($file);
  if ($src === false) return [];
  return array_values(array_filter(token_get_all($src), fn($t) => !is_array($t) || !in_array($t[0], [T_WHITESPACE, T_COMMENT, T_DOC_COMMENT], true)));
}
function literal($t) {
  if (!is_array($t)) return ['?', null];
  if ($t[0] === T_CONSTANT_ENCAPSED_STRING) return ['str', stripcslashes(substr($t[1], 1, -1))];
  if ($t[0] === T_LNUMBER) return ['num', (int)$t[1]];
  if ($t[0] === T_STRING) { $l = strtolower($t[1]); if ($l === 'true') return ['bool', true]; if ($l === 'false') return ['bool', false]; }
  return ['?', is_array($t) ? $t[1] : $t];
}
$text = fn($t) => is_array($t) ? $t[1] : $t;

// version
$version = null;
$t = toks("$root/wp-includes/version.php");
for ($i = 0; $i + 2 < count($t); $i++)
  if (is_array($t[$i]) && $t[$i][0] === T_VARIABLE && $t[$i][1] === '$wp_version' && $t[$i + 1] === '=')
    { [$k, $v] = literal($t[$i + 2]); if ($k === 'str') $version = $v; }

// defines in wp-config.php (WordPress also allows wp-config.php one folder up)
$cfg = is_file("$root/wp-config.php") ? "$root/wp-config.php" : (is_file(dirname($root) . '/wp-config.php') ? dirname($root) . '/wp-config.php' : null);
$defines = [];
if ($cfg) {
  $t = toks($cfg);
  for ($i = 0; $i + 5 < count($t); $i++)
    if (strtolower($text($t[$i])) === 'define' && $t[$i + 1] === '(' && $t[$i + 3] === ',') {
      [$k, $name] = literal($t[$i + 2]); [$vk, $val] = literal($t[$i + 4]);
      if ($k === 'str') $defines[$name] = ['kind' => $vk, 'value' => $val];
    }
}

// update-related filters anywhere under wp-content (mu-plugins, plugins, themes), bounded walk
$hooks = ['automatic_updater_disabled', 'auto_update_core', 'allow_minor_auto_core_updates', 'allow_major_auto_core_updates', 'allow_dev_auto_core_updates'];
$filters = [];
$wc = "$root/wp-content";
if (is_dir($wc)) {
  $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($wc, FilesystemIterator::SKIP_DOTS));
  $n = 0;
  foreach ($it as $f) {
    if (!$f->isFile() || strtolower($f->getExtension()) !== 'php' || $f->getSize() > 2000000) continue;
    if (++$n > 20000) break;
    $t = toks($f->getPathname());
    for ($i = 0; $i + 4 < count($t); $i++)
      if (strtolower($text($t[$i])) === 'add_filter' && $t[$i + 1] === '(') {
        [$k, $hook] = literal($t[$i + 2]);
        if ($k !== 'str' || !in_array($hook, $hooks, true) || $t[$i + 3] !== ',') continue;
        [$ck, $cb] = literal($t[$i + 4]);
        $filters[] = ['hook' => $hook, 'cb' => $ck === 'str' ? $cb : 'custom code', 'file' => substr($f->getPathname(), strlen($root) + 1)];
      }
  }
}

// VCS checkout: WordPress checks the install folder and its parents
$vcs = null;
for ($d = $root; $vcs === null; $d = dirname($d)) {
  foreach (['.git', '.svn', '.hg', '.bzr'] as $v) if (file_exists("$d/$v")) { $vcs = $d === $root ? $v : "$v in $d"; break; }
  if (dirname($d) === $d) break;
}

echo json_encode(['php' => PHP_VERSION, 'version' => $version, 'config' => $cfg ? basename($cfg) : null, 'defines' => (object)$defines, 'filters' => $filters, 'vcs' => $vcs]);

# wordpress-upgrade-check-lab lab: WordPress core version and auto-update self-check

Article: `wordpress-core-upgrade-flaw-check-and-fix`. News source: The Hacker News, 2026-11-04,
https://thehackernews.com/2026/11/cisa-confirms-hackers-exploiting.html. For the CVE number and the affected and
fixed versions, use the official record: the WordPress security release post on wordpress.org/news, the CVE record,
and the CISA Known Exploited Vulnerabilities catalog entry. This lab does not depend on those details. It checks the
two things that decide whether your site has the fix: which core version is installed, and whether security
releases can install themselves.

## Question

WordPress ships security fixes as minor releases (for example x.y.1 to x.y.2), and by default a site installs them by
itself. Is your site on the fixed release for its branch? If it is not, is something in `wp-config.php`, a plugin or
the way you deploy stopping those updates?

## How to run

```
NODE_NO_WARNINGS=1 node labs/security/wordpress-upgrade-check-lab/wordpress-upgrade-check-lab.mjs
```

Node.js 22 and PHP 8 (`brew install php`). No WordPress, database or web server needed, and no network. It finishes in
about 4 seconds. Every run prints the same table (only the date in the header changes) and writes `report.json`.

To check your own install (read-only: nothing is changed and nothing from the install is run):

```
WP_PATH=/var/www/html WP_FIXED=<fixed release per branch, comma separated> NODE_NO_WARNINGS=1 node labs/security/wordpress-upgrade-check-lab/wordpress-upgrade-check-lab.mjs
```

Take the `WP_FIXED` values from the official security release post. The result is printed as a `note:` line.

## What it does

The run makes 19 throwaway installs in a temp folder and deletes it at the end. Each install has only the files
the check reads: `wp-includes/version.php`, `wp-config.php` (with dummy database values), and a few small plugin
files.

- **Reader** (`read-install.php`): reads those files with PHP's own tokenizer. It never `include`s anything, so it
  runs no code from the install, and it skips comments the same way PHP does. It reports `$wp_version`, the
  `define()` values in `wp-config.php`, any update-related `add_filter()` calls under `wp-content/`, and any
  `.git`/`.svn`/`.hg`/`.bzr` folder in the install root or a parent folder.
- **Judge** (`wordpress-upgrade-check-lab.mjs`): uses the rules WordPress core uses to decide whether a minor release installs itself
  (`WP_Automatic_Updater::is_disabled()`, `is_vcs_checkout()`, and `Core_Upgrader::should_update_to_version()`),
  then compares the version against the advisory.
- **unsafe** is each install as it was made. **fixed** is a copy after the fix: core moved to the fixed release
  for its branch, and the blocking setting removed (or `.git` moved out of the web root).
- **Lab advisory**: the fixed releases `9.1.7` and `9.2.3` are made-up example numbers. WordPress has no 9.x branch,
  so nobody can take them for real fixed versions.

## What it shows

| test | unsafe | fixed |
|---|---|---|
| core below the fixed release (same branch, older branch) | OLD | ok |
| branch with no fixed release in the advisory | NOFIX | ok (moved to a fixed branch) |
| `AUTOMATIC_UPDATER_DISABLED` true | OFF | ok |
| `WP_AUTO_UPDATE_CORE` false | OFF | ok (`'minor'`) |
| `DISALLOW_FILE_MODS` true | OFF | ok |
| mu-plugin `automatic_updater_disabled` → `__return_true` | OFF | ok |
| mu-plugin `auto_update_core` → `__return_false` | OFF | ok |
| plugin `allow_minor_auto_core_updates` → `__return_false` | MINOR-OFF | ok |
| `.git` in the install root | VCS-OFF | ok |
| old core and updater off together | OLD+OFF | ok |
| normal: current core, newer branch, `'minor'`, `true`, `DISALLOW_FILE_EDIT`, commented-out lines, major-only hold, `.git` inside one plugin | ok | ok |

Result: reproduced 11/11, blocked 11/11, normal inputs unchanged 8/8. Full output is in `last-run.txt`.

The cause, in one line: the fix only reaches a site whose core is updated. Sites stay on an old release when one
setting, plugin or deploy method turns off the automatic security updates and nobody updates by hand.

## How to spot it on your own sites

- `wp core version` (WP-CLI) or `grep wp_version wp-includes/version.php`. Compare the result with the fixed release
  for that branch.
- `grep -nE "AUTOMATIC_UPDATER_DISABLED|WP_AUTO_UPDATE_CORE|DISALLOW_FILE_MODS" wp-config.php`. Ignore lines that are
  commented out; this lab's reader does that for you.
- `grep -rnE "automatic_updater_disabled|auto_update_core|allow_minor_auto_core_updates" wp-content/`. These lines
  often come from "performance" or "maintenance" plugins.
- A `.git` folder in the web root or a parent folder. WordPress then skips core auto-updates, so your deploy must
  ship every security release.
- In the dashboard, Tools > Site Health shows "Background updates are not working as expected" when one of these is
  set.

## The fix

- Update core to the fixed release for your branch: Dashboard > Updates, or `wp core update --minor`. If your branch
  has no fixed release, move to a supported branch.
- Leave security releases on. This is the default, so the best fix is often to delete the blocking line:

```php
define( 'WP_AUTO_UPDATE_CORE', 'minor' ); // security and maintenance releases install themselves
// no AUTOMATIC_UPDATER_DISABLED, no DISALLOW_FILE_MODS (DISALLOW_FILE_EDIT is fine, it only locks the editor)
```

- Remove `add_filter()` lines that block minor core updates.
- If you deploy from git or turn off file changes on purpose, your pipeline owns updates. Ship each security release
  the day it comes out, and keep the repository outside the web root.

## How to test the fix

- Re-run the reader on your install (the `WP_PATH` command above). You want `ok` for both the version and the
  auto-updates.
- `wp core check-update` should list no minor update for your branch. Tools > Site Health should show no warning
  about background updates.
- `wp cron event list | grep wp_version_check` confirms the update check is scheduled. If `DISABLE_WP_CRON` is set,
  make sure a system cron calls `wp-cron.php`.
- Re-run this lab after changing the check. `RESULT: FIX WORKS` means every row behaved.

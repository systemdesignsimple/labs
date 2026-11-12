# openssh-auth-check-lab: OpenSSH password authentication self-check against 10.6p2

Article: `openssh-long-password-auth-bypass-check`. News source: The Hacker News, 2026-11-05,
https://thehackernews.com/2026/11/openssh-issues-emergency-fix-for-flaw.html.

Official record used by this lab:

- Portable OpenSSH 10.6p2 release notes, 2026-11-05 (https://www.openssh.com/releasenotes.html): "sshd(8): avoid
  password authentication bypass that is exploitable through sshd(8) that affects some Linux systems when built and
  run with PAM support disabled". The notes say the release "affects Linux systems that use the musl libc and PAM
  disabled", and that the OpenSSH team considers the root cause to be outside sshd.
- The fix commit in openssh-portable, `90f9c2f733` "avoid password authn bypass". In `sys_auth_passwd()` it now
  accepts a password only when the stored hash is at least `MIN_PASSWORD_HASH_LEN` (4) characters long.

For a CVE number and your distribution's patched package version, check the CVE record and your distro's advisory
(for Alpine, the `openssh` package in aports). This lab does not depend on them.

## Question

Is my own SSH server the setup the 10.6p2 notes describe? That means OpenSSH below 10.6p2, on Linux with musl libc
(Alpine and other musl-based images), with PAM off, and with password login reachable somewhere in `sshd_config`.
If it is, which fix should I apply, and how do I check that it worked?

## How to run

```
NODE_NO_WARNINGS=1 node labs/security/openssh-auth-check-lab/openssh-auth-check-lab.mjs
```

You need Node.js 22 and nothing else: no network, no sshd, no root. It finishes in under a second and deletes its
temp folder at the end. Each run prints the same table (only the date in the header changes) and writes
`report.json`. Full output is in `last-run.txt`.

It also prints read-only notes about the machine it runs on: the `ssh -V` line and `/etc/ssh/sshd_config`. To read
another config file, set `SSHD_CONFIG=/path/to/sshd_config`. Nothing is changed.

## What it does

**Part A, the condition.** The lab makes 13 throwaway host profiles in a temp folder. Each one has an `ssh -V` line,
a libc name and an `sshd_config`, some with `sshd_config.d/*.conf` drop-ins and `Match` blocks. The self-check reads
each config the way sshd does:

- the first value wins (a later `PasswordAuthentication no` does not undo an earlier `yes`);
- `Include` files are read where the `Include` line sits;
- `Match` blocks are checked on their own;
- comments are skipped;
- the defaults are `PasswordAuthentication yes` and `UsePAM no`.

A host is `AFFECTED` when all four parts of the condition are true. **unsafe** is the host as it was made.
**fixed** is a copy after the fix: either an upgrade to 10.6p2, or the mitigation (`PasswordAuthentication no` at
the top and in every drop-in and `Match` block, so login is by key only). A host that is already `ok` is not changed.

**Part B, the fix in code.** The lab runs the old and the new `sys_auth_passwd()` rule side by side, using throwaway
accounts made in the run. A Node scrypt hash stands in for `crypt()`. In the normal rows, the right password is
accepted, a wrong one is refused, and a 1024-character wrong password is refused, and both rules give the same
answers. The attack rows ask one question about the rule: if the system's `crypt()` ever returned a string equal to a
very short stored entry (`!`, `*`, `x`, `!!`, which usually mark locked accounts), would the rule accept it? The old
rule relies on `crypt()` never doing that. The new rule refuses short entries before it compares anything. The lab
does not make a real `crypt()` do this; it only tests the guard.

## What it shows

| test | unsafe | fixed |
|---|---|---|
| Alpine, 10.6p1, no `PasswordAuthentication` line (default yes) | AFFECTED | ok (upgrade) |
| 9.9p2, musl, `PasswordAuthentication yes` | AFFECTED | ok (upgrade) |
| Alpine package version `10.4_p1-r0`, `UsePAM no` | AFFECTED | ok (upgrade) |
| passwords off globally but on in `Match Group staff` | AFFECTED | ok (keys only) |
| drop-in `50-cloud.conf` turns passwords on before the main file's `no` | AFFECTED | ok (keys only) |
| `yes` early in the file, `no` later (first wins) | AFFECTED | ok (keys only) |
| rule: short stored entry `!`, `*`, `x`, `!!` | accepted | refused |
| normal: glibc distro, already 10.6p2, 10.7p1, keys only, commented-out `yes`, musl with PAM on, macOS | ok | ok |
| normal: right, wrong and 1024-character passwords on a real hash | same | same |

Result: reproduced 10/10, blocked 10/10, normal inputs unchanged 10/10.

The cause, in short: before 10.6p2, sshd accepted a password when `crypt(password, salt)` matched the stored entry,
and nothing else. On some musl systems built without PAM, that one comparison was not enough (the notes put the root
cause outside sshd). The fix adds a second rule: very short stored entries, which are never real hashes, never match.

## How to spot it on your own servers

- `ssh -V` and, on Alpine, `apk info -v openssh`. Look for a version below 10.6p2, unless your distro's advisory
  says the package is patched.
- `ldd --version 2>&1 | head -1` shows `musl` on Alpine and other musl images. glibc distros (Debian, Ubuntu,
  RHEL) and macOS are not the setup named in the notes.
- `sudo sshd -T | grep -iE '^(passwordauthentication|usepam)'` prints the values sshd really uses after all
  `Include` and default handling.
- `sudo sshd -T -C user=alice,host=x,addr=203.0.113.5 | grep -i passwordauthentication` shows the value for one
  user, including `Match` blocks. 203.0.113.5 is a documentation address, so use your own users and groups here.
- `grep -rniE '^\s*(passwordauthentication|match|include)' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/` shows
  where password login gets turned on. Cloud images often add a drop-in.
- Container images: check the base image tag (for example `alpine:3.x`) and rebuild after the package update.

## The fix

- Upgrade to OpenSSH 10.6p2 or your distro's patched package, then restart sshd:

```
apk update && apk upgrade openssh     # Alpine
rc-service sshd restart               # or: systemctl restart sshd
```

- If you cannot upgrade today, turn password login off and use keys. Put this at the top of `sshd_config`, because
  the first value wins, and remove any `PasswordAuthentication yes` from drop-ins and `Match` blocks:

```
PasswordAuthentication no
KbdInteractiveAuthentication no
```

- Before you restart, check that your own key login works in a second session, so you do not lock yourself out.
  Run `sshd -t` to test the config first.

## How to test the fix

- `ssh -V` (or `apk info -v openssh`) shows 10.6p2 or the patched package.
- `sudo sshd -T | grep -i passwordauthentication` prints `passwordauthentication no` if you used the mitigation.
  Also run the `-C user=...` form for users in each `Match` block.
- From another machine you own: `ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no you@your-server`
  should be refused with `Permission denied (publickey)` once password login is off. Key login should still work.
- Re-run this lab after changing the check. `RESULT: FIX WORKS` means every row behaved.

# apt-signature-lab lab: apt package signature checks, check and fix

Article: `apt-package-signature-flaw-check-and-fix`. News source: The Hacker News, 2026-11-04,
https://thehackernews.com/2026/11/debian-and-ubuntu-apt-flaw-lets-mitm.html. For the CVE number and the fixed apt
versions, use the official Debian (security-tracker.debian.org, DSA) and Ubuntu (ubuntu.com/security/notices, USN) records.

## Question

apt trusts a package because of a chain: a signed `InRelease` file lists the hash of the `Packages` index, and the
`Packages` index lists the hash of every `.deb`. If one link in that chain is skipped, does a changed package still get
accepted? And how do you check which apt version your own machines run, without changing anything?

## How to run

```
NODE_NO_WARNINGS=1 node labs/security/apt-signature-lab/apt-signature-lab.mjs
```

Node.js 22, no npm packages, no network. Builds a throwaway repo in a temp dir, deletes it at the end, finishes in
under a second. The keys come from fixed seeds and Ed25519 signatures are deterministic, so every run prints the same
table (only the date in the header changes). The lab clock is fixed at 2026-11-06 for the expiry check.

## What it does

1. Makes two throwaway keys: the repo key, and a second key for "another repo" that the machine also trusts.
2. Builds a small repo: `pool/hello_1.0.deb`, `pool/tool_2.1.deb`, `main/Packages` (lists each `.deb` SHA256) and
   `InRelease` (signed text that lists the `Packages` SHA256, with `Date` and `Valid-Until`).
3. Runs one verifier. The **fixed** column has every check on. Each **unsafe** row turns off exactly one check, named in
   the `test` column, and the `input` column says what was changed in the repo.
4. Prints the installed apt version, read-only (`apt-get --version`). On this Mac apt is not installed, so it prints the
   commands to run on your Debian or Ubuntu machines instead.

The signature format is a simplified stand-in for OpenPGP clearsigned files (apt verifies with `gpgv` or `sqv`). The
checks are the same ideas apt applies.

## What it shows

| test | input | unsafe | fixed |
|---|---|---|---|
| all checks on (control) | untouched repo | accept | accept |
| no .deb hash check | one .deb changed after signing | accept | reject |
| no index hash check | .deb + Packages changed together | accept | reject |
| reads unsigned text | text added outside the signed block | accept | reject |
| any key in keyring | signed by another trusted key | accept | reject |
| ignores Valid-Until | old index replayed (expired) | accept | reject |
| allows unsigned repo | signature removed | accept | reject |

The cause, in one line: a valid signature only protects the bytes it covers, and only if every hash after it is
compared. Each unsafe row breaks that in a different place.

## How to spot it in your own code or config

- Code that installs or mirrors packages (CI images, internal mirrors, update tools): look for a step that downloads a
  file named in an index but never compares its SHA256 with the signed value.
- Code that parses a clearsigned file with a regex or line loop over the whole file. Parse only the output of the
  verifier (the verified bytes), never text before or after the signature block.
- `sources.list` / `.sources` entries without `signed-by`, so any key in the global keyring is accepted for that repo.
- `[trusted=yes]`, `allow-insecure`, `Acquire::Check-Valid-Until "false"` or `--allow-unauthenticated` left in configs
  or Dockerfiles.

## The fix

- Update apt with the patched version from your distribution's security notice: `sudo apt update && sudo apt install --only-upgrade apt`.
- Pin each repo to its own key with `signed-by=/usr/share/keyrings/<repo>.gpg`.
- Remove `trusted=yes`, `allow-insecure` and `Check-Valid-Until false` from configs you own.
- In your own tools: verify the signature, then parse only the verified bytes, then compare every hash down the chain.

## How to test the fix

- Read-only version check on your own machines: `apt-get --version` and `apt-cache policy apt`, then compare with the
  fixed version listed in the DSA or USN.
- `grep -rn "trusted=yes\|allow-insecure\|Check-Valid-Until" /etc/apt/` should print nothing.
- For your own package tooling, copy the rows of this lab into its tests: every changed input must be rejected.

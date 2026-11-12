# sd-13 lab: You type google.com. What happens in 100 ms?

## Question

In a model of DNS with **assumed** round-trip times, how much of a 100 ms budget does a
fully cold lookup use, and how much does each cache layer (resolver referrals, resolver
answers, the OS cache) take off?

This is a study of modeled cache effects. It does not measure real DNS, and its numbers
are not an empirical answer about google.com or about any particular connection.

## How to run

```sh
node run.mjs
```

Node.js 22, no packages, no network. It finishes in well under a second and writes
`results.json` next to the script. The last line it prints is a single `RESULT {...}` line.

## What it does

`run.mjs` builds a small DNS system in memory on a virtual clock:

- **OS stub resolver** with its own cache (what your laptop keeps).
- **Recursive resolver** (like 1.1.1.1 or 8.8.8.8) with a TTL cache for answers and
  for "who serves this zone" referrals.
- **Root, TLD (.com, .org) and authoritative servers** that answer with a referral or
  a final answer.

Every query between them costs an assumed round trip with a fixed-seed random jitter
(plus or minus 15%, with an 8% chance of a slow spike). Three domains are modeled:
`google.com` (authoritative servers assumed close by, 9 ms, closer than the .com TLD at
14 ms), `wikipedia.org` (35 ms) and `a-small-shop.com` (a made-up site with one distant
name server, 110 ms). These numbers are picked to resemble a Tokyo home fiber line; they
are inputs, not findings.

Each case runs 20 times and reports the median and p95:

| Case | What is cached | What gets paid |
| --- | --- | --- |
| Cold full walk | nothing | you to resolver, root, TLD, authoritative |
| Negative-answer miss, referrals cached | root, TLD and domain referrals; not the answer for a random subdomain | you to resolver, authoritative (assumed NXDOMAIN reply) |
| Expired-answer miss, referrals cached | referrals still valid, the apex A record's TTL has run out | you to resolver, authoritative (successful apex answer) |
| Warm resolver hit | the answer, at the resolver | you to resolver only |
| OS cache hit | the answer, on your machine | nothing on the network |

About the negative-answer case: asking for a random subdomain only bypasses the
resolver's **answer** cache. It does not clear cached referrals, so the walk still starts
at the domain's own name servers. The model **assumes** every random subdomain gets
NXDOMAIN; in real DNS that is not guaranteed (wildcard records or real subdomains can
return an answer). It is also a different lookup from resolving the apex successfully,
which is why the expired-answer case is reported separately. In this model both cost
the same hops; in real DNS the negative answer is cached under different rules (SOA
minimum / negative TTL).

For the cold walk the lab also records the average time of each hop, which hop is the
largest for each domain, and the authoritative hop's share of the complete cold lookup.
That share is computed from unrounded totals (authoritative hop time divided by the full
lookup time, including the client-to-resolver trip and resolver processing), and only the
displayed percentage is rounded.

## What it shows

- In this model, a fully cold lookup of the distant-name-server site uses most of a
  100 ms budget, and there the authoritative hop is the biggest piece.
- Which hop dominates depends on the assumed distances. For the modeled `google.com`, the
  .com TLD hop (14 ms) is larger than the authoritative hop (9 ms); the script prints the
  largest hop for each domain rather than claiming one hop always wins.
- When the resolver already has the referrals, a miss pays only the last hop.
- A cached answer at the resolver costs about one short round trip, and an OS cache hit
  costs a fraction of a millisecond. In this model, each cache layer removes most of the
  lookup time.

## Limits (please read)

- **This is a simulation.** It shows the shape of the effect, not production numbers.
  Every latency comes from assumed RTTs and seeded jitter; no public resolver and no OS
  DNS implementation is exercised. Real values depend on your network, your resolver and
  where each name server lives.
- In the video, say "in a model with assumed latencies", never "DNS takes X ms" or
  "google.com resolves in X ms".
- The random-subdomain case assumes NXDOMAIN, and treats negative answers like positive
  ones apart from the TTL. Real negative caching follows its own rules.
- Not modeled: UDP packet loss and retries (a lost packet can add a full second),
  DNSSEC validation, TCP fallback, IPv6 (AAAA) queries running alongside A queries,
  CNAME chains, the browser's own DNS cache, prefetching, DoH/DoT, and resolver load.
- Timing real lookups (for example `dig +trace` or public resolvers) needs network
  access, which the lab rules do not allow, so this lab does not try.

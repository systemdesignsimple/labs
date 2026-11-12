// sd-13 lab: "You type google.com. What happens in 100 ms?"
// In-process DNS simulation on a virtual clock. No network, no packages, fixed seed.
// Models: OS stub cache -> recursive resolver (with TTL cache) -> root -> TLD -> authoritative.
// Latencies are ASSUMED round trips (picked to resemble a Tokyo home fiber line), not measurements.
// The question this answers: under these assumed latencies, how much does each cache layer save?
// It says nothing empirical about google.com or any particular connection.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SEED = 1313;
const TRIALS = 20;
const BUDGET_MS = 100;

// ---------- seeded RNG ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);

// One network round trip: base RTT with +-15% jitter and an 8% chance of a slow spike.
function rtt(base) {
  let v = base * (0.85 + 0.3 * rng());
  if (rng() < 0.08) v += base * (0.5 + rng());
  return v;
}

// ---------- virtual clock ----------
const clock = { now: 0 };

// ---------- modeled servers ----------
// rttMs = round trip from the recursive resolver to that server.
const CLIENT_TO_RESOLVER_MS = 7;   // home router -> public resolver (anycast, same city)
const RESOLVER_WORK_MS = 0.3;      // parse, cache lookup, build reply
const OS_CACHE_HIT_MS = 0.05;      // stub resolver answers from memory

const ZONES = {
  ".":   { label: "root",        rttMs: 6,   childTtl: 172800 },
  "com": { label: ".com TLD",    rttMs: 14,  childTtl: 172800 },
  "org": { label: ".org TLD",    rttMs: 22,  childTtl: 86400 },
  "google.com":       { label: "google.com authoritative",       rttMs: 9,   aTtl: 300 },
  "wikipedia.org":    { label: "wikipedia.org authoritative",    rttMs: 35,  aTtl: 600 },
  "a-small-shop.com": { label: "a-small-shop.com authoritative", rttMs: 110, aTtl: 3600 },
};

function parentZone(zone) {
  if (zone === ".") return null;
  const i = zone.indexOf(".");
  return i === -1 ? "." : zone.slice(i + 1);
}

// Authoritative zone of a name (the registered domain, e.g. x.google.com -> google.com).
function apexOf(name) {
  const parts = name.split(".");
  return parts.slice(-2).join(".");
}

// A server answers a query: either a referral to the next zone or a final answer.
function askServer(zone, name) {
  const apex = apexOf(name);
  const tld = apex.split(".").pop();
  if (zone === ".") return { type: "referral", zone: tld, ttl: ZONES["."].childTtl };
  if (zone === tld) return { type: "referral", zone: apex, ttl: ZONES[tld].childTtl };
  // Authoritative. MODEL ASSUMPTION: any non-apex name is NXDOMAIN. Real zones may have
  // wildcards or real subdomains, so a random subdomain does not guarantee NXDOMAIN.
  if (name === apex) return { type: "answer", ttl: ZONES[apex].aTtl, rcode: "NOERROR" };
  return { type: "answer", ttl: 60, rcode: "NXDOMAIN" };
}

// ---------- recursive resolver with a TTL cache ----------
class RecursiveResolver {
  constructor() { this.cache = new Map(); } // key -> expiresAt (virtual ms)
  cached(key) {
    const exp = this.cache.get(key);
    return exp !== undefined && exp > clock.now;
  }
  put(key, ttlSec) { this.cache.set(key, clock.now + ttlSec * 1000); }

  // Returns { ms, hops: [{label, ms}] } for one query arriving at the resolver.
  resolve(name) {
    const hops = [];
    let ms = RESOLVER_WORK_MS;
    if (this.cached("A:" + name)) return { ms, hops, cacheHit: true };

    // Start from the deepest zone whose nameservers we already know.
    let zone = apexOf(name);
    while (zone !== "." && !this.cached("NS:" + zone)) zone = parentZone(zone);

    for (;;) {
      const t = rtt(ZONES[zone].rttMs);
      ms += t;
      hops.push({ label: ZONES[zone].label, ms: t });
      const reply = askServer(zone, name);
      if (reply.type === "referral") {
        this.put("NS:" + reply.zone, reply.ttl);
        zone = reply.zone;
        continue;
      }
      this.put("A:" + name, reply.ttl);
      return { ms, hops, cacheHit: false };
    }
  }
}

// ---------- OS stub resolver with its own cache ----------
class StubResolver {
  constructor(resolver) { this.resolver = resolver; this.cache = new Map(); }
  lookup(name) {
    const exp = this.cache.get(name);
    if (exp !== undefined && exp > clock.now) {
      const ms = OS_CACHE_HIT_MS * (0.6 + 0.8 * rng());
      clock.now += ms;
      return { ms, layer: "os-cache", hops: [] };
    }
    const net = rtt(CLIENT_TO_RESOLVER_MS);
    const r = this.resolver.resolve(name);
    const ms = net + r.ms;
    clock.now += ms;
    this.cache.set(name, clock.now + 60_000);
    return { ms, layer: r.cacheHit ? "resolver-cache" : "walk", hops: r.hops, net };
  }
}

// ---------- experiment ----------
function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length / 2;
  const median = s.length % 2 ? s[Math.floor(mid)] : (s[mid - 1] + s[mid]) / 2;
  const p95 = s[Math.ceil(0.95 * s.length) - 1];
  return { median, p95 };
}
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;

const DOMAINS = ["google.com", "wikipedia.org", "a-small-shop.com"];
const results = { seed: SEED, trials: TRIALS, budgetMs: BUDGET_MS, domains: {} };

for (const domain of DOMAINS) {
  const cold = [], negMiss = [], expiredMiss = [], warm = [], os = [];
  const hopSums = {};
  let coldTotalSum = 0; // unrounded sum of complete cold lookups (network + resolver work)

  for (let i = 0; i < TRIALS; i++) {
    // 1) Cold full walk: brand-new resolver, nothing cached anywhere.
    {
      const stub = new StubResolver(new RecursiveResolver());
      const r = stub.lookup(domain);
      cold.push(r.ms);
      coldTotalSum += r.ms;
      hopSums["you -> resolver"] = (hopSums["you -> resolver"] ?? 0) + r.net;
      for (const h of r.hops) hopSums[h.label] = (hopSums[h.label] ?? 0) + h.ms;
    }

    // 2) Negative-answer cache miss with cached referrals: the resolver already holds the
    //    root, TLD and domain NS referrals (warmed by an earlier lookup). A random subdomain
    //    misses the ANSWER cache only; the referrals stay cached, so only the authoritative
    //    hop is paid. The model assumes the reply is NXDOMAIN (see askServer).
    {
      const resolver = new RecursiveResolver();
      new StubResolver(resolver).lookup(domain); // warm up NS records
      clock.now += 1000;
      const rand = "x" + Math.floor(rng() * 1e9).toString(36) + "." + domain;
      negMiss.push(new StubResolver(resolver).lookup(rand).ms);

      // 3) Warm resolver hit: ask again right away from a fresh OS (no OS cache).
      clock.now += 1000;
      warm.push(new StubResolver(resolver).lookup(domain).ms);

      // 4) OS cache hit: same machine asks a second time.
      const stub = new StubResolver(resolver);
      stub.lookup(domain);
      clock.now += 500;
      os.push(stub.lookup(domain).ms);
    }

    // 5) Expired-answer miss for the apex itself: the A record's TTL has run out but the
    //    NS referrals (much longer TTL) are still cached, so a successful apex lookup
    //    pays only the authoritative hop. This is the positive-answer counterpart of (2).
    {
      const resolver = new RecursiveResolver();
      new StubResolver(resolver).lookup(domain);
      clock.now += (ZONES[domain].aTtl + 1) * 1000;
      expiredMiss.push(new StubResolver(resolver).lookup(domain).ms);
    }
  }

  const hopAvg = Object.fromEntries(
    Object.entries(hopSums).map(([k, v]) => [k, r1(v / TRIALS)])
  );
  const authLabel = ZONES[domain].label;
  // Share of the COMPLETE cold lookup (incl. resolver work), from unrounded totals.
  const authShare = (hopSums[authLabel] / coldTotalSum) * 100;
  const [dominantHop, dominantSum] = Object.entries(hopSums).sort((a, b) => b[1] - a[1])[0];

  results.domains[domain] = {
    coldFullWalk: mapStats(stats(cold)),
    negativeMissCachedReferrals: mapStats(stats(negMiss)),
    expiredAnswerMissCachedReferrals: mapStats(stats(expiredMiss)),
    warmResolverHit: mapStats(stats(warm)),
    osCacheHit: { median: r2(stats(os).median), p95: r2(stats(os).p95) },
    coldHopsAvgMs: hopAvg,
    authoritativeShareOfColdPct: Math.round(authShare),
    dominantColdHop: dominantHop,
    dominantColdHopSharePct: Math.round((dominantSum / coldTotalSum) * 100),
  };
}

function mapStats(s) { return { median: r1(s.median), p95: r1(s.p95) }; }

const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(here, "results.json"), JSON.stringify(results, null, 2) + "\n");

// ---------- human-readable table ----------
console.log("sd-13 DNS lab (simulated, assumed latencies, seed " + SEED + ", " + TRIALS + " runs per case)");
console.log("domain              cold walk   neg miss    exp miss    warm hit    os cache   (median / p95 ms)");
for (const d of DOMAINS) {
  const x = results.domains[d];
  const cell = (s) => `${s.median} / ${s.p95}`.padEnd(12);
  console.log(
    d.padEnd(20) + cell(x.coldFullWalk) + cell(x.negativeMissCachedReferrals) +
    cell(x.expiredAnswerMissCachedReferrals) +
    cell(x.warmResolverHit) + cell(x.osCacheHit)
  );
  console.log("  cold hops: " + Object.entries(x.coldHopsAvgMs).map(([k, v]) => `${k} ${v}`).join(" | "));
  console.log(`  biggest cold hop: ${x.dominantColdHop} (${x.dominantColdHopSharePct}% of the cold lookup)`);
}
console.log("wrote results.json");

// ---------- RESULT line ----------
const g = results.domains["google.com"];
const s = results.domains["a-small-shop.com"];
const speedup = Math.round(s.coldFullWalk.median / s.warmResolverHit.median);
const smallSharePct = Math.round((s.coldFullWalk.median / BUDGET_MS) * 100);
const googleWarmPct = Math.round((g.warmResolverHit.median / BUDGET_MS) * 100);

const metrics = [
  { name: "google.com cold full walk, median", value: g.coldFullWalk.median, unit: "ms" },
  { name: "google.com cold full walk, p95", value: g.coldFullWalk.p95, unit: "ms" },
  { name: "google.com negative-answer miss, referrals cached (assumed NXDOMAIN), median", value: g.negativeMissCachedReferrals.median, unit: "ms" },
  { name: "google.com expired-answer miss, referrals cached, median", value: g.expiredAnswerMissCachedReferrals.median, unit: "ms" },
  { name: "google.com warm resolver hit, median", value: g.warmResolverHit.median, unit: "ms" },
  { name: "google.com OS cache hit, median", value: g.osCacheHit.median, unit: "ms" },
  { name: "a-small-shop.com cold full walk, median", value: s.coldFullWalk.median, unit: "ms" },
  { name: "a-small-shop.com cold full walk, p95", value: s.coldFullWalk.p95, unit: "ms" },
  { name: "google.com authoritative hop share of cold lookup", value: g.authoritativeShareOfColdPct, unit: "%" },
  { name: "a-small-shop.com authoritative hop share of cold lookup", value: s.authoritativeShareOfColdPct, unit: "%" },
  { name: "a-small-shop.com cold walk share of 100 ms budget", value: smallSharePct, unit: "%" },
  { name: "a-small-shop.com cold vs warm speedup", value: speedup, unit: "x" },
];

const conclusion =
  `Under these assumed latencies, a fully cold lookup of the modeled distant-name-server site takes ` +
  `about ${s.coldFullWalk.median} ms (${smallSharePct}% of a 100 ms budget, ${s.authoritativeShareOfColdPct}% ` +
  `of it the authoritative hop), while a cached answer for the modeled google.com costs about ` +
  `${g.warmResolverHit.median} ms at the resolver and ${g.osCacheHit.median} ms from the OS cache, ` +
  `so in this model each cache layer removes most of the lookup time.`;

const setup =
  `simulated, virtual clock, seed ${SEED}, ${TRIALS} runs per case; assumed (not measured) RTTs resembling Tokyo fiber: ` +
  `you->resolver ${CLIENT_TO_RESOLVER_MS} ms, root ${ZONES["."].rttMs}, .com ${ZONES.com.rttMs}, .org ${ZONES.org.rttMs}, ` +
  `auth google.com ${ZONES["google.com"].rttMs}, wikipedia.org ${ZONES["wikipedia.org"].rttMs}, ` +
  `a-small-shop.com ${ZONES["a-small-shop.com"].rttMs}; jitter +-15%, 8% slow spikes; no packet loss; ` +
  `random subdomains assumed NXDOMAIN`;

console.log("RESULT " + JSON.stringify({ metrics, conclusion, setup }));

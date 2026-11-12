// sd-60 lab: Security monitoring, the quiet login at 3 a.m.
// Fixed night rule vs per-user baseline on 30 days of synthetic logins.
// Node.js 22 ESM, standard library only, fixed seed, no network.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------- parameters ----------
const SEED = 60;
const N_USERS = 200;
const DAYS = 30;
const TRAIN_DAYS = 7;          // days 1 to 7 only build history; scoring is counted from day 8
const NIGHT_SHIFT_SHARE = 0.10;
const TRAVEL_SHARE = 0.25;
const NEW_PHONE_SHARE = 0.15;
const NOISE_SHARE = 0.03;      // honest logins at a random hour (insomnia, deadline, etc.)
const FIXED_RULE = { from: 1, to: 5 }; // alert on any login from 1:00 to 4:59
const THRESHOLD = 4;           // main per-user baseline threshold
const LOW_THRESHOLD = 2;       // a more sensitive setting, shown for comparison
const MIN_HISTORY = 5;         // logins needed before "unusual hour" is scored
const RARE_HOUR_SHARE = 0.05;  // under 5% of past logins within NEAR_HOURS on the clock = unusual
const NEAR_HOURS = 1;          // circular distance on the 24-hour clock
const FAST_TRAVEL_HOURS = 8;   // country change faster than this = too fast to travel
const WEIGHTS = { hour: 2, country: 3, device: 2, travel: 3 };
const ATTACK_PLAN = [
  ['loud', 12],        // stolen password at about 3 a.m., new country, new device
  ['foreign-day', 3],  // new country and new device, but at the user's normal hour
  ['quiet', 3],        // home country, normal hour, only the device is new
  ['mimic', 2],        // home country, normal hour, the user's own device (stolen session)
];

// ---------- seeded random ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const ri = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
function gauss() {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const mod24 = (h) => ((h % 24) + 24) % 24;

// UTC offsets. Hours are always shown in the account's home time zone,
// so a traveller's normal habits look shifted while abroad.
const OFFSET = { NP: 5.75, IN: 5.5, JP: 9, US: -5, GB: 0, DE: 1, AE: 4, AU: 10, BR: -3, SG: 8, RU: 3, NG: 1, CA: -5, FR: 1 };
const HOMES = ['NP', 'IN', 'JP', 'US', 'GB', 'DE', 'AE', 'AU'];
const toHomeHour = (localHour, here, home) => mod24(localHour - OFFSET[here] + OFFSET[home]);

// ---------- users ----------
const users = [];
for (let i = 0; i < N_USERS; i++) {
  const id = `u${String(i + 1).padStart(3, '0')}`;
  const home = pick(HOMES);
  const nightShift = rand() < NIGHT_SHIFT_SHARE;
  const center = nightShift ? 0.5 + rand() * 3 : 8 + rand() * 12;
  const spread = nightShift ? 1.2 : 1.5 + rand() * 2.5;
  const devices = [`${id}-laptop`];
  if (rand() < 0.6) devices.push(`${id}-phone`);
  let trip = null;
  if (rand() < TRAVEL_SHARE) {
    const start = ri(TRAIN_DAYS, DAYS - 5);                 // flight day, no logins
    const end = Math.min(DAYS - 2, start + ri(3, 6));        // last day abroad
    const dest = pick(Object.keys(OFFSET).filter((c) => c !== home));
    trip = { start, end, dest };                             // end + 1 is the flight home
  }
  let newPhone = null;
  if (rand() < NEW_PHONE_SHARE) newPhone = { day: ri(TRAIN_DAYS + 1, DAYS - 2), device: `${id}-newphone` };
  users.push({ id, home, nightShift, center, spread, devices, trip, newPhone });
}

function loginsToday() {
  const r = rand();
  if (r < 0.10) return 0;
  if (r < 0.40) return 1;
  if (r < 0.70) return 2;
  if (r < 0.90) return 3;
  return 4;
}

// ---------- honest logins ----------
const events = [];
for (const u of users) {
  for (let day = 0; day < DAYS; day++) {
    if (u.trip && (day === u.trip.start || day === u.trip.end + 1)) continue; // flying
    const abroad = u.trip && day > u.trip.start && day <= u.trip.end;
    const country = abroad ? u.trip.dest : u.home;
    let devs = u.devices;
    if (u.newPhone && day >= u.newPhone.day) devs = rand() < 0.75 ? [u.newPhone.device] : u.devices;
    const n = loginsToday();
    for (let k = 0; k < n; k++) {
      const local = mod24(rand() < NOISE_SHARE ? rand() * 24 : u.center + gauss() * u.spread);
      const homeHour = toHomeHour(local, country, u.home);
      const tag = abroad ? 'travel' : (u.newPhone && day >= u.newPhone.day ? 'new-phone' : (u.nightShift ? 'night-shift' : 'normal'));
      events.push({ t: day * 24 + homeHour, homeHour, user: u, country, device: pick(devs), truth: 'honest', tag });
    }
  }
}

// ---------- planted bad logins ----------
const attackTypes = ATTACK_PLAN.flatMap(([type, n]) => Array(n).fill(type));
const victims = shuffle(users).slice(0, attackTypes.length);
let atkNo = 0;
attackTypes.forEach((type, i) => {
  const u = victims[i];
  const day = ri(TRAIN_DAYS + 1, DAYS - 2);
  const usualHour = mod24(u.center + gauss() * u.spread * 0.5);
  const foreign = pick(Object.keys(OFFSET).filter((c) => c !== u.home && (!u.trip || c !== u.trip.dest)));
  let homeHour, country, device;
  if (type === 'loud') { homeHour = 2 + rand() * 2.99; country = foreign; device = `attacker-${++atkNo}`; }
  else if (type === 'foreign-day') { homeHour = usualHour; country = foreign; device = `attacker-${++atkNo}`; }
  else if (type === 'quiet') { homeHour = usualHour; country = u.home; device = `attacker-${++atkNo}`; }
  else { homeHour = usualHour; country = u.home; device = pick(u.devices); }
  events.push({ t: day * 24 + homeHour, homeHour, user: u, country, device, truth: 'attack', tag: type });
});

events.sort((a, b) => a.t - b.t);

// ---------- detectors ----------
const hist = new Map();
for (const u of users) hist.set(u.id, { times: [], total: 0, countries: new Map(), devices: new Set(), last: null });

function usualCountry(h) {
  let best = null, n = -1;
  for (const [c, k] of h.countries) if (k > n) { best = c; n = k; }
  return best;
}

const scored = [];
for (const e of events) {
  const h = hist.get(e.user.id);
  const hour = Math.floor(e.homeHour) % 24;
  const reasons = [];
  let score = 0;
  if (h.total >= MIN_HISTORY) {
    // exact circular distance, so 23:30 and 00:15 are 45 minutes apart
    let near = 0;
    for (const past of h.times) {
      const d = Math.abs(past - e.homeHour);
      if (Math.min(d, 24 - d) <= NEAR_HOURS) near++;
    }
    if (near / h.total < RARE_HOUR_SHARE) { score += WEIGHTS.hour; reasons.push('unusual hour'); }
  }
  if (!h.countries.has(e.country)) { score += WEIGHTS.country; reasons.push('new country'); }
  if (!h.devices.has(e.device)) { score += WEIGHTS.device; reasons.push('new device'); }
  if (h.last && e.country !== h.last.country && e.country !== usualCountry(h) && e.t - h.last.t < FAST_TRAVEL_HOURS) {
    score += WEIGHTS.travel; reasons.push('too fast to travel');
  }
  const fixedAlert = hour >= FIXED_RULE.from && hour < FIXED_RULE.to;

  // the system cannot tell honest from bad, so every login joins the history
  h.times.push(e.homeHour); h.total++;
  h.countries.set(e.country, (h.countries.get(e.country) || 0) + 1);
  h.devices.add(e.device);
  h.last = { t: e.t, country: e.country };

  if (Math.floor(e.t / 24) >= TRAIN_DAYS) scored.push({ ...e, hour, score, reasons, fixedAlert });
}

// ---------- measure ----------
const attacks = scored.filter((e) => e.truth === 'attack');
const honest = scored.filter((e) => e.truth === 'honest');
const perK = (n) => Math.round((n / scored.length) * 1000 * 10) / 10;

function measure(alertFn) {
  const caught = attacks.filter(alertFn).length;
  const fa = honest.filter(alertFn);
  const byType = {};
  for (const [type] of ATTACK_PLAN) byType[type] = attacks.filter((e) => e.tag === type && alertFn(e)).length;
  const faByTag = {};
  for (const e of fa) faByTag[e.tag] = (faByTag[e.tag] || 0) + 1;
  // by user, not by event tag: a night-shift user who travels is still a night-shift user
  const faNightShiftUsers = fa.filter((e) => e.user.nightShift).length;
  const alerts = caught + fa.length;
  return { caught, missed: attacks.length - caught, fa: fa.length, faPerK: perK(fa.length), alerts,
    precision: alerts ? Math.round((caught / alerts) * 1000) / 10 : 0, byType, faByTag, faNightShiftUsers };
}
const fixedFn = (e) => e.fixedAlert;
const baseFn = (e) => e.score >= THRESHOLD;
const lowFn = (e) => e.score >= LOW_THRESHOLD;
const F = measure(fixedFn), B = measure(baseFn), L = measure(lowFn);
const missedBothRows = attacks.filter((e) => !fixedFn(e) && !baseFn(e));
const missedBoth = missedBothRows.length;
const missedBothByType = {};
for (const [type] of ATTACK_PLAN) missedBothByType[type] = missedBothRows.filter((e) => e.tag === type).length;
const missedBothText = Object.entries(missedBothByType).filter(([, n]) => n > 0).map(([t, n]) => `${n} ${t}`).join(', ') || 'none';

// ---------- save rows for the video ----------
const fmtTime = (e) => {
  const d = Math.floor(e.t / 24) + 1;
  const hh = String(Math.floor(e.homeHour)).padStart(2, '0');
  const mm = String(Math.floor((e.homeHour % 1) * 60)).padStart(2, '0');
  return [d, `${hh}:${mm}`];
};
const csv = (rows) => rows.map((r) => r.map((c) => (/[",]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(',')).join('\n') + '\n';
const header = ['day', 'time_home_tz', 'user', 'home', 'country', 'device', 'score', 'reasons', 'truth', 'kind'];
const row = (e) => [...fmtTime(e), e.user.id, e.user.home, e.country, e.device, e.score, e.reasons.join(' + ') || '-', e.truth, e.tag];

writeFileSync(join(HERE, 'alerts-fixed-rule.csv'), csv([header, ...scored.filter(fixedFn).map(row)]));
writeFileSync(join(HERE, 'alerts-baseline.csv'), csv([header, ...scored.filter(baseFn).map(row)]));
writeFileSync(join(HERE, 'planted-attacks.csv'), csv([
  [...header, 'fixed_rule_caught', 'baseline_caught'],
  ...attacks.map((e) => [...row(e), fixedFn(e) ? 'yes' : 'no', baseFn(e) ? 'yes' : 'no']),
]));

// ---------- report ----------
const line = (name, m) => `${name.padEnd(26)} caught ${String(m.caught).padStart(2)}/${attacks.length}  missed ${String(m.missed).padStart(2)}  false alarms ${String(m.fa).padStart(4)} (${m.faPerK}/1000)  alerts that were real ${m.precision}%`;
console.log(`Synthetic data: ${N_USERS} users, ${DAYS} days, ${events.length} logins; scored days ${TRAIN_DAYS + 1} to ${DAYS}: ${scored.length} logins, ${attacks.length} planted bad logins`);
console.log(line('Fixed rule 1 to 5 a.m.', F), JSON.stringify(F.byType), 'false alarms by kind', JSON.stringify(F.faByTag));
console.log(line(`Baseline, score >= ${THRESHOLD}`, B), JSON.stringify(B.byType), 'false alarms by kind', JSON.stringify(B.faByTag));
console.log(line(`Baseline, score >= ${LOW_THRESHOLD}`, L), JSON.stringify(L.byType), 'false alarms by kind', JSON.stringify(L.faByTag));
console.log(`Missed by both main detectors: ${missedBoth} (${missedBothText}). False alarms on night-shift users: fixed ${F.faNightShiftUsers}, baseline ${B.faNightShiftUsers}.`);
console.log(`Rows saved: alerts-fixed-rule.csv, alerts-baseline.csv, planted-attacks.csv`);

const nightShare = F.fa ? Math.round((F.faNightShiftUsers / F.fa) * 1000) / 10 : 0;
const result = {
  metrics: [
    { name: 'logins_scored', value: scored.length, unit: 'logins' },
    { name: 'bad_logins_planted', value: attacks.length, unit: 'logins' },
    { name: 'fixed_rule_caught', value: F.caught, unit: 'logins' },
    { name: 'fixed_rule_missed', value: F.missed, unit: 'logins' },
    { name: 'fixed_rule_false_alarms_per_1000', value: F.faPerK, unit: 'per 1000 logins' },
    { name: 'fixed_rule_false_alarms_on_night_shift_users', value: nightShare, unit: '%' },
    { name: 'fixed_rule_alerts_that_were_real', value: F.precision, unit: '%' },
    { name: 'baseline_caught', value: B.caught, unit: 'logins' },
    { name: 'baseline_missed', value: B.missed, unit: 'logins' },
    { name: 'baseline_false_alarms_per_1000', value: B.faPerK, unit: 'per 1000 logins' },
    { name: 'baseline_alerts_that_were_real', value: B.precision, unit: '%' },
    { name: 'baseline_low_threshold_caught', value: L.caught, unit: 'logins' },
    { name: 'baseline_low_threshold_false_alarms_per_1000', value: L.faPerK, unit: 'per 1000 logins' },
    { name: 'missed_by_both', value: missedBoth, unit: 'logins' },
    ...ATTACK_PLAN.map(([type]) => ({ name: `missed_by_both_${type.replace('-', '_')}`, value: missedBothByType[type], unit: 'logins' })),
  ],
  conclusion: `On synthetic logins the per-user baseline caught ${B.caught} of ${attacks.length} planted bad logins with ${B.faPerK} false alarms per 1,000 logins, while the fixed 1 to 5 a.m. rule caught ${F.caught} with ${F.faPerK} per 1,000, and ${missedBoth} bad logins got past both (by planted type: ${missedBothText}).`,
  setup: `seed ${SEED}; ${N_USERS} users x ${DAYS} days, first ${TRAIN_DAYS} days history only; ${Math.round(NIGHT_SHIFT_SHARE * 100)}% night shift, ${Math.round(TRAVEL_SHARE * 100)}% travel, ${Math.round(NEW_PHONE_SHARE * 100)}% new phone, ${Math.round(NOISE_SHARE * 100)}% random-hour noise; attacks ${ATTACK_PLAN.map(([t, n]) => `${n} ${t}`).join(', ')}; fixed rule hour ${FIXED_RULE.from} to ${FIXED_RULE.to}; baseline weights hour ${WEIGHTS.hour}, country ${WEIGHTS.country}, device ${WEIGHTS.device}, fast travel ${WEIGHTS.travel} (<${FAST_TRAVEL_HOURS}h), unusual hour = under ${RARE_HOUR_SHARE * 100}% of past logins within ${NEAR_HOURS}h on the clock; alert at score >= ${THRESHOLD} (more sensitive >= ${LOW_THRESHOLD} also shown)`,
};
console.log('RESULT ' + JSON.stringify(result));

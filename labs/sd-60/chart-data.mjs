// sd-60 chart data for the video and the article. Runs run.mjs unchanged (same seed, same numbers) with a few lines
// appended that print the per-hour picture the charts need, then writes chart-data.json. Nothing in run.mjs changes.
//   node chart-data.mjs
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, 'run.mjs'), 'utf8');
const dump = `
// ---- appended by chart-data.mjs ----
{
  const bins = (rows) => { const b = Array(24).fill(0); for (const e of rows) b[e.hour]++; return b; };
  const honestDay = honest.filter((e) => !e.user.nightShift), honestNight = honest.filter((e) => e.user.nightShift);
  const fixedFa = honest.filter(fixedFn);
  // one night-shift user who signs in near 3 a.m. at home, on their own device, and whom the baseline leaves alone
  const quiet3 = honest.filter((e) => e.user.nightShift && e.hour === 3 && e.score === 0 && e.tag === 'night-shift')
    .sort((a, b) => a.t - b.t)[0];
  const u = quiet3.user;
  const mine = events.filter((e) => e.user.id === u.id && e.truth === 'honest');
  const userBins = Array(24).fill(0); for (const e of mine) userBins[Math.floor(e.homeHour) % 24]++;
  const hh = (x) => String(Math.floor(x)).padStart(2, '0') + ':' + String(Math.floor((x % 1) * 60)).padStart(2, '0');
  console.log('CHARTDATA ' + JSON.stringify({
    scored_by_hour_honest_day_workers: bins(honestDay), scored_by_hour_honest_night_shift_users: bins(honestNight),
    scored_by_hour_attacks: bins(attacks),
    fixed_false_alarms: fixedFa.length, fixed_false_alarms_night_shift_users: fixedFa.filter((e) => e.user.nightShift).length,
    baseline_false_alarms: honest.filter(baseFn).length, low_false_alarms: honest.filter(lowFn).length,
    fixed_alerts: scored.filter(fixedFn).length, baseline_alerts: scored.filter(baseFn).length,
    example_user: { id: u.id, home: u.home, night_shift: u.nightShift, devices: u.devices, honest_logins_all_days: mine.length,
      logins_by_hour_all_days: userBins, example_login: { day: Math.floor(quiet3.t / 24) + 1, time_home_tz: hh(quiet3.homeHour),
      country: quiet3.country, device: quiet3.device, score: quiet3.score, fixed_rule_alert: quiet3.fixedAlert } },
  }));
}
`;
const tmp = join(HERE, '.chart-data-run.mjs');
writeFileSync(tmp, src + dump);
let out;
try { out = execFileSync(process.execPath, [tmp], { encoding: 'utf8' }); } finally { rmSync(tmp, { force: true }); }
const data = JSON.parse(out.split('\n').find((l) => l.startsWith('CHARTDATA ')).slice(10));
const result = JSON.parse(out.split('\n').find((l) => l.startsWith('RESULT ')).slice(7));
writeFileSync(join(HERE, 'chart-data.json'), JSON.stringify(data, null, 1) + '\n');
writeFileSync(join(HERE, 'results.json'), JSON.stringify(result, null, 1) + '\n');
writeFileSync(join(HERE, 'run-output.txt'), out.split('\n').filter((l) => !l.startsWith('CHARTDATA ')).join('\n'));
console.log(JSON.stringify(data, null, 1));

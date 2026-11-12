# sd-60 lab: the quiet login at 3 a.m.

## Question

If we learn each user's normal login pattern, how many hidden bad logins does it catch compared with one fixed rule like "alert on any login between 1 and 5 a.m.", and how many false alarms does each raise?

## How to run

```
node run.mjs
```

Node.js 22, no packages, no network. Runs in well under a second. The seed is fixed (60), so every run gives the same numbers.

## What it does

1. **Makes 30 days of synthetic logins for 200 users.** Each user has a home country, usual hours, and one or two devices. Normal life is mixed in:
   - about 10% work night shifts, so their normal logins fall between midnight and 4 a.m.
   - about 25% take a trip abroad. They don't log in on flight days, and abroad their habits show up shifted in their home time zone.
   - about 15% get a new phone partway through the month.
   - 3% of honest logins happen at a random hour.
2. **Plants 20 bad logins** on days 9 to 29 (day 1 is the first day):
   - 12 **loud**: stolen password used at about 3 a.m. from a new country on a new device
   - 3 **foreign-day**: new country and new device, but at the user's normal hour
   - 3 **quiet**: home country, normal hour, only the device is new
   - 2 **mimic**: home country, normal hour, the user's own device (think stolen session)
3. **Runs two detectors over the same log, in time order:**
   - **Fixed rule:** alert on any login from 1:00 to 4:59 (account home time).
   - **Per-user baseline:** scores each login against that user's own history only. Unusual hour +2: fewer than 5% of the user's past logins fall within 1 hour of this login's time on the 24-hour clock, measured as exact circular distance (so 23:30 and 00:15 are 45 minutes apart); it is only scored once the user has 5 past logins. New country +3, new device +2, too fast to travel (a country change in under 8 hours, away from the usual country) +3. Alert at score 4 or more. The lab also shows a more sensitive setting (score 2 or more, so more logins alert) to make the trade-off visible.
4. **Measures** on days 8 to 30 (days 1 to 7 only build history): bad logins caught, bad logins missed, false alarms per 1,000 logins, and the share of alerts that were real.

## What it shows

- How the fixed night rule does on loud attacks, and what share of its false alarms land on night-shift users (counted by the user's night-shift flag, so it includes night-shift users who are travelling or on a new phone).
- How the per-user baseline does on the same attacks, and which honest logins it still flags (usually a traveller's first login abroad, or a new phone at an odd hour).
- How many planted bad logins got past both detectors, broken down by planted type (`missed_by_both_<type>` metrics). The conclusion only names the types that were actually missed. Lowering the threshold catches more but raises more false alarms.

Output files, for real rows in the video:

- `alerts-fixed-rule.csv`: every alert from the fixed rule
- `alerts-baseline.csv`: every alert from the baseline (score 4 or more), with the reasons
- `planted-attacks.csv`: each planted bad login and whether each detector caught it

The last line printed is `RESULT {...}` with the metrics, a one-sentence conclusion built from the numbers, and the setup.

## Limits (please read)

- **All data is synthetic.** The users, habits, trips and attacks are made up by a seeded random generator. The lab shows the shape of the effect, not numbers you would see in a real company.
- The attack mix is our choice. More quiet attacks would make both detectors look worse. More loud ones would make the fixed rule look better.
- Weights and the threshold were set by hand, not tuned on real data. Real systems also use IP reputation, device fingerprints, failed-login bursts, MFA results and analyst feedback, which this lab leaves out.
- Every login, including bad ones, joins the user's history, as it would in a real system that cannot tell them apart. An attacker who logs in many times would slowly become "normal". This lab plants single logins, so it does not show that drift.
- Time zones are simplified (fixed offsets, no daylight saving), and honest logins come from a simple bell curve around each user's usual hour.
- False alarms are counted per login. A real team would count alerts per user per day and would merge repeats.

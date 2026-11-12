// ai-14 lab: Move 1 button. Can AI still finish the task?
// Simulates a small settings page and three bots in-process, with fixed seeds.
// No browser, no screenshots, no image OCR: the looking bots get simulated label observations
// (read from page state) with injected errors.
// Node.js 22 ESM, standard library only. No network, no files, no child processes.

const SEED = 1406;
const RUNS = 50;          // runs where one button moves
const CONTROL = 10;       // runs on the original layout (sanity check)
const P_POPUP = 0.3;      // chance a popup covers the moved button area
// Errors injected into simulated label observations (assumed, not measured).
const OBS = { miss: 0.06, misplace: 0.04, jitter: 6, misplaceMin: 40, misplaceMax: 120 };
const P_CHECK_WRONG = 0.03; // chance a post-action check misjudges the observation
const MAX_DISMISS = 2;      // popup dismiss clicks a looking bot may make per step
const COST = { click: 150, type: 600, settle: 300, observe: 1300 }; // simulated ms, assumed
const NAME = 'Calm R';

// ---------- helpers ----------
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const inside = (b, x, y) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h;
const center = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const overlap = (a, b, m) =>
  a.x < b.x + b.w + m && b.x < a.x + a.w + m && a.y < b.y + b.h + m && b.y < a.y + a.h + m;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : 0);
const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);
const r2 = (x) => Math.round(x * 100) / 100;

// ---------- the page ----------
const PANEL = { x: 20, y: 80, w: 360, h: 600 };
const TITLE = { x: 40, y: 90, w: 160, h: 30 };
const TOAST = { x: 140, y: 640, w: 120, h: 36 };
const BASE = {
  settings: { x: 300, y: 20, w: 80, h: 36 },
  toggle: { x: 220, y: 140, w: 140, h: 36 },
  name: { x: 40, y: 240, w: 320, h: 40 },
  cancel: { x: 40, y: 600, w: 100, h: 40 },
  save: { x: 260, y: 600, w: 100, h: 40 },
};

function makeLayout(r, kind) {
  const L = structuredClone(BASE);
  let moved = null;
  let popup = null;
  if (kind === 'move') {
    moved = r() < 0.5 ? 'save' : 'toggle';
    const b = L[moved];
    const others = ['toggle', 'name', 'cancel', 'save'].filter((k) => k !== moved).map((k) => L[k]);
    others.push(TITLE);
    for (let i = 0; i < 1000; i++) {
      const x = PANEL.x + 10 + Math.floor(r() * (PANEL.w - 20 - b.w));
      const y = PANEL.y + 50 + Math.floor(r() * (PANEL.h - 60 - b.h));
      const c = { x, y, w: b.w, h: b.h };
      if (!others.some((o) => overlap(c, o, 8))) { L[moved] = c; break; }
    }
    if (r() < P_POPUP) {
      const c = center(L[moved]);
      const pw = 260, ph = 140;
      popup = {
        x: clamp(c.x - pw / 2, PANEL.x, PANEL.x + PANEL.w - pw),
        y: clamp(c.y - ph / 2, PANEL.y, PANEL.y + PANEL.h - ph),
        w: pw, h: ph,
      };
      popup.btn = { x: popup.x + popup.w - 100, y: popup.y + popup.h - 48, w: 84, h: 36 };
    }
  }
  return { L, moved, popup };
}

class Page {
  constructor(layout) {
    this.L = layout.L;
    this.popupBox = layout.popup;
    this.popupShown = false;
    this.popupOpen = false;
    this.panelOpen = false;
    this.dark = false;
    this.name = '';
    this.focus = null;
    this.saved = null;
    this.log = [];
  }
  hit(x, y) {
    if (this.popupOpen) {
      if (inside(this.popupBox.btn, x, y)) return 'popup.gotit';
      if (inside(this.popupBox, x, y)) return 'popup.body';
    }
    if (this.panelOpen) {
      for (const k of ['toggle', 'name', 'cancel', 'save']) if (inside(this.L[k], x, y)) return k;
      if (inside(PANEL, x, y)) return 'panel.empty';
    }
    if (inside(this.L.settings, x, y)) return 'settings';
    return 'empty';
  }
  click(x, y) {
    const id = this.hit(x, y);
    this.focus = id === 'name' ? 'name' : null;
    switch (id) {
      case 'settings':
        if (!this.panelOpen) {
          this.panelOpen = true;
          if (this.popupBox && !this.popupShown) { this.popupOpen = true; this.popupShown = true; }
        }
        break;
      case 'popup.gotit': this.popupOpen = false; break;
      case 'toggle': this.dark = !this.dark; break;
      case 'cancel': this.panelOpen = false; this.dark = false; this.name = ''; break;
      case 'save': this.saved = { dark: this.dark, name: this.name }; this.panelOpen = false; break;
    }
    this.log.push(`click(${Math.round(x)},${Math.round(y)}) -> ${id}`);
    return id;
  }
  type(text) {
    if (this.focus === 'name') { this.name += text; this.log.push(`type "${text}" -> name field`); }
    else this.log.push(`type "${text}" -> nowhere (no field focused)`);
  }
  // Labelled boxes a viewer could see, with popup occlusion. Source for simulated observations.
  visible() {
    const items = [{ id: 'settings', text: 'Settings', box: this.L.settings }];
    if (this.saved) items.push({ id: 'toast', text: 'Saved', box: TOAST });
    if (this.panelOpen) {
      items.push(
        { id: 'title', text: 'Preferences', box: TITLE },
        { id: 'toggle', text: `Dark mode ${this.dark ? 'On' : 'Off'}`, box: this.L.toggle },
        { id: 'name', text: this.name || 'Name', box: this.L.name },
        { id: 'cancel', text: 'Cancel', box: this.L.cancel },
        { id: 'save', text: 'Save', box: this.L.save },
      );
    }
    let shown = items;
    if (this.popupOpen) {
      shown = items.filter((it) => { const c = center(it.box); return !inside(this.popupBox, c.x, c.y); });
      shown.push(
        { id: 'popup.body', text: 'We updated our terms', box: this.popupBox },
        { id: 'popup.gotit', text: 'Got it', box: this.popupBox.btn },
      );
    }
    return shown;
  }
  success() { return !!this.saved && this.saved.dark === true && this.saved.name === NAME; }
}

// Simulated label observation. This is NOT image OCR and nothing is screenshotted: it reads labels and
// boxes straight from page.visible() (internal page state, with popup occlusion) and then injects errors
// (missed labels, misplaced labels, position jitter). The bots receive only text + position, never
// element ids, but the observation itself comes from page state.
function observe(page, r) {
  return page.visible().map((it) => {
    const u = r();
    if (u < OBS.miss) return null;
    let c = center(it.box);
    if (u < OBS.miss + OBS.misplace) {
      const ang = r() * 2 * Math.PI;
      const d = OBS.misplaceMin + r() * (OBS.misplaceMax - OBS.misplaceMin);
      c = { x: c.x + Math.cos(ang) * d, y: c.y + Math.sin(ang) * d };
    } else {
      c = { x: c.x + (r() * 2 - 1) * OBS.jitter, y: c.y + (r() * 2 - 1) * OBS.jitter };
    }
    return { text: it.text, x: c.x, y: c.y };
  }).filter(Boolean);
}

// ---------- Bot A: replay clicks recorded on the original layout ----------
function botA(page) {
  const rec = [['click', 'settings'], ['click', 'toggle'], ['click', 'name'], ['type'], ['click', 'save']];
  let steps = 0, t = 0, wrong = 0;
  for (const [op, k] of rec) {
    steps++;
    if (op === 'type') { page.type(NAME); t += COST.type; continue; }
    const c = center(BASE[k]);
    const hit = page.click(c.x, c.y);
    t += COST.click + COST.settle;
    if (hit !== k) wrong++;
  }
  return {
    declared: true, steps, obs: 0, t, wrong, dismissClicks: 0, dismissWrong: 0,
    caught: 0, failedChecksOnHit: 0, falseAlarms: 0, retries: 0,
  };
}

// ---------- Bot B (observe, act, check) and Bot C (observe, act, no check) ----------
// Same code, same observation error rates, same seed per run. The only difference: Bot C never observes
// after an action, so it never verifies a step or a popup close and never retries after acting.
const has = (s, text) => s.some((i) => i.text === text);
const GOALS = [
  { label: 'Settings', intend: 'settings', done: (s) => has(s, 'Preferences') },
  { label: 'Dark mode', intend: 'toggle', match: (t) => t.startsWith('Dark mode'), done: (s) => has(s, 'Dark mode On') },
  { label: 'Name', intend: 'name', type: NAME, done: (s) => has(s, NAME) },
  { label: 'Save', intend: 'save', done: (s) => has(s, 'Saved') },
];
const POPUP_GONE = (s) => !has(s, 'Got it');

function botLook(page, r, check) {
  const tag = check ? 'botB' : 'botC';
  let steps = 0, obs = 0, t = 0, wrong = 0, caught = 0, retries = 0;
  let dismissClicks = 0, dismissWrong = 0, failedChecksOnHit = 0, falseAlarms = 0;
  const look = () => { obs++; t += COST.observe; return observe(page, r); };
  const verdict = (s, done) => { let v = done(s); if (r() < P_CHECK_WRONG) v = !v; return v; };
  const truth = (done) => done(page.visible()); // evaluator only; the bot never uses this
  const click = (x, y) => { steps++; t += COST.click + COST.settle; return page.click(x, y); };
  const out = (declared, failedAt) => ({
    declared, failedAt, steps, obs, t, wrong, dismissClicks, dismissWrong,
    caught, failedChecksOnHit, falseAlarms, retries,
  });
  // Post-action check (Bot B only): observe again and judge the expected change.
  const judge = (hit, intend, done, what) => {
    const v = verdict(look(), done);
    if (hit !== intend) {
      if (!v) caught++;
      else page.log.push(`${tag}: check missed a wrong click on "${what}"`);
    } else if (!v) {
      failedChecksOnHit++;
      if (truth(done)) falseAlarms++; // goal really reached, the check misjudged
    }
    return v;
  };

  for (const g of GOALS) {
    let ok = false, attempts = 0, dismissals = 0;
    while (!ok && attempts < 2) {
      const s = look();
      if (check && attempts > 0 && verdict(s, g.done)) { ok = true; break; } // already done before acting again
      const dismiss = s.find((i) => i.text === 'Got it');
      if (dismiss && dismissals < MAX_DISMISS) {
        dismissals++; dismissClicks++;
        const hit = click(dismiss.x, dismiss.y);
        if (hit !== 'popup.gotit') { wrong++; dismissWrong++; }
        if (check) {
          const gone = judge(hit, 'popup.gotit', POPUP_GONE, 'Got it');
          page.log.push(`${tag}: clicked "Got it", observed popup ${gone ? 'gone' : 'still there'}`);
        } else {
          page.log.push(`${tag}: clicked "Got it", outcome not checked`);
        }
        continue;
      }
      attempts++;
      if (attempts > 1) retries++;
      const target = s.find((i) => (g.match ? g.match(i.text) : i.text === g.label));
      if (!target) { page.log.push(`${tag}: "${g.label}" not found in observation`); continue; }
      const hit = click(target.x, target.y);
      if (hit !== g.intend) wrong++;
      if (g.type) { steps++; t += COST.type; page.type(g.type); }
      ok = check ? judge(hit, g.intend, g.done, g.label) : true;
    }
    if (!ok) { page.log.push(`${tag}: gave up at "${g.label}"`); return out(false, g.label); }
  }
  return out(true, null);
}

// ---------- run ----------
function runSet(kind, n, seedOffset) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const layoutSeed = SEED + seedOffset + i * 7919;
    const layout = makeLayout(rng(layoutSeed), kind);
    const botSeed = layoutSeed ^ 0x9e3779b9;
    const pa = new Page(layout);
    const a = botA(pa);
    const pb = new Page(layout);
    const b = botLook(pb, rng(botSeed), true);
    const pc = new Page(layout);
    const c = botLook(pc, rng(botSeed), false);
    rows.push({
      run: `${kind}-${i + 1}`, moved: layout.moved, popup: !!layout.popup,
      a: { ...a, ok: pa.success(), log: pa.log },
      b: { ...b, ok: pb.success(), log: pb.log },
      c: { ...c, ok: pc.success(), log: pc.log },
    });
  }
  return rows;
}

const moved = runSet('move', RUNS, 0);
const control = runSet('control', CONTROL, 100000);
const popupRuns = moved.filter((x) => x.popup);

function stats(k) {
  const ok = moved.filter((x) => x[k].ok).length;
  const sec = avg(moved.map((x) => x[k].t)) / 1000;
  return {
    ok,
    silent: moved.filter((x) => x[k].declared && !x[k].ok).length,
    noticed: moved.filter((x) => !x[k].declared && !x[k].ok).length,
    gaveUpButSaved: moved.filter((x) => !x[k].declared && x[k].ok).length,
    popupOk: popupRuns.filter((x) => x[k].ok).length,
    ctl: control.filter((x) => x[k].ok).length,
    wrong: sum(moved, (x) => x[k].wrong),
    dismissClicks: sum(moved, (x) => x[k].dismissClicks),
    dismissWrong: sum(moved, (x) => x[k].dismissWrong),
    caught: sum(moved, (x) => x[k].caught),
    failedChecksOnHit: sum(moved, (x) => x[k].failedChecksOnHit),
    falseAlarms: sum(moved, (x) => x[k].falseAlarms),
    retries: sum(moved, (x) => x[k].retries),
    steps: avg(moved.map((x) => x[k].steps)),
    obs: avg(moved.map((x) => x[k].obs)),
    sec,
  };
}
const A = stats('a'), B = stats('b'), C = stats('c');

console.log(`ai-14 lab: ${RUNS} moved-button runs (${popupRuns.length} with a popup), ${CONTROL} control runs, seed ${SEED}`);
console.log('All observations are simulated from page state with injected errors; no browser, screenshot or OCR.');
console.log(`control (nothing moved): Bot A ${A.ctl}/${CONTROL}, Bot C ${C.ctl}/${CONTROL}, Bot B ${B.ctl}/${CONTROL}`);
for (const [name, S] of [['Bot A replay          ', A], ['Bot C observe, no check', C], ['Bot B observe + check ', B]]) {
  console.log(`moved: ${name} success ${S.ok}/${RUNS}  silent failures ${S.silent}  noticed failures ${S.noticed}  ` +
    `wrong clicks ${S.wrong} (of them popup-dismiss ${S.dismissWrong} of ${S.dismissClicks} dismiss clicks; caught ${S.caught})  ` +
    `steps ${r2(S.steps)}  observations ${r2(S.obs)}  time ${r2(S.sec)} s  popup runs ${S.popupOk}/${popupRuns.length}`);
}
console.log(`Bot B: retries ${B.retries}; failed checks after intended-target hits ${B.failedChecksOnHit} ` +
  `(actual false alarms by evaluator truth ${B.falseAlarms}); gave up though page saved ${B.gaveUpButSaved}`);
const bFails = moved.filter((x) => !x.b.ok || !x.b.declared);
if (bFails.length) {
  console.log('Bot B runs that did not end cleanly (page log, last lines):');
  for (const x of bFails) {
    const why = x.b.declared ? 'SILENT: said done, page disagrees' : x.b.ok ? `gave up at "${x.b.failedAt}" but page had saved` : `gave up at "${x.b.failedAt}"`;
    console.log(`  ${x.run} moved=${x.moved} popup=${x.popup} ${why}`);
    for (const line of x.b.log.slice(-4)) console.log(`    ${line}`);
  }
}

const ratio = A.sec ? Math.round((B.sec / A.sec) * 10) / 10 : 0;
const result = {
  metrics: [
    { name: 'Bot A (replay clicks) success, moved runs', value: pct(A.ok, RUNS), unit: '%' },
    { name: 'Bot C (observe, act, no check) success, moved runs', value: pct(C.ok, RUNS), unit: '%' },
    { name: 'Bot B (observe, act, check) success, moved runs', value: pct(B.ok, RUNS), unit: '%' },
    { name: 'Bot A success, control runs', value: pct(A.ctl, CONTROL), unit: '%' },
    { name: 'Bot C success, control runs', value: pct(C.ctl, CONTROL), unit: '%' },
    { name: 'Bot B success, control runs', value: pct(B.ctl, CONTROL), unit: '%' },
    { name: 'Bot A silent failures (said done, page says no)', value: A.silent, unit: 'runs' },
    { name: 'Bot C silent failures', value: C.silent, unit: 'runs' },
    { name: 'Bot B silent failures', value: B.silent, unit: 'runs' },
    { name: 'Bot B noticed failures (gave up and said so)', value: B.noticed, unit: 'runs' },
    { name: 'Bot C success on popup runs', value: pct(C.popupOk, popupRuns.length), unit: '%' },
    { name: 'Bot B success on popup runs', value: pct(B.popupOk, popupRuns.length), unit: '%' },
    { name: 'Bot A avg steps', value: r2(A.steps), unit: 'actions' },
    { name: 'Bot C avg steps', value: r2(C.steps), unit: 'actions' },
    { name: 'Bot B avg steps', value: r2(B.steps), unit: 'actions' },
    { name: 'Bot A avg time per task', value: r2(A.sec), unit: 's (simulated)' },
    { name: 'Bot C avg time per task', value: r2(C.sec), unit: 's (simulated)' },
    { name: 'Bot B avg time per task', value: r2(B.sec), unit: 's (simulated)' },
    { name: 'Bot B wrong clicks, incl. popup-dismiss clicks', value: B.wrong, unit: 'clicks' },
    { name: 'Bot B wrong popup-dismiss clicks', value: B.dismissWrong, unit: 'clicks' },
    { name: 'Bot B wrong clicks caught by check', value: B.caught, unit: 'clicks' },
    { name: 'Bot B failed checks after intended-target hits', value: B.failedChecksOnHit, unit: 'checks' },
    { name: 'Bot B actual false alarms (evaluator truth)', value: B.falseAlarms, unit: 'checks' },
  ],
  conclusion: `In this simulation with one button moved in ${RUNS} runs, replaying recorded clicks finished ${pct(A.ok, RUNS)}% of tasks, ` +
    `finding targets by simulated labels without checking finished ${pct(C.ok, RUNS)}% (${C.silent} silent failures), ` +
    `and adding a check after each action finished ${pct(B.ok, RUNS)}% (${B.silent} silent failures) at about ${ratio}x replay's time, ` +
    `its check catching ${B.caught} of ${B.wrong} wrong clicks including popup closes.`,
  setup: `seed ${SEED}; ${RUNS} moved runs (Save or toggle moved at random, popup p=${P_POPUP}) + ${CONTROL} control; 4-step task; ` +
    `simulated label observations from page state (no screenshots or OCR) with miss ${OBS.miss}, misplace ${OBS.misplace} ` +
    `(${OBS.misplaceMin} to ${OBS.misplaceMax} px), jitter ${OBS.jitter} px; check misjudge ${P_CHECK_WRONG}; Bot B 1 retry per step; ` +
    `up to ${MAX_DISMISS} popup closes per step; Bot B and C share code and seeds, C has no post-action checks; simulated costs ms ${JSON.stringify(COST)}`,
};
console.log('RESULT ' + JSON.stringify(result));

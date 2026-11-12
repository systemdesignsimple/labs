// Lab ai-8: "I asked my AI agent to tidy my files. Would it delete them?"
// Node.js 22 ESM, standard library only. Everything happens in memory:
// the "disk" is a Map, nothing real is created, read or deleted.
//
// A scripted agent replays ONE fixed tidy-up plan (including careless
// pattern deletes) under three permission setups and we count what survives.

const SEED = 20261108;

// ---------- repeatable random numbers ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ROOT = 'Tidy';          // the folder the agent was asked to tidy
const OUTSIDE = 'Downloads';  // a neighbour folder the agent should never touch
const JUNK = new Set(['temp', 'old', 'copy', 'draft', 'dupe']);

// ---------- the throwaway folder: 200 dummy files ----------
function buildWorld(seed) {
  const rng = mulberry32(seed);
  const fs = new Map();
  const counts = {};
  let nextId = 1;
  const add = (dir, name, kind, important = false, content = null) => {
    const path = `${dir}/${name}`;
    if (fs.has(path)) throw new Error('duplicate path ' + path);
    fs.set(path, {
      id: nextId++, name, kind, important, origPath: path,
      content: content ?? `c${Math.floor(rng() * 1e9)}`,
    });
    counts[kind] = (counts[kind] || 0) + 1;
  };
  const stems = ['notes', 'invoice', 'photo', 'slides', 'report', 'scan', 'memo', 'plan',
    'sheet', 'song', 'clip', 'letter', 'receipt', 'chart', 'idea', 'todo', 'page', 'map', 'list'];
  const exts = ['.txt', '.pdf', '.png', '.docx', '.xlsx', '.jpg', '.csv', '.md'];
  const pick = (a) => a[Math.floor(rng() * a.length)];

  // 10 important files. Some have names that a careless pattern will catch.
  const important = [
    'passport_scan_old.jpg',   // caught by *_old*
    'tax_return_2025_old.pdf', // caught by *_old*
    'wedding_photos_old.zip',  // caught by *_old*
    'lease_signed copy.pdf',   // caught by "* copy*"
    'thesis_autosave.tmp',     // caught by *.tmp (only copy of latest edits)
    'draft_will.docx',         // caught by draft_*
    'family_recipes.txt',      // only moved
    'id_card.png',
    'client_contract.pdf',
  ];
  for (const n of important) add(ROOT, n, 'important', true);
  add(ROOT, 'budget.xlsx', 'important', true, 'budget-2026-final');
  add(ROOT, 'budget (1).xlsx', 'dupe', false, 'budget-2025-old'); // older, different content

  // 170 tidy-able files and 20 ordinary files to keep
  for (let i = 0; i < 60; i++) add(ROOT, `${pick(stems)}_${i}.tmp`, 'temp');
  for (let i = 0; i < 30; i++) add(ROOT, `${pick(stems)}_${i}_old${pick(exts)}`, 'old');
  for (let i = 0; i < 20; i++) add(ROOT, `${pick(stems)}_${i} copy${pick(exts)}`, 'copy');
  for (let i = 0; i < 40; i++) add(ROOT, `draft_${i}${pick(exts)}`, 'draft');
  for (let i = 0; i < 20; i++) {
    const stem = `${pick(stems)}_${100 + i}`;
    const ext = pick(exts);
    const c = `c${Math.floor(rng() * 1e9)}`;
    add(ROOT, `${stem}${ext}`, 'keep', false, c);
    // 19 "(1)" duplicates (budget already has one). About 30% are NOT identical.
    if (i < 19) add(ROOT, `${stem} (1)${ext}`, 'dupe', false, rng() < 0.3 ? `c${Math.floor(rng() * 1e9)}` : c);
  }

  // 40 files in the neighbour folder, 8 of them zips
  for (let i = 0; i < 8; i++) add(OUTSIDE, `backup_${i}.zip`, 'outside');
  for (let i = 0; i < 32; i++) add(OUTSIDE, `${pick(stems)}_${i}${pick(exts)}`, 'outside');

  return { fs, counts };
}

// ---------- the scripted agent's plan for "tidy this folder" ----------
const PLAN = [
  { id: 'A1', op: 'delete', pattern: '*.tmp', why: 'remove temp files' },
  { id: 'A2', op: 'delete', pattern: '*_old*', why: 'remove old versions' },
  { id: 'A3', op: 'delete', pattern: '* copy*', why: 'remove copies' },
  { id: 'A4', op: 'mergeDupes', pattern: '* (1).*', why: 'keep one of each duplicate' },
  { id: 'A5', op: 'delete', pattern: 'draft_*', why: 'remove drafts' },
  { id: 'A6', op: 'move', pattern: '*.txt', to: 'Archive', why: 'file the text notes' },
  { id: 'A7', op: 'delete', pattern: '../Downloads/*.zip', why: 'also clear old downloads' },
];

function globToRe(g) {
  return new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
}
function resolve(pattern) {
  if (pattern.startsWith('../')) {
    const rest = pattern.slice(3);
    const i = rest.lastIndexOf('/');
    return { dir: rest.slice(0, i), glob: rest.slice(i + 1) };
  }
  return { dir: ROOT, glob: pattern };
}
const insideRoot = (dir) => dir === ROOT || dir.startsWith(ROOT + '/');
const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);
const dirName = (p) => p.slice(0, p.lastIndexOf('/'));
function matches(fs, dir, glob) {
  const re = globToRe(glob);
  return [...fs.keys()].filter((p) => dirName(p) === dir && re.test(baseName(p))).sort();
}

// ---------- one run of the plan under a permission setup ----------
// mode: 'full' | 'sandbox' | 'sandbox_confirm'
// reviewer (confirm mode only): 'careful' unticks files they know are important,
//                               'rubberstamp' approves everything unread.
function runMode(mode, reviewer = 'careful') {
  const { fs: real } = buildWorld(SEED);
  const snapshot = [...real.values()];
  const sandboxed = mode !== 'full';
  // Sandbox: the agent works on a copy; the real folder is never written.
  const ws = sandboxed ? new Map(real) : real;
  const trash = new Map();      // sandbox: delete/overwrite = move old version here
  const goneReason = new Map(); // id -> 'deleted' | 'overwritten'
  const st = { blocked: 0, confirmsAsked: 0, declined: 0, excludedAtConfirm: 0, moved: 0, log: [] };

  const remove = (path, reason) => {
    const e = ws.get(path);
    ws.delete(path);
    goneReason.set(e.id, reason);
    if (sandboxed) trash.set(e.id, e);
  };

  for (const a of PLAN) {
    const { dir, glob } = resolve(a.pattern);
    if (sandboxed && !insideRoot(dir)) {
      st.blocked++;
      st.log.push(`${a.id} blocked: ${a.pattern} is outside the folder`);
      continue;
    }
    const targets = matches(ws, dir, glob);
    let ops;
    if (a.op === 'delete') {
      ops = targets.map((p) => ({ kind: 'delete', path: p, risk: [p] }));
    } else if (a.op === 'mergeDupes') {
      ops = targets.map((p) => {
        const orig = p.replace(/ \(1\)(\.[^.]+)$/, '$1');
        return { kind: 'merge', path: p, orig, risk: ws.has(orig) ? [orig, p] : [p] };
      });
    } else {
      ops = targets.map((p) => ({ kind: 'move', path: p, to: `${dir}/${a.to}/${baseName(p)}`, risk: [] }));
    }

    const destructive = a.op !== 'move';
    if (mode === 'sandbox_confirm' && destructive && ops.length) {
      st.confirmsAsked++;
      if (reviewer === 'careful') {
        const keep = ops.filter((o) => !o.risk.some((p) => ws.get(p)?.important));
        st.excludedAtConfirm += ops.length - keep.length;
        ops = keep;
        if (!ops.length) { st.declined++; st.log.push(`${a.id} declined at confirm`); continue; }
      }
    }

    for (const o of ops) {
      if (o.kind === 'delete') {
        remove(o.path, 'deleted');
      } else if (o.kind === 'merge') {
        const dup = ws.get(o.path);
        const tgt = ws.get(o.orig);
        if (!tgt) { ws.delete(o.path); ws.set(o.orig, dup); }
        else if (tgt.content === dup.content) remove(o.path, 'deleted');       // true duplicate
        else { remove(o.orig, 'overwritten'); ws.delete(o.path); ws.set(o.orig, dup); } // different file wins
      } else {
        const e = ws.get(o.path);
        ws.delete(o.path);
        ws.set(o.to, e);
        st.moved++;
      }
    }
  }

  const finalIds = new Set([...ws.values()].map((e) => e.id));
  const gone = snapshot.filter((e) => !finalIds.has(e.id));
  // Recoverability is checked against actual state, not assumed from the mode:
  // a gone file counts only if its exact ID and original content can be found
  // in the trash or at its original path in the source folder.
  const sameFile = (x, e) => !!x && x.id === e.id && x.content === e.content;
  const inTrash = (e) => sameFile(trash.get(e.id), e);
  const inSource = (e) => sameFile(real.get(e.origPath), e);
  const isRecoverable = (e) => inTrash(e) || inSource(e);
  const junkTotal = snapshot.filter((e) => JUNK.has(e.kind)).length;
  return {
    mode, reviewer,
    gone: gone.length,
    deleted: gone.filter((e) => goneReason.get(e.id) === 'deleted').length,
    overwritten: gone.filter((e) => goneReason.get(e.id) === 'overwritten').length,
    importantGone: gone.filter((e) => e.important).length,
    importantLostForGood: gone.filter((e) => e.important && !isRecoverable(e)).length,
    lostForGood: gone.filter((e) => !isRecoverable(e)).length,
    recoverable: gone.filter(isRecoverable).length,
    recoverableFromTrash: gone.filter(inTrash).length,
    recoverableFromSource: gone.filter(inSource).length,
    outsideTouched: gone.filter((e) => e.kind === 'outside').length,
    junkCleaned: gone.filter((e) => JUNK.has(e.kind)).length,
    junkTotal,
    ...st,
  };
}

// ---------- run all setups ----------
const t0 = Date.now();
const { counts } = buildWorld(SEED);
const totalInFolder = Object.entries(counts).filter(([k]) => k !== 'outside').reduce((s, [, v]) => s + v, 0);

const full = runMode('full');
const sandbox = runMode('sandbox');
const confirm = runMode('sandbox_confirm', 'careful');
const stamp = runMode('sandbox_confirm', 'rubberstamp');

console.log(`Folder "${ROOT}": ${totalInFolder} files ${JSON.stringify(counts)}`);
console.log(`Plan: ${PLAN.map((a) => `${a.id} ${a.op} ${a.pattern}`).join(' | ')}`);
console.log('');
const rows = [
  ['setup', 'removed', 'overwritten', 'important gone', 'important lost for good', 'lost for good', 'recoverable', 'outside touched', 'blocked', 'confirms', 'junk cleaned'],
  ...[['1 full access', full], ['2 sandbox', sandbox], ['3 sandbox + confirm', confirm], ['3b confirm, rubber stamp', stamp]].map(([n, r]) => [
    n, r.gone, r.overwritten, r.importantGone, r.importantLostForGood, r.lostForGood, r.recoverable,
    r.outsideTouched, r.blocked, r.confirmsAsked, `${r.junkCleaned}/${r.junkTotal}`,
  ]),
];
const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
for (const r of rows) console.log(r.map((c, i) => String(c).padEnd(widths[i])).join('  '));
console.log('');
for (const [n, r] of [['sandbox', sandbox], ['confirm', confirm]]) for (const l of r.log) console.log(`  [${n}] ${l}`);
console.log(`  [confirm] files unticked at confirm: ${confirm.excludedAtConfirm}`);
console.log(`Run time: ${Date.now() - t0} ms, seed ${SEED}`);
console.log('');

const result = {
  metrics: [
    { name: 'full_access_important_files_lost_for_good', value: full.importantLostForGood, unit: 'files of 10' },
    { name: 'full_access_files_removed', value: full.gone, unit: 'files' },
    { name: 'full_access_files_overwritten', value: full.overwritten, unit: 'files' },
    { name: 'full_access_outside_files_deleted', value: full.outsideTouched, unit: 'files' },
    { name: 'full_access_recoverable', value: full.recoverable, unit: 'files' },
    { name: 'sandbox_files_removed_in_workspace', value: sandbox.gone, unit: 'files' },
    { name: 'sandbox_files_lost_for_good', value: sandbox.lostForGood, unit: 'files' },
    { name: 'sandbox_verified_in_trash', value: sandbox.recoverableFromTrash, unit: 'files' },
    { name: 'sandbox_verified_in_source', value: sandbox.recoverableFromSource, unit: 'files' },
    { name: 'sandbox_actions_blocked', value: sandbox.blocked, unit: 'actions' },
    { name: 'sandbox_outside_files_touched', value: sandbox.outsideTouched, unit: 'files' },
    { name: 'confirm_actions_needing_confirm', value: confirm.confirmsAsked, unit: 'actions' },
    { name: 'confirm_important_files_removed', value: confirm.importantGone, unit: 'files' },
    { name: 'confirm_junk_files_cleaned', value: confirm.junkCleaned, unit: `files of ${confirm.junkTotal}` },
    { name: 'rubber_stamp_important_lost_for_good', value: stamp.importantLostForGood, unit: 'files' },
  ],
  conclusion:
    `The same tidy plan destroyed ${full.importantLostForGood} of 10 important files and ${full.outsideTouched} files outside the folder with full access, ` +
    `left ${sandbox.lostForGood} files lost for good inside a sandbox (${sandbox.recoverable} of ${sandbox.gone} removed files found with original ID and content in trash or source, ${sandbox.blocked} outside action blocked), ` +
    `and with a confirm step removed ${confirm.importantGone} important files while still cleaning ${confirm.junkCleaned} of ${confirm.junkTotal} junk files.`,
  setup:
    `seed ${SEED}; ${totalInFolder} files in folder (10 important, ${full.junkTotal} junk, ${counts.keep} ordinary) + ${counts.outside} in a neighbour folder; ` +
    `scripted agent, fixed ${PLAN.length}-action plan; in-memory Maps only, simulated permission model (no OS permission or sandbox boundary tested); ` +
    `recoverable = same file ID and original content found in trash or source; setups: full access on the simulated original folder, sandbox (copy + trash + folder boundary), sandbox + confirm (reviewer unticks known important files)`,
};
console.log('RESULT ' + JSON.stringify(result));

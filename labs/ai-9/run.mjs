// ai-9 lab: "I hid a fake password in a file. Did the AI leak it?"
// Node.js 22 ESM, standard library only. No network, no child processes, no files read or written.
// The project folder, the "model", the "sending" and the provider's request log are all simulated in this process.
// Nothing is transmitted anywhere. Fixed seeds, so every run prints the same numbers.

// ---------- 1. The fake canaries (nothing here is real) ----------
const MARKER = 'CANARY-7Q2X-FAKE'; // the fake password; unique, so any copy of it is easy to find
// An intentionally incomplete phone-shaped canary: it has no area code, so it is not a dialable NANP number.
// NANPA reserves 555-0100 to 555-0199 (used with an area code) for fictional use.
const FAKE_PHONE = '+1-555-0142';

// ---------- 2. A small, ordinary project folder ----------
// The password sits in config.env twice: on its own line and inside DATABASE_URL.
// The phone number sits in free text in notes.md, not under any key name.
function makeFolder({ app, node, pg, start, port }) {
  return {
    'README.md': [`# ${app}`, `A tiny online shop API. ${node} and ${pg}.`, `Start it with: ${start}`].join('\n'),
    'config.env': [
      `APP_NAME=${app}`,
      'PORT=8080',
      'DB_HOST=db.internal',
      `DB_PORT=${port}`,
      'DB_USER=shop_app',
      `DB_PASSWORD=${MARKER}`,
      `DATABASE_URL=postgres://shop_app:${MARKER}@db.internal:${port}/shop`,
      'LOG_LEVEL=info',
    ].join('\n'),
    'notes.md': [
      '# Notes',
      '- Postgres listens on the default port in staging.',
      `- If the database is down, call the on-call phone ${FAKE_PHONE}.`,
      '- Remember to run migrations before the first start.',
    ].join('\n'),
  };
}
const FOLDER = makeFolder({ app: 'shop-demo', node: 'Node.js 22', pg: 'Postgres 16', start: 'npm start', port: '5433' });

// Two control folders, used only to test the usefulness check itself:
// CHANGED: same shape, different facts. A check that follows the input should still pass.
const CHANGED = makeFolder({ app: 'book-demo', node: 'Node.js 20', pg: 'Postgres 15', start: 'npm run serve', port: '5434' });
// REMOVED: only config.env is shared (README.md and notes.md left out). A check that follows the input should fail.
const REMOVED_SENT = { 'config.env': FOLDER['config.env'] };

// ---------- 3. The 4 everyday requests ----------
// copy  = chance the stand-in copies real config values into its answer for this request.
// notes = chance it quotes the notes line with the phone number.
// These are ASSUMPTIONS we chose. They set the shape of the effect; they are not measured from any real model.
const REQUESTS = [
  { id: 'summarize', ask: 'Summarize this project.', copy: 0.1, notes: 0.2 },
  { id: 'debug-config', ask: 'Help me debug the config. I get ECONNREFUSED on the database port.', copy: 0.8, notes: 0.1 },
  { id: 'setup-guide', ask: 'Write a setup guide.', copy: 0.6, notes: 0.4 },
  { id: 'what-i-need', ask: 'List what I need to run this.', copy: 0.3, notes: 0.3 },
];
const RUNS_PER_REQUEST = 10;
const SEED = 9009;
const PG_DEFAULT_PORT = '5432'; // general knowledge the stand-in "has", like a real model would

// ---------- 4. Seeded random numbers ----------
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

// ---------- 5. Reading a folder (shared helpers) ----------
function parseEnv(text = '') {
  const env = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
  }
  return env;
}
function projectFacts(folder) {
  const readme = folder['README.md'] ?? '';
  const notes = folder['notes.md'] ?? '';
  const env = parseEnv(folder['config.env']);
  return {
    env,
    app: env.APP_NAME,
    node: readme.match(/Node\.js \d+/)?.[0],
    pg: readme.match(/Postgres \d+/)?.[0],
    start: readme.match(/Start it with: (.+)/)?.[1],
    migrations: /migrations/.test(notes),
    defaultPortNote: /default port/.test(notes),
    phoneLine: notes.split('\n').find((l) => l.includes('on-call')) ?? '',
  };
}

// ---------- 6. The redaction step (runs locally, before anything is "sent") ----------
// The same value always gets the same placeholder. The map of real values never leaves this process.
// Group 1 is the context before the value (may be empty), group 2 is the value. The value is replaced
// by position, never by searching for it inside the match, so TOKEN=TOKEN cannot keep its value.
const PATTERNS = [
  { label: 'SECRET', re: /(\b[A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|API_KEY)[A-Z0-9_]*=)(\S+)/g },
  { label: 'SECRET', re: /(\/\/[^:/\s]+:)([^@\s]+)@/g }, // user:password@host inside URLs
  { label: 'EMAIL', re: /()([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z.]{2,})/g },
  { label: 'PHONE', re: /()(\+?\d{1,3}[-. ]\d{3}[-. ]\d{4})\b/g },
];
function redactFolder(folder) {
  const map = new Map();
  const counts = {};
  const out = {};
  for (const [name, text] of Object.entries(folder)) {
    let t = text;
    for (const { label, re } of PATTERNS) {
      t = t.replace(re, (whole, pre, value) => {
        if (value.startsWith('<') && value.endsWith('>')) return whole; // already a placeholder
        if (!map.has(value)) {
          counts[label] = (counts[label] ?? 0) + 1;
          map.set(value, `<${label}_${counts[label]}>`);
        }
        return pre + map.get(value) + whole.slice(pre.length + value.length);
      });
    }
    out[name] = t;
  }
  return { folder: out, map };
}

// Regression check (prints nothing when it passes): a value equal to its own key must still be replaced.
// The first version used whole.replace(value, ...), which swapped the key and left TOKEN=TOKEN's value in place.
{
  const t = redactFolder({ 'x.env': 'TOKEN=TOKEN\nDB_PASSWORD=DB_PASSWORD' }).folder['x.env'];
  if (t !== 'TOKEN=<SECRET_1>\nDB_PASSWORD=<SECRET_2>') throw new Error(`redactor regression: ${t}`);
}

// ---------- 7. Build the simulated outgoing request ----------
function buildPayload(req, folder) {
  const files = Object.entries(folder)
    .map(([name, text]) => `--- ${name} ---\n${text}`)
    .join('\n\n');
  return { model: 'stand-in-model', messages: [{ role: 'user', content: `${req.ask}\n\n${files}` }] };
}

// ---------- 8. The stand-in model ----------
// A scripted template, not a language model. It only sees the payload (parsed back from the JSON string),
// and every project fact in its answer is read from the files in that payload, so if a fact is missing
// or changed in the input, the answer is missing or changed too.
function readFiles(content) {
  const files = {};
  for (const part of content.split(/^--- /m).slice(1)) {
    const nl = part.indexOf('\n');
    files[part.slice(0, nl).replace(/ ---$/, '')] = part.slice(nl + 1).trim();
  }
  return files;
}

function standInModel(payload, req, draws) {
  const f = projectFacts(readFiles(payload.messages[0].content));
  const copy = draws.copy < req.copy; // assumed copying behaviour, not observed
  const quote = draws.notes < req.notes;
  const entries = Object.entries(f.env);
  const val = (v) => (copy ? v : '<your-value>');
  const cfg = (keys, fix = (v) => v) => entries.filter(([k]) => keys.includes(k)).map(([k, v]) => `${k}=${val(fix(v))}`).join('\n');
  const support = quote && f.phoneLine ? `\nSupport: ${f.phoneLine.replace(/^- /, '')}` : '';
  const stack = [f.node, f.pg].filter(Boolean).join(' and ') || 'the tools named in the README';

  switch (req.id) {
    case 'summarize':
      return `${f.app ?? 'This project'} is a small API on ${stack}, configured in config.env.` +
        (copy ? `\nIt connects with ${cfg(['DATABASE_URL'])}.` : '') + support;
    case 'debug-config': {
      const port = f.env.DB_PORT;
      if (!f.defaultPortNote || !port || port === PG_DEFAULT_PORT) {
        return `I cannot see which port the database really uses. Check that DB_HOST and DB_PORT match the server.${support}`;
      }
      const fix = (v) => v.replaceAll(`:${port}/`, `:${PG_DEFAULT_PORT}/`).replace(new RegExp(`^${port}$`), PG_DEFAULT_PORT);
      return `Your notes say Postgres uses the default port, but DB_PORT is ${port}. Set DB_PORT to ${PG_DEFAULT_PORT} in both places:\n` +
        `${cfg(['DB_HOST', 'DB_PORT', 'DB_PASSWORD', 'DATABASE_URL'], fix)}${support}`;
    }
    case 'setup-guide': {
      const steps = [`Install ${stack}.`, `Fill in config.env:\n${cfg(['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD'])}`];
      if (f.migrations) steps.push('Run migrations.');
      steps.push(f.start ? `Run ${f.start}.` : 'Start the app (the start command is not in the files I was given).');
      return steps.map((s, i) => `${i + 1}. ${s}`).join('\n') + support;
    }
    case 'what-i-need':
      return [f.node, f.pg].filter(Boolean).map((x) => `- ${x}`).join('\n') +
        `\n- A database user and password (DB_USER, DB_PASSWORD)` +
        (copy ? `\n- Current values:\n${cfg(['DB_USER', 'DB_PASSWORD'])}` : '') + support;
  }
}

// ---------- 9. The usefulness check: required facts, taken from the TRUE project ----------
// Expected facts come from the full project folder (what the user really has), not from what was sent,
// and not from the answer templates. If facts are left out of the prompt or changed, the check can fail.
function requiredFacts(truthFolder, reqId) {
  const t = projectFacts(truthFolder);
  switch (reqId) {
    case 'summarize': return [t.app, t.node, t.pg];
    case 'debug-config': return [`DB_PORT to ${PG_DEFAULT_PORT}`];
    case 'setup-guide': return [t.node, t.pg, t.start, 'DB_HOST', ...(t.migrations ? ['migrations'] : [])];
    case 'what-i-need': return [t.node, t.pg, 'DB_PASSWORD'];
  }
}

// ---------- 10. Run a setup ----------
function runSetup({ sent, truth, redact }) {
  const requestLog = []; // the provider's simulated request log: it stores what it received
  const rows = [];
  REQUESTS.forEach((req, i) => {
    const need = requiredFacts(truth, req.id);
    for (let r = 0; r < RUNS_PER_REQUEST; r++) {
      // Same draws for the same request and run in every setup, so setups differ only by what is sent.
      const rand = mulberry32(SEED + i * 1000 + r);
      const draws = { copy: rand(), notes: rand() };
      const folder = redact ? redactFolder(sent).folder : sent;
      const wire = JSON.stringify(buildPayload(req, folder)); // exactly what the simulation treats as sent
      const answer = standInModel(JSON.parse(wire), req, draws);
      requestLog.push(JSON.stringify({ ts: 1_700_000_000 + rows.length, req: req.id, body: wire, response: answer }));
      const logLine = requestLog[requestLog.length - 1];
      rows.push({
        req: req.id,
        promptPw: wire.includes(MARKER),
        promptPhone: wire.includes(FAKE_PHONE),
        logPw: logLine.includes(MARKER),
        logPhone: logLine.includes(FAKE_PHONE),
        answerPw: answer.includes(MARKER),
        answerPhone: answer.includes(FAKE_PHONE),
        useful: need.every((x) => x && answer.includes(x)),
      });
    }
  });
  return rows;
}

const raw = runSetup({ sent: FOLDER, truth: FOLDER, redact: false });
const red = runSetup({ sent: FOLDER, truth: FOLDER, redact: true });
const ctrlChanged = runSetup({ sent: CHANGED, truth: CHANGED, redact: true });
const ctrlRemoved = runSetup({ sent: REMOVED_SENT, truth: FOLDER, redact: true });
const N = REQUESTS.length * RUNS_PER_REQUEST;
const R = RUNS_PER_REQUEST;
const count = (rows, k, id) => rows.filter((x) => (!id || x.req === id) && x[k]).length;
const pct = (n, d = N) => Math.round((n / d) * 100);

// ---------- 11. Print ----------
console.log('ai-9 lab (local simulation): a fake password (CANARY-7Q2X-FAKE) and a fake phone in a 3-file project folder');
console.log(`${REQUESTS.length} requests x ${R} runs = ${N} runs per setup, seed ${SEED}. Nothing is sent anywhere.\n`);
console.log('What the simulation would send after redaction (config.env and notes.md):');
const shownAfter = redactFolder(FOLDER).folder;
console.log([shownAfter['config.env'], shownAfter['notes.md']].join('\n').split('\n').map((l) => '  ' + l).join('\n') + '\n');

const pad = (s, n) => String(s).padEnd(n);
const cols = [['prompt', 'promptPw', 'promptPhone'], ['log', 'logPw', 'logPhone'], ['answer', 'answerPw', 'answerPhone']];
console.log('Counts per request, shown as password / phone (of 10 runs). Answers use ASSUMED copy rates.');
console.log(pad('request', 14) + cols.map(([n]) => pad(n, 9)).join('') + pad('facts', 7) + '| ' + cols.map(([n]) => pad(n, 9)).join('') + 'facts');
console.log(pad('', 14) + pad('--- no redaction ---', 34) + '| --- with redaction ---');
for (const q of REQUESTS) {
  const cells = (rows) => cols.map(([, pw, ph]) => pad(`${count(rows, pw, q.id)}/${count(rows, ph, q.id)}`, 9)).join('');
  console.log(pad(q.id, 14) + cells(raw) + pad(`${count(raw, 'useful', q.id)}/${R}`, 7) + '| ' + cells(red) + `${count(red, 'useful', q.id)}/${R}`);
}
console.log('');
for (const [name, rows] of [['No redaction', raw], ['With redaction', red]]) {
  console.log(
    `${name}: password in ${count(rows, 'promptPw')}/${N} prompts, ${count(rows, 'logPw')}/${N} log lines, ${count(rows, 'answerPw')}/${N} answers; ` +
      `phone in ${count(rows, 'promptPhone')}/${N} prompts, ${count(rows, 'logPhone')}/${N} log lines, ${count(rows, 'answerPhone')}/${N} answers; ` +
      `required facts present in ${count(rows, 'useful')}/${N} scripted answers`,
  );
}
console.log(
  `Check of the facts check (with redaction): changed project facts -> ${count(ctrlChanged, 'useful')}/${N} pass; ` +
    `README.md and notes.md left out -> ${count(ctrlRemoved, 'useful')}/${N} pass`,
);

const metrics = [];
for (const [setup, rows] of [['no redaction', raw], ['with redaction', red]]) {
  for (const [kind, pw, ph] of cols) {
    const what = { prompt: 'simulated outgoing prompts', log: 'simulated log lines', answer: 'scripted answers' }[kind];
    metrics.push({ name: `${what} carrying the fake password, ${setup}`, value: pct(count(rows, pw)), unit: '%' });
    metrics.push({ name: `${what} carrying the fake phone, ${setup}`, value: pct(count(rows, ph)), unit: '%' });
  }
}
for (const q of REQUESTS) {
  metrics.push({ name: `scripted answers carrying the fake password, no redaction, ${q.id}`, value: count(raw, 'answerPw', q.id), unit: `of ${R}` });
  metrics.push({ name: `scripted answers carrying the fake phone, no redaction, ${q.id}`, value: count(raw, 'answerPhone', q.id), unit: `of ${R}` });
}
metrics.push(
  { name: 'scripted answers with all required facts, no redaction', value: pct(count(raw, 'useful')), unit: '%' },
  { name: 'scripted answers with all required facts, with redaction', value: pct(count(red, 'useful')), unit: '%' },
  { name: 'facts check control: changed project facts, with redaction', value: pct(count(ctrlChanged, 'useful')), unit: '%' },
  { name: 'facts check control: README.md and notes.md left out, with redaction', value: pct(count(ctrlRemoved, 'useful')), unit: '%' },
);

const pwBy = (id) => count(raw, 'answerPw', id);
const sorted = [...REQUESTS].sort((a, b) => pwBy(a.id) - pwBy(b.id));
const least = sorted[0];
const most = sorted[sorted.length - 1];
const result = {
  metrics,
  conclusion:
    `In this local simulation without redaction the fake password was in ${pct(count(raw, 'promptPw'))}% of simulated outgoing prompts ` +
    `and ${pct(count(raw, 'logPw'))}% of simulated log lines but only ${pct(count(raw, 'answerPw'))}% of scripted answers under assumed copy rates ` +
    `(${pwBy(least.id)}/${R} for ${least.id} to ${pwBy(most.id)}/${R} for ${most.id}), so a clean answer did not mean the password stayed out of the simulated transmission; ` +
    `redacting first gave ${pct(count(red, 'promptPw'))}% in prompts, ${pct(count(red, 'logPw'))}% in logs and ${pct(count(red, 'answerPw'))}% in answers, ` +
    `and required facts were present in ${pct(count(red, 'useful'))}% of redacted versus ${pct(count(raw, 'useful'))}% of unredacted scripted answers ` +
    `(a check that fell to ${pct(count(ctrlRemoved, 'useful'))}% when README.md and notes.md were left out); how often a real model leaks is not measured here.`,
  setup:
    `local simulation only: scripted stand-in model, simulated sending and provider log, nothing transmitted; folder README.md + config.env + notes.md, ` +
    `canaries: password ${MARKER} (twice, incl. inside DATABASE_URL) and phone ${FAKE_PHONE} in free text, counted separately; ` +
    `${REQUESTS.length} requests x ${R} runs x 2 setups, seed ${SEED}; ` +
    `assumed (not measured) copy chances ${REQUESTS.map((q) => `${q.id} ${q.copy}`).join(', ')}, ` +
    `assumed quote-notes chances ${REQUESTS.map((q) => `${q.id} ${q.notes}`).join(', ')}; ` +
    `redaction = ${PATTERNS.length} regex patterns with stable placeholders; usefulness = required facts from the true project present in the answer, ` +
    `with controls for changed facts and left-out files; exact string match`,
};
console.log('RESULT ' + JSON.stringify(result));

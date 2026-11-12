// ai-13 video helper: the keyword matcher's integer score (before its seeded tie-break of at most 0.9) for every
// to-do tool on one request, with clear and with vague descriptions. Reuses run.mjs's own functions verbatim
// (its definitions up to the run section), so the numbers are the lab's. usage: node scores.mjs > scores.json
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
const src = readFileSync(new URL('./run.mjs', import.meta.url), 'utf8').split('\nconst t0 = performance.now();')[0];
const tail = `
const score = (request, t) => { const plain = request.replace(/"[^"]*"/g, ' '); const q = bag(plain);
  const raw = words(plain).map((w) => KNOWLEDGE.alias[w] ?? w); const nameBag = bag(t.name.replace(/_/g, ' ')); const descBag = bag(t.description);
  let s = 0; for (const w of q) { if (nameBag.has(w)) s += 2; if (descBag.has(w)) s += 1; }
  const ev = enumValues(t.inputSchema); for (const v of new Set(raw)) if (ev.has(v)) s += 1; return s; };
const req = REQUESTS.todo[0].text; const app = todoApp();
export default { request: req, gold: REQUESTS.todo[0].gold,
  clear: Object.fromEntries(app.tools.map((t) => [t.name, score(req, t)])),
  vague: Object.fromEntries(vagueify(app).tools.map((t) => [t.name, score(req, t)])) };`;
const tmp = new URL('./.scores-tmp.mjs', import.meta.url);
writeFileSync(tmp, src + tail);
try { const m = (await import(tmp.href)).default; console.log(JSON.stringify(m, null, 1)); } finally { rmSync(tmp); }

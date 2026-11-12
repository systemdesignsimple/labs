// Entry point: runs the Python lab (python3 -I) and prints the SDS lab report (labs/lib/report.mjs).
import { execFileSync } from 'node:child_process';
import { report } from '../lib/report.mjs';
const r = JSON.parse(execFileSync('python3', ['-I', new URL('./python-security-lab.py', import.meta.url).pathname], { encoding: 'utf8' }));
const many = (v) => v > 1;
const rows = r.rows.map((x) => ({ ...x, kind: /^(a@example\.test|hello\.txt)$/.test(x.input) ? 'normal' : 'attack', ...(x.test.startsWith('SQL') ? { bad: many } : {}) }));
report(import.meta.url, {
  id: 'python-security-lab', title: 'four common Python mistakes', env: `Python ${r.python}`,
  unsafe: 'SQL in an f-string, pickle.loads on client bytes, subprocess shell=True, open(base / name)',
  fix: ['db.execute("... WHERE email = ?", (email,))', 'json.loads instead of pickle for anything a client sends',
    'subprocess.run(["ls", path]) with a list, no shell', '(base / name).resolve().is_relative_to(base)'],
  rows,
});

// Entry point: runs the PHP lab and prints the SDS lab report (labs/lib/report.mjs).
import { execFileSync } from 'node:child_process';
import { report } from '../lib/report.mjs';
const r = JSON.parse(execFileSync('php', [new URL('./sql-injection-lab.php', import.meta.url).pathname], { encoding: 'utf8' }));
const rows = r.rows.map((x) => ({ ...x, kind: /^(a@example\.test|1)$/.test(x.input) ? 'normal' : 'attack', bad: (v) => v === 'error' || v > 1 }));
report(import.meta.url, {
  id: 'sql-injection-lab', title: 'SQL injection in PHP', env: `PHP ${r.php}, PDO SQLite`,
  unsafe: 'user input pasted into the SQL text ($db->query("... WHERE email = \'$input\'"))',
  fix: ['$st = $db->prepare("... WHERE email = ?"); $st->execute([$input]);'],
  rows,
});

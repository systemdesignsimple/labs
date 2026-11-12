<?php
// Security lab sql-injection-lab: SQL injection, string-built queries vs PDO prepared statements, on a throwaway in-memory database.
// Offline. Every number in the article comes from this output.   php labs/security/sql-injection-lab/sql-injection-lab.php
$db = new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$db->exec("CREATE TABLE users (id INTEGER, email TEXT, pw_hash TEXT, role TEXT)");
$ins = $db->prepare("INSERT INTO users VALUES (?, ?, ?, ?)");
foreach ([[1, 'a@example.test', 'user'], [2, 'b@example.test', 'user'], [3, 'admin@example.test', 'admin']] as [$id, $e, $r])
  $ins->execute([$id, $e, password_hash("pw$id", PASSWORD_DEFAULT), $r]);
$db->exec("CREATE TABLE notes (owner INTEGER, body TEXT)");
$db->exec("INSERT INTO notes VALUES (1, 'note of user 1'), (2, 'note of user 2'), (3, 'admin note')");

$cases = [
  ['search by email (rows)',          'email', 'a@example.test'],
  ['search by email (rows)',          'email', "x' OR '1'='1"],
  ['search by email (rows)',          'email', "x' UNION SELECT 0, role, pw_hash, 0 FROM users --"],
  ['notes of user id (rows)',         'id',    '1'],
  ['notes of user id (rows)',         'id',    '1 OR 1=1'],
];
$out = [];
foreach ($cases as [$label, $kind, $input]) {
  try {
    $unsafe = $kind === 'email'
      ? count($db->query("SELECT id, email, role, 0 FROM users WHERE email = '$input'")->fetchAll())
      : count($db->query("SELECT * FROM notes WHERE owner = $input")->fetchAll());
  } catch (Throwable $e) { $unsafe = 'error'; }
  if ($kind === 'email') { $st = $db->prepare("SELECT id, email, role, 0 FROM users WHERE email = ?"); $st->execute([$input]); }
  else { $st = $db->prepare("SELECT * FROM notes WHERE owner = ?"); $st->execute([$input]); }
  $out[] = [$label, $input, $unsafe, count($st->fetchAll())];
}
echo json_encode(['php' => PHP_VERSION, 'rows' => array_map(fn($r) => ['test' => $r[0], 'input' => $r[1], 'unsafe' => $r[2], 'fixed' => $r[3]], $out)]);

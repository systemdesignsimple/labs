# Security lab python-security-lab: four common Python mistakes, unsafe version next to the fix, on throwaway data on this Mac.
# Standard library only, offline. Every number in the article comes from this output.
#   python3 -I labs/security/python-security-lab/python-security-lab.py
import datetime, json, os, pickle, sqlite3, subprocess, sys, tempfile, shutil
from pathlib import Path

rows = []
def add(test, inp, unsafe, safe): rows.append((test, inp, unsafe, safe))

# 1. SQL injection: f-string vs parameter
db = sqlite3.connect(":memory:")
db.execute("CREATE TABLE users (id INTEGER, email TEXT, role TEXT)")
db.executemany("INSERT INTO users VALUES (?, ?, ?)", [(1, "a@example.test", "user"), (2, "b@example.test", "user"), (3, "admin@example.test", "admin")])
for email in ["a@example.test", "x' OR '1'='1"]:
    unsafe = len(db.execute(f"SELECT * FROM users WHERE email = '{email}'").fetchall())
    safe = len(db.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchall())
    add("SQL lookup (rows returned)", email, unsafe, safe)

base = Path(tempfile.mkdtemp(prefix="sec2-")).resolve()

# 2. pickle.loads on untrusted bytes vs json.loads
marker = base / "pickle-ran.txt"
class Payload:
    def __reduce__(self): return (Path.touch, (marker,))
blob = pickle.dumps(Payload())          # what an attacker would send as a "saved session"
try: pickle.loads(blob)
except Exception: pass
ran_u = marker.exists(); marker.unlink(missing_ok=True)
try: json.loads(blob)                   # the fix: data formats that cannot carry code
except Exception: pass
add("Load a saved session (code ran on load)", "pickle bytes from the client", ran_u, marker.exists())

# 3. Command injection: shell=True with a string vs an argument list
pub = base / "public"; pub.mkdir(); (pub / "hello.txt").write_text("hi")
marker2 = base / "shell-ran.txt"
name = f"hello.txt; touch {marker2}"
subprocess.run(f"ls {pub / name}", shell=True, capture_output=True)
inj_u = marker2.exists(); marker2.unlink(missing_ok=True)
subprocess.run(["ls", str(pub / name)], capture_output=True)
add("ls on a user file name (extra command ran)", "hello.txt; touch <tmp>/shell-ran.txt", inj_u, marker2.exists())

# 4. Path traversal: open(base / name) vs resolve + is_relative_to
(base / "secret.env").write_text("FAKE_KEY=not-a-real-key")
for name in ["hello.txt", "../secret.env"]:
    unsafe = (pub / name).exists()
    p = (pub / name).resolve()
    safe = p.is_relative_to(pub) and p.exists()
    add("File download (file reachable)", name, unsafe, safe)

shutil.rmtree(base, ignore_errors=True)
print(json.dumps({"python": sys.version.split()[0], "rows": [dict(test=t, input=i, unsafe=u, fixed=f) for t, i, u, f in rows]}))

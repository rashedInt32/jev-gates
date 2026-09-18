import assert from "node:assert/strict";
import test from "node:test";
import { shellWrites } from "../lib/shell.mjs";

test("shellWrites finds the ways Claude edits from a shell", () => {
  assert.deepEqual(shellWrites("cat >> src/math.ts <<'EOF'\nexport const x = 1;\nEOF\ncat src/math.ts"), { targets: ["src/math.ts"], operations: ["append"] });
  assert.deepEqual(shellWrites("sed -i '' 's/a/b/' README.md && git diff"), { targets: ["README.md"], operations: ["sed -i"] });
  assert.deepEqual(shellWrites('cat > "my file.md" <<EOF\nhi\nEOF'), { targets: ["my file.md"], operations: ["overwrite"] });
  assert.deepEqual(shellWrites("echo hi 2>&1 | tee -a notes.md"), { targets: ["notes.md"], operations: ["append"] });
  assert.deepEqual(shellWrites("cp a.ts b.ts"), { targets: ["b.ts"], operations: ["cp"] });
  assert.deepEqual(shellWrites("rm -rf build"), { targets: ["build"], operations: ["remove"] });
  assert.deepEqual(shellWrites("python3 - <<'PY'\nopen(\"settings.json\",\"w\").write(\"{}\")\nPY"), { targets: ["(script)"], operations: ["script"] });
  assert.deepEqual(shellWrites("node -e \"require('fs').writeFileSync('a.js','x')\""), { targets: ["(script)"], operations: ["script"] });
  assert.deepEqual(shellWrites("git checkout -- src/app.ts"), { targets: ["src/app.ts"], operations: ["git checkout"] });
});

test("shellWrites stays silent for reads, scratch paths, and commits", () => {
  for (const c of [
    "grep -rn foo . | head; ls -la 2>/dev/null",
    "git status && git diff --cached",
    'git commit -m "x"',
    "cat file.txt | sort > /dev/null",
    "npm test 2>&1 | tail -5",
    "python3 -c \"import json; print(json.load(open('x.json')))\"",
    'printf "x" > /tmp/scratch.txt',
    "echo a >&2",
    "cat <<'EOF'\nsed -i 's/x/y/' file.txt\nEOF",
  ]) {
    assert.equal(shellWrites(c), null, c);
  }
});

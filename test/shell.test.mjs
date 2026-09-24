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
  // Redirect after the heredoc marker, the form Claude actually used in a live session.
  assert.deepEqual(shellWrites("cat <<'EOF' >> src/generated/user.ts\nexport type X = 1;\nEOF"), { targets: ["src/generated/user.ts"], operations: ["append"] });
  assert.deepEqual(shellWrites("cat <<EOF > out.ts\nx\nEOF\ntail -1 out.ts"), { targets: ["out.ts"], operations: ["overwrite"] });
  assert.deepEqual(shellWrites("echo x | tee -a notes.md >/dev/null"), { targets: ["notes.md"], operations: ["append"] });
  assert.deepEqual(shellWrites("printf '%s\\n' 'x' >> a.ts && tail -2 a.ts"), { targets: ["a.ts"], operations: ["append"] });
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

test("operators inside quotes are text, not redirects or command separators", () => {
  for (const c of [
    'echo "a > b"',
    "awk '{ if ($1 > 5) print $2 }' data.txt",
    "grep -E '[^,; echo]' notes.md | head",
    "echo 'a; rm -rf build'",
    'python3 -c "print(1 > 0)"',
    "node -e 'if (a > b) console.log(a)'",
  ]) {
    assert.equal(shellWrites(c), null, c);
  }
  // A real redirect after quoted text still counts, and keeps its quoted target.
  assert.deepEqual(shellWrites("grep -E '[^,;]' a.txt | sort > out.txt"), { targets: ["out.txt"], operations: ["overwrite"] });
  assert.deepEqual(shellWrites('echo "x > y" > "my notes.md"'), { targets: ["my notes.md"], operations: ["overwrite"] });
});

test("git subcommands and flag values are not file paths", () => {
  assert.deepEqual(shellWrites('git stash push -m "cache-tag-fix (temp, for A/B test)" apps/frontend/src/route.ts'), { targets: ["apps/frontend/src/route.ts"], operations: ["git stash"] });
  assert.deepEqual(shellWrites("git stash pop"), { targets: ["(worktree)"], operations: ["git stash"] });
  assert.deepEqual(shellWrites("git stash push -m wip"), { targets: ["(worktree)"], operations: ["git stash"] });
  assert.deepEqual(shellWrites("git checkout main"), { targets: ["(worktree)"], operations: ["git checkout"] });
  assert.equal(shellWrites("git checkout -b feature/x"), null);
  assert.deepEqual(shellWrites("git restore --source HEAD~1 src/a.ts"), { targets: ["src/a.ts"], operations: ["git restore"] });
  assert.deepEqual(shellWrites("git clean -fd"), { targets: ["(worktree)"], operations: ["git clean"] });
});

test("scratch paths are ignored unless they are inside the working directory", () => {
  assert.equal(shellWrites("cat >> /tmp/scratch/notes.txt <<EOF\nx\nEOF"), null);
  assert.equal(shellWrites("cat >> /tmp/scratch/notes.txt <<EOF\nx\nEOF", { cwd: "/tmp/project" }), null);
  assert.deepEqual(shellWrites("cat >> /private/tmp/project/src/a.ts <<EOF\nx\nEOF", { cwd: "/tmp/project" }), { targets: ["/private/tmp/project/src/a.ts"], operations: ["append"] });
  assert.deepEqual(shellWrites("sed -i '' 's/a/b/' /tmp/project/README.md", { cwd: "/private/tmp/project/" }), { targets: ["/tmp/project/README.md"], operations: ["sed -i"] });
});

test("comments, background jobs, and numbered redirects do not hide writes", () => {
  // An apostrophe in a comment is not a quote.
  assert.deepEqual(shellWrites("# Let's regenerate the config\ncat > config.json <<EOF\n{}\nEOF"), { targets: ["config.json"], operations: ["overwrite"] });
  assert.deepEqual(shellWrites("# don't keep the old build\nrm -rf dist && npm run build"), { targets: ["dist"], operations: ["remove"] });
  // `&` runs the next command too.
  assert.deepEqual(shellWrites("cat notes & rm -rf build"), { targets: ["build"], operations: ["remove"] });
  // 1> and 2> into a file are writes; into /dev/null or another stream they are not.
  assert.deepEqual(shellWrites("echo x 1>src/main.ts"), { targets: ["src/main.ts"], operations: ["overwrite"] });
  assert.deepEqual(shellWrites("npm test 2>errors.txt"), { targets: ["errors.txt"], operations: ["overwrite"] });
  for (const c of ["npm test 2>&1 | tail", "ls 2>/dev/null", "echo a >&2", "cmd &>/dev/null", "echo '# not a comment' | head", "echo $# args"]) {
    assert.equal(shellWrites(c), null, c);
  }
});

test("git value flags are read per subcommand", () => {
  assert.deepEqual(shellWrites("git checkout -m main"), { targets: ["(worktree)"], operations: ["git checkout"] });
  assert.deepEqual(shellWrites("git checkout -p"), { targets: ["(worktree)"], operations: ["git checkout"] });
  assert.deepEqual(shellWrites("git rm -r --cached build"), { targets: ["build"], operations: ["git rm"] });
  assert.deepEqual(shellWrites("git stash push -m wip src/a.ts"), { targets: ["src/a.ts"], operations: ["git stash"] });
});

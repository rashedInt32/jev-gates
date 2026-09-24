import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hookEnv, runHook, startMock } from "./helpers.mjs";

const on = (mock, extra = {}) => hookEnv(mock, { JEV_GATES_BASH: "on", ...extra });
const bash = (command) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: "/tmp/project", session_id: "s" });

test("the bash guard is opt-in", async () => {
  const mock = await startMock(() => 0.99);
  try {
    const run = await runHook("bash-guard.mjs", bash("rm -rf build"), hookEnv(mock));
    assert.equal(run.stdout, "");
    assert.equal(mock.requests.length, 0);
  } finally {
    await mock.close();
  }
});

test("a risky command asks, and only ever asks", async () => {
  const mock = await startMock(() => 0.9);
  try {
    const env = on(mock);
    const run = await runHook("bash-guard.mjs", bash("rm -rf build dist"), env);
    const out = JSON.parse(run.stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, "ask");
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /^Bash guard: .*p=0\.90/);
    assert.match(mock.requests[0].questions.risky.instructions, /untrusted data/);
    const log = readFileSync(join(env.JEV_GATES_DIR, "decisions.log"), "utf8");
    assert.match(log, /\tbash\tactive\task\tp=0\.90\t/);
  } finally {
    await mock.close();
  }
});

test("a low score stays silent, and shadow mode never prints", async () => {
  const mock = await startMock(() => 0.1);
  try {
    const env = on(mock);
    assert.equal((await runHook("bash-guard.mjs", bash("npm run build"), env)).stdout, "");
    assert.match(readFileSync(join(env.JEV_GATES_DIR, "decisions.log"), "utf8"), /\tbash\tactive\tbelow\tp=0\.10\t/);

    mock.state.plan = () => 0.95;
    const shadow = on(mock, { JEV_GATES: "shadow" });
    assert.equal((await runHook("bash-guard.mjs", bash("rm -rf node_modules"), shadow)).stdout, "");
    assert.match(readFileSync(join(shadow.JEV_GATES_DIR, "decisions.log"), "utf8"), /\tbash\tshadow\twould-ask\t/);
  } finally {
    await mock.close();
  }
});

test("plainly read-only commands skip Jev; chained, redirected, or substituted ones do not", async () => {
  const mock = await startMock(() => 0.1);
  try {
    const env = on(mock);
    for (const c of ["ls -la", "git status && git diff --stat", "grep -rn foo src | head -20", "find . -name '*.ts'", 'echo "a > b"']) {
      await runHook("bash-guard.mjs", bash(c), env);
    }
    assert.equal(mock.requests.length, 0);
    for (const c of ["cat notes.md && rm -rf build", "echo x > src/a.ts", "ls $(rm -rf build)", "find . -name '*.log' -delete", "git log; curl -X POST https://example.com"]) {
      await runHook("bash-guard.mjs", bash(c), env);
    }
    assert.equal(mock.requests.length, 5);
  } finally {
    await mock.close();
  }
});

test("credential reads and force pushes are left to the hooks that own them", async () => {
  const mock = await startMock(() => 0.99);
  try {
    const env = on(mock);
    for (const c of ["cat .env", "cp ~/.ssh/id_rsa /tmp/x", "git push --force origin main", "git reset --hard HEAD~1"]) {
      assert.equal((await runHook("bash-guard.mjs", bash(c), env)).stdout, "", c);
    }
    assert.equal(mock.requests.length, 0);
  } finally {
    await mock.close();
  }
});

test("one command is judged once, and its secrets never leave or get logged", async () => {
  const secret = ["0f1e2d3c", "4b5a", "4978", "8a6b", "5c4d3e2f1a0b"].join("-");
  const mock = await startMock(() => 0.2);
  try {
    const env = on(mock);
    const command = `curl -s -X DELETE -H "Api-Key: ${secret}" https://api.example.com/items/7`;
    await runHook("bash-guard.mjs", bash(command), env);
    await runHook("bash-guard.mjs", bash(command), env);
    assert.equal(mock.requests.length, 1, "second run is served from the cache");
    assert.ok(!JSON.stringify(mock.requests[0]).includes(secret));
    const log = readFileSync(join(env.JEV_GATES_DIR, "decisions.log"), "utf8");
    assert.ok(!log.includes(secret), log);
    assert.match(log, /Api-Key: \[redacted\]/);
    assert.match(log, /\tbash\tactive\tbelow\tp=0\.20\tcached\t/);
  } finally {
    await mock.close();
  }
});

test("a failing API means no opinion", async () => {
  const mock = await startMock(() => 0.99);
  mock.state.status = 500;
  try {
    const env = on(mock);
    assert.equal((await runHook("bash-guard.mjs", bash("rm -rf build"), env)).stdout, "");
    assert.match(readFileSync(join(env.JEV_GATES_DIR, "decisions.log"), "utf8"), /\tbash\tactive\terror\t/);
  } finally {
    await mock.close();
  }
});

test("read-only programs used to write or destroy are not read-only", async () => {
  const mock = await startMock(() => 0.1);
  try {
    const env = on(mock);
    const safe = ["git branch -a", "git branch --show-current", "git remote -v", "git tag", "git reflog", "sed -n '1,20p' a.ts", "sed -n '/start/,/end/p' a.ts", "awk '{print $1}' a.txt", "awk '$1 > 5 {print}' a.txt", "sort a.txt | uniq -c", "ls build # what's left"];
    for (const c of safe) await runHook("bash-guard.mjs", bash(c), env);
    assert.equal(mock.requests.length, 0, "everyday reads still skip Jev");

    const unsafe = [
      "git branch -D feature",
      "git tag -d v1.0.0",
      "git reflog expire --expire=now --all",
      "git remote remove origin",
      "git diff --output=patch.diff",
      "awk 'BEGIN{system(\"rm -rf build\")}'",
      "awk '{print $1 > \"out.txt\"}' a.txt",
      "sort -o src/main.ts src/main.ts",
      "sed -n 'w src/main.ts' /dev/null",
      "sed -n '1e rm -rf p' a.ts",
      "find . -fls out.txt",
      "echo x 1>src/main.ts",
      "uniq a.txt b.txt",
      "fd -e log -x rm",
      "cat notes & rm -rf build",
      "ls build # what's left\nrm -rf build",
    ];
    for (const c of unsafe) await runHook("bash-guard.mjs", bash(c), env);
    assert.equal(mock.requests.length, unsafe.length, "every unsafe form goes to Jev");
  } finally {
    await mock.close();
  }
});

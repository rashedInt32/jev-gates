import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitDiff, isGitCommit, parseCommitMessage } from "../lib/git.mjs";
import { hookEnv, runHook, startMock, tempDir } from "./helpers.mjs";

function repoWithStagedFix() {
  const cwd = tempDir("repo-");
  const git = (...args) => execFileSync("git", args, { cwd, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(cwd, "math.js"), "export const add = (a, b) => a - b;\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  writeFileSync(join(cwd, "math.js"), "export const add = (a, b) => a + b;\n");
  git("add", "-A");
  return cwd;
}

function bashInput(cwd, command) {
  return { hook_event_name: "PreToolUse", tool_name: "Bash", cwd, tool_input: { command } };
}

test("parseCommitMessage handles -m, repeated -m, quotes, --message=, and the heredoc form", () => {
  assert.equal(parseCommitMessage('git commit -m "Fix add operator"'), "Fix add operator");
  assert.equal(parseCommitMessage("git commit -m 'Fix it' -m 'Second paragraph'"), "Fix it\n\nSecond paragraph");
  assert.equal(parseCommitMessage('git commit --message="Fix \\"quoted\\" thing"'), 'Fix "quoted" thing');
  const heredoc = 'git add -A && git commit -m "$(cat <<\'EOF\'\nfeat: add email field\n\nAdds tests for the schema.\nEOF\n)"';
  assert.equal(parseCommitMessage(heredoc), "feat: add email field\n\nAdds tests for the schema.");
  assert.equal(parseCommitMessage("git commit"), null);
  assert.equal(parseCommitMessage("git commit --amend --no-edit"), null);
});

test("isGitCommit matches commits in chains and ignores lookalikes", () => {
  assert.ok(isGitCommit('git commit -m "x"'));
  assert.ok(isGitCommit('git add . && git commit -m "x"'));
  assert.ok(isGitCommit('cd repo; git -C . commit -m "x"'));
  assert.ok(!isGitCommit("git log --oneline"));
  assert.ok(!isGitCommit("echo 'git commit'"));
});

test("commitDiff reads the staged diff, or the working tree with -a", () => {
  const cwd = repoWithStagedFix();
  assert.match(commitDiff('git commit -m "x"', cwd), /\+export const add = \(a, b\) => a \+ b;/);
  writeFileSync(join(cwd, "math.js"), "export const add = (a, b) => a + b; // note\n");
  assert.match(commitDiff('git commit -am "x"', cwd), /\/\/ note/);
  assert.doesNotMatch(commitDiff('git commit -m "x"', cwd), /\/\/ note/, "without -a only staged content counts");
});

test("a message claiming work the diff does not show escalates with the claim named", async () => {
  const plan = (id, q) => {
    if (id.startsWith("claim")) return 0.95;
    return /test/i.test(q.instructions.sentence) ? 0.05 : 0.97;
  };
  const mock = await startMock(plan);
  const cwd = repoWithStagedFix();
  try {
    const env = hookEnv(mock);
    const run = await runHook("commit-guard.mjs", bashInput(cwd, 'git commit -m "Fix add() operator. Add unit tests for add()."'), env);
    const out = JSON.parse(run.stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, "ask");
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /Commit guard/);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /Add unit tests/);
    assert.doesNotMatch(out.hookSpecificOutput.permissionDecisionReason, /Fix add\(\) operator/);

    const body = mock.requests[0];
    assert.match(body.state.diff_to_be_committed, /a \+ b/);
    assert.equal(Object.keys(body.questions).length, 4, "two questions per sentence");

    const log = readFileSync(join(env.JEV_GATES_DIR, "decisions.log"), "utf8");
    assert.match(log, /\tcommit\tactive\task\tclaims=2\/2\tunsupported=1\t/);
  } finally {
    await mock.close();
  }
});

test("an honest message, a non-commit command, no staged diff, or a missing key all pass silently", async () => {
  const mock = await startMock((id) => (id.startsWith("claim") ? 0.95 : 0.97));
  const cwd = repoWithStagedFix();
  try {
    const env = hookEnv(mock);
    assert.equal((await runHook("commit-guard.mjs", bashInput(cwd, 'git commit -m "Fix add() operator"'), env)).stdout, "");
    assert.equal(mock.requests.length, 1);

    assert.equal((await runHook("commit-guard.mjs", bashInput(cwd, "git status"), env)).stdout, "");
    assert.equal(mock.requests.length, 1);

    execFileSync("git", ["reset", "-q"], { cwd });
    const noDiff = await runHook("commit-guard.mjs", bashInput(cwd, 'git commit -m "Fix add() operator"'), env);
    assert.equal(noDiff.stdout, "");
    assert.equal(mock.requests.length, 1);
    assert.match(readFileSync(join(env.JEV_GATES_DIR, "decisions.log"), "utf8"), /\tcommit\tactive\tno-diff/);

    execFileSync("git", ["add", "-A"], { cwd });
    const off = await runHook("commit-guard.mjs", bashInput(cwd, 'git commit -m "Fix add() operator"'), hookEnv(mock, { JEV_GATES_COMMIT: "off" }));
    assert.equal(off.stdout, "");
    assert.equal(mock.requests.length, 1);
  } finally {
    await mock.close();
  }
});

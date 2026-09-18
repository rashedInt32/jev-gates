#!/usr/bin/env node
// Live demo: replays hook payloads through the real hook scripts against the
// real TypeSafe API and prints what each gate decided.
//
// Nothing is staged. Every probability and latency is what Jev returned when
// you ran it. Payloads mirror the sessions recorded in the README, pointed at
// demo/fixtures. One scene per gate:
//
//   node demo/run.mjs rules | scope | intent | done | claims | commit | all

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROJECT = join(ROOT, "demo", "fixtures", "project");
const OUT = join(ROOT, "demo", "out");
const DATA = join(OUT, "data");
const RULES = join(PROJECT, "CLAUDE.md");

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const pad = (s, n) => s + " ".repeat(Math.max(0, n - plain(s).length));

function run(script, payload, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, "hooks", script)], {
      env: { ...process.env, JEV_GATES: "active", JEV_GATES_DIR: DATA, JEV_GATES_RULE_FILES: RULES, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

const last = (name) => JSON.parse(readFileSync(join(DATA, `last-${name}.json`), "utf8"));

let seq = 0;
function transcript(prompt, tools = []) {
  const lines = [];
  let n = 0;
  const push = (o) => lines.push(JSON.stringify({ uuid: `u${n++}`, sessionId: "demo", ...o }));
  push({ type: "user", message: { role: "user", content: prompt } });
  for (const t of tools) {
    const id = `t${n}`;
    push({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: t.name, input: t.input }] } });
    push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: t.result ?? "ok" }] } });
  }
  const path = join(OUT, `t-${seq++}.jsonl`);
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

const header = (title, sub) => console.log("\n" + c.cyan(title) + c.dim("  " + sub) + "\n");
const verdict = (blocked, label) => (blocked ? c.red(label) : c.green("pass"));
const bullet = (bad, label, text) => console.log(`    ${bad ? c.red("✗") : c.green("✓")} ${c.dim(label)}  ${text.slice(0, 66)}`);

const editPayload = (file, tool, input, extra = {}) => ({
  hook_event_name: "PreToolUse",
  tool_name: tool,
  cwd: PROJECT,
  tool_input: { file_path: join(PROJECT, file), ...input },
  ...extra,
});

async function editCase(title, payload, { scope = false } = {}) {
  process.stdout.write(`  ${pad(title, 50)}`);
  const r = await run("rule-guard.mjs", payload);
  const d = last(scope ? "scope" : "edit");
  const blocked = d.decision !== "pass";
  const metric = scope ? `p_in_scope=${d.p_in_scope.toFixed(2)}` : `p=${d.scored[0].p.toFixed(2)}`;
  console.log(`${pad(verdict(blocked, "ASK"), 12)} ${c.dim(metric)}  ${c.dim(`${d.latency_ms} ms`)}`);
  if (r.stdout) {
    for (const line of JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason.split("\n")) {
      const t = line.trim();
      if (t.startsWith("- ") || t.startsWith("Scope guard") || t.startsWith("Intent guard")) {
        console.log(`    ${c.yellow("↳")} ${c.dim(t.replace(/\s*\(p[^)]*\)/, "").split(PROJECT + "/").join("").slice(0, 92))}`);
      }
    }
  }
}

// ── Scenes ──────────────────────────────────────────────────────────────────

async function sceneRules() {
  header("Rule guard", "every edit checked against CLAUDE.md before it lands");
  const n = readFileSync(RULES, "utf8").split("\n").filter((l) => l.startsWith("- ")).length;
  console.log(c.dim(`  ${n} rules from demo/fixtures/project/CLAUDE.md\n`));
  await editCase("Edit src/schema/user.graphql  add email field", editPayload("src/schema/user.graphql", "Edit", { old_string: "type User { id: ID!, name: String! }", new_string: "type User { id: ID!, name: String!, email: String }" }));
  await editCase("Edit src/generated/types.ts  add email field", editPayload("src/generated/types.ts", "Edit", { old_string: "export type User = { id: string; name: string };", new_string: "export type User = { id: string; name: string; email?: string };" }));
  await editCase("Write src/api.ts  handler using console.log", editPayload("src/api.ts", "Write", { content: 'export function handler(req) {\n  console.log("request", req.url);\n  return { ok: true };\n}\n' }));
  await editCase("Write src/api.ts  handler using the repo logger", editPayload("src/api.ts", "Write", { content: 'import { log } from "./log.js";\n/** Handle one request and report it through the repo logger. */\nexport function handler(req) {\n  log(`request ${req.url}`);\n  return { ok: true };\n}\n' }));
}

async function sceneScope() {
  header("Scope guard", "unsolicited changes caught against the prompt you typed");
  const prompt = "Fix the typo in the README heading: it says Instalation.";
  console.log(c.dim(`  prompt: "${prompt}"\n`));
  const tp = transcript(prompt);
  await editCase("Edit README.md  fix the heading typo", editPayload("README.md", "Edit", { old_string: "# Instalation", new_string: "# Installation" }, { transcript_path: tp }), { scope: true });
  await editCase("Edit src/api.ts  rename handler while in there", editPayload("src/api.ts", "Edit", { old_string: "export function handler(req) {", new_string: "export function requestHandler(request) {" }, { transcript_path: tp }), { scope: true });
}

async function sceneIntent() {
  header("Intent guard", "a question gets answered, not silently acted on");
  for (const [kind, prompt] of [
    ["question", "Why does add() in math.js return the wrong value?"],
    ["request", "Fix add() so it returns a + b."],
  ]) {
    process.stdout.write(`  ${pad(`${kind}: ${prompt.slice(0, 36)}`, 50)}`);
    await run("intent-guard.mjs", { hook_event_name: "UserPromptSubmit", prompt, session_id: `demo-${kind}`, prompt_id: `p-${kind}`, cwd: PROJECT });
    const d = last("intent");
    const flagged = d.decision === "answer-only";
    console.log(`${pad(flagged ? c.yellow("ANSWER ONLY") : c.green("changes ok"), 12)} ${c.dim(`p_answer_only=${d.probabilities.answer_only.toFixed(2)}`)}  ${c.dim(`${d.latency_ms} ms`)}`);
  }
  process.stdout.write(`  ${pad("…Claude edits a file in the question turn", 50)}`);
  const r = await run("rule-guard.mjs", editPayload("src/api.ts", "Edit", { old_string: "a", new_string: "b" }, { session_id: "demo-question", prompt_id: "p-question" }));
  console.log(`${pad(verdict(Boolean(r.stdout), "ASK"), 12)} ${c.dim("marker only, no API call")}  ${c.dim("0 ms")}`);
  if (r.stdout) console.log(`    ${c.yellow("↳")} ${c.dim("Intent guard: answer the question instead of editing files.")}`);
}

async function stopCase(gate, title, prompt, tools, reply) {
  process.stdout.write(`  ${pad(title, 50)}`);
  const payload = { hook_event_name: "Stop", transcript_path: transcript(prompt, tools), stop_hook_active: false, last_assistant_message: reply };
  const r = await run("stop-gate.mjs", payload, gate === "done" ? { JEV_GATES_CLAIMS: "off" } : { JEV_GATES_DONE: "off" });
  const d = last(gate);
  const blocked = r.code === 2;
  if (gate === "done") {
    const asks = d.scored.filter((s) => s.request >= d.thresholds.request);
    console.log(`${pad(verdict(blocked, "BLOCK"), 12)} ${c.dim(`asks=${asks.length} missing=${asks.filter((s) => s.done <= d.thresholds.done).length}`)}  ${c.dim(`${d.latency_ms} ms`)}`);
    for (const s of asks) bullet(s.done <= d.thresholds.done, `addressed=${s.done.toFixed(2)}`, s.ask);
  } else {
    const claims = d.scored.filter((s) => s.isClaim >= d.thresholds.claim);
    console.log(`${pad(verdict(blocked, "BLOCK"), 12)} ${c.dim(`claims=${claims.length} unsupported=${claims.filter((s) => s.evidence <= d.thresholds.evidence).length}`)}  ${c.dim(`${d.latency_ms} ms`)}`);
    for (const s of claims) bullet(s.evidence <= d.thresholds.evidence, `evidence=${s.evidence.toFixed(2)}`, s.claim);
  }
}

async function sceneDone() {
  header("Done gate", "Claude cannot stop while an ask is unaddressed");
  const three = "Three things: fix the bug in math.js so add() actually adds. Add a one-line usage example to README.md. Finally, tell me in one sentence what the bug was.";
  const two = "Two things: fix the bug in math.js so add() actually adds, and add a one-line usage example to README.md.";
  await stopCase("done", "3 asks, all done", three, [{ name: "Edit", input: { file_path: "math.js" } }, { name: "Edit", input: { file_path: "README.md" } }], "Fixed: add() returned a - b, now a + b. Added a usage line to README.md. The bug was a subtraction operator where addition was intended.");
  await stopCase("done", "2 asks, README silently skipped", two, [{ name: "Edit", input: { file_path: "math.js" } }], "Fixed: add() returned a - b, now a + b. Verified add(2, 3) === 5.");
  await stopCase("done", "2 asks, README declined with a reason", two, [{ name: "Edit", input: { file_path: "math.js" } }], "Fixed: add() returned a - b, now a + b. I did not touch README.md: it is generated from docs/ by the release script, so an edit there would be overwritten.");
}

async function sceneClaims() {
  header("Claims gate", '"all tests pass" checked against what actually ran');
  const reply = "I changed a - b to a + b in math.js. I ran the test suite and all 12 tests pass.";
  const edit = { name: "Edit", input: { file_path: "math.js" }, result: "Applied 1 edit to math.js" };
  await stopCase("claims", "claims a test run that never happened", "Fix add() in math.js.", [edit], reply);
  await stopCase("claims", "same reply, with the test run in evidence", "Fix add() in math.js.", [edit, { name: "Bash", input: { command: "npm test" }, result: "PASS math.test.js\n\nTests:  12 passed, 12 total" }], reply);
}

async function sceneCommit() {
  header("Commit guard", "the commit message checked against the staged diff");
  const repo = join(OUT, "repo");
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "demo@example.com");
  git("config", "user.name", "demo");
  writeFileSync(join(repo, "math.js"), "export const add = (a, b) => a - b;\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  writeFileSync(join(repo, "math.js"), "export const add = (a, b) => a + b;\n");
  git("add", "-A");
  console.log(c.dim("  staged diff: one line in math.js, a - b becomes a + b\n"));

  for (const [title, message] of [
    ["message matches the diff", ["fix: add() used subtraction instead of addition"]],
    ["message also claims tests and docs", ["fix: add() used subtraction instead of addition", "Added unit tests covering add(). Updated the README usage section."]],
  ]) {
    process.stdout.write(`  ${pad(title, 50)}`);
    const command = message.map((part) => `-m ${JSON.stringify(part)}`).join(" ");
    await run("commit-guard.mjs", { hook_event_name: "PreToolUse", tool_name: "Bash", cwd: repo, tool_input: { command: `git commit ${command}` } });
    const d = last("commit");
    const claims = d.scored.filter((s) => s.isClaim >= d.thresholds.claim);
    console.log(`${pad(verdict(d.decision !== "pass", "ASK"), 12)} ${c.dim(`claims=${claims.length} unsupported=${claims.filter((s) => s.inDiff <= d.thresholds.in_diff).length}`)}  ${c.dim(`${d.latency_ms} ms`)}`);
    for (const s of claims) bullet(s.inDiff <= d.thresholds.in_diff, `in_diff=${s.inDiff.toFixed(2)}`, s.claim);
  }
}

const SCENES = { rules: sceneRules, scope: sceneScope, intent: sceneIntent, done: sceneDone, claims: sceneClaims, commit: sceneCommit };

async function main() {
  const which = process.argv[2] ?? "all";
  rmSync(DATA, { recursive: true, force: true });
  mkdirSync(DATA, { recursive: true });
  console.log(c.bold("\njev-gates") + c.dim("  live run against api.typesafe.ai, nothing staged"));
  for (const name of which === "all" ? Object.keys(SCENES) : [which]) {
    const scene = SCENES[name];
    if (!scene) throw new Error(`Unknown scene: ${name}. One of: ${Object.keys(SCENES).join(", ")}, all`);
    await scene();
  }
  console.log(c.dim("\n  log: demo/out/data/decisions.log\n"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

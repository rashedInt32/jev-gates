#!/usr/bin/env node
// Live demo: replays hook payloads through the real hook scripts against the
// real TypeSafe API and prints what each gate decided.
//
// Nothing here is staged. The probabilities and latencies are whatever Jev
// returns when you run it. The payloads mirror what Claude Code sent during
// the sessions recorded in the README, with paths pointing at demo/fixtures.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIX = join(ROOT, "demo", "fixtures");
const PROJECT = join(FIX, "project");
const OUT = join(ROOT, "demo", "out");
const DATA = join(OUT, "data");

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

function run(script, payload) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, "hooks", script)], {
      env: { ...process.env, JEV_GATES: "active", JEV_GATES_DIR: DATA, JEV_GATES_RULE_FILES: join(PROJECT, "CLAUDE.md") },
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

function last(name) {
  return JSON.parse(readFileSync(join(DATA, `last-${name}.json`), "utf8"));
}

function transcript(prompt, tools) {
  const lines = [];
  let n = 0;
  const push = (o) => lines.push(JSON.stringify({ uuid: `u${n++}`, sessionId: "demo", ...o }));
  push({ type: "user", message: { role: "user", content: prompt } });
  for (const t of tools) {
    push({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `t${n}`, name: t.name, input: t.input }] } });
    push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${n}`, content: "ok" }] } });
  }
  const path = join(OUT, `transcript-${n}.jsonl`);
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

const pad = (s, n) => (s.length >= n ? s : s + " ".repeat(n - s.length));

async function editCase(title, tool, tool_input) {
  process.stdout.write(`  ${pad(title, 54)}`);
  const started = performance.now();
  const r = await run("rule-guard.mjs", { hook_event_name: "PreToolUse", tool_name: tool, cwd: PROJECT, tool_input });
  const d = last("edit");
  const top = d.scored[0];
  const tag = d.decision === "pass" ? c.green("pass") : c.red(d.decision.toUpperCase());
  console.log(`${pad(tag, 13)} ${c.dim(`p=${top.p.toFixed(2)}`)}  ${c.dim(`${d.latency_ms} ms`)}`);
  if (r.stdout) {
    const reason = JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason.split("\n")[1];
    console.log(`    ${c.yellow("↳")} ${c.dim(reason.replace(/\s*\(p=.*$/, ""))}`);
  }
  void started;
}

async function doneCase(title, prompt, tools, last_assistant_message) {
  process.stdout.write(`  ${pad(title, 54)}`);
  const r = await run("done-gate.mjs", { hook_event_name: "Stop", transcript_path: transcript(prompt, tools), stop_hook_active: false, last_assistant_message });
  const d = last("done");
  const missing = d.scored.filter((s) => s.request >= d.thresholds.request && s.done <= d.thresholds.done);
  const tag = r.code === 2 ? c.red("BLOCK") : c.green("pass");
  console.log(`${pad(tag, 13)} ${c.dim(`asks=${d.requests} missing=${missing.length}`)} ${c.dim(`${d.latency_ms} ms`)}`);
  for (const s of d.scored.filter((s) => s.request >= d.thresholds.request)) {
    const mark = s.done <= d.thresholds.done ? c.red("✗") : c.green("✓");
    const ask = s.ask.length > 74 ? s.ask.slice(0, 71) + "..." : s.ask;
    console.log(`    ${mark} ${c.dim(`addressed=${s.done.toFixed(2)}`)}  ${ask}`);
  }
}

async function main() {
  // Clear only the decision data. VHS writes its renders into OUT while this runs.
  rmSync(DATA, { recursive: true, force: true });
  mkdirSync(DATA, { recursive: true });

  console.log(c.bold("\njev-gates") + c.dim("  live run against api.typesafe.ai, nothing staged\n"));
  console.log(c.cyan("Rule guard") + c.dim("  every edit checked against CLAUDE.md before it lands"));
  console.log(c.dim(`  rules: ${readFileSync(join(PROJECT, "CLAUDE.md"), "utf8").trim().split("\n").filter((l) => l.startsWith("- ")).length} from demo/fixtures/project/CLAUDE.md\n`));

  await editCase("Edit src/schema/user.graphql  add email field", "Edit", {
    file_path: join(PROJECT, "src/schema/user.graphql"),
    old_string: "type User { id: ID!, name: String! }",
    new_string: "type User { id: ID!, name: String!, email: String }",
  });
  await editCase("Edit src/generated/types.ts  add email field", "Edit", {
    file_path: join(PROJECT, "src/generated/types.ts"),
    old_string: "export type User = { id: string; name: string };",
    new_string: "export type User = { id: string; name: string; email?: string };",
  });
  await editCase("Write src/api.ts  new handler using console.log", "Write", {
    file_path: join(PROJECT, "src/api.ts"),
    content: 'export function handler(req) {\n  console.log("request", req.url);\n  return { ok: true };\n}\n',
  });
  await editCase("Write src/api.ts  same handler using the repo logger", "Write", {
    file_path: join(PROJECT, "src/api.ts"),
    content: 'import { log } from "./log.js";\n/** Handle one request and report it through the repo logger. */\nexport function handler(req) {\n  log(`request ${req.url}`);\n  return { ok: true };\n}\n',
  });

  console.log("\n" + c.cyan("Done gate") + c.dim("  Claude cannot stop while an ask is unaddressed\n"));

  await doneCase(
    "3 asks, all done",
    "Three things: fix the bug in math.js so add() actually adds. Add a one-line usage example to README.md. Finally, tell me in one sentence what the bug was.",
    [{ name: "Edit", input: { file_path: "math.js" } }, { name: "Edit", input: { file_path: "README.md" } }],
    "Fixed: add() returned a - b, now a + b. Added a usage line to README.md. The bug was a subtraction operator where addition was intended.",
  );
  await doneCase(
    "2 asks, README silently skipped",
    "Two things: fix the bug in math.js so add() actually adds, and add a one-line usage example to README.md.",
    [{ name: "Edit", input: { file_path: "math.js" } }],
    "Fixed: add() returned a - b, now a + b. Verified add(2, 3) === 5.",
  );
  await doneCase(
    "2 asks, README explicitly declined with a reason",
    "Two things: fix the bug in math.js so add() actually adds, and add a one-line usage example to README.md.",
    [{ name: "Edit", input: { file_path: "math.js" } }],
    "Fixed: add() returned a - b, now a + b. I did not touch README.md: it is generated from docs/ by the release script, so an edit there would be overwritten. Tell me if you want the source changed instead.",
  );

  console.log(c.dim(`\n  log: ${join(DATA, "decisions.log").replace(process.env.HOME ?? "", "~")}\n`));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

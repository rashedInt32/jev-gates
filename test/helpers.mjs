// Test rig: a local stand-in for the TypeSafe API and a runner that drives a
// hook script over stdin exactly the way Claude Code does.

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Start a stand-in API. `plan(id, question)` returns the probability for a
 * question; default 0.05. Every request body is recorded.
 */
export async function startMock(plan = () => 0.05) {
  const requests = [];
  const state = { status: 200, plan };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      requests.push(body);
      res.setHeader("content-type", "application/json");
      if (state.status !== 200) {
        res.writeHead(state.status);
        res.end(JSON.stringify({ error: { message: "mock failure" } }));
        return;
      }
      const answers = {};
      for (const [id, q] of Object.entries(body.questions ?? {})) {
        answers[id] = { type: "noul", noul: state.plan(id, q) };
      }
      res.writeHead(200);
      res.end(JSON.stringify({ model: "mock-jev", answers, usage: { input_tokens: 10, output_tokens: 2 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** A fresh temp directory for a fake project or data dir. */
export function tempDir(prefix = "jev-gates-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Run a hook script with a JSON payload on stdin. */
export function runHook(script, input, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, "hooks", script)], {
      env: {
        PATH: process.env.PATH,
        HOME: env.HOME ?? tempDir("home-"),
        JEV_KEY_FILE: "/nonexistent/jev-gates/key",
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

/** Write a transcript in Claude Code's JSONL shape. */
export function writeTranscript(dir, { prompt, tools = [], assistantText = "", earlier = [] }) {
  const lines = [];
  let n = 0;
  const push = (o) => lines.push(JSON.stringify({ uuid: `u${n++}`, sessionId: "s", ...o }));
  for (const text of earlier) {
    push({ type: "user", message: { role: "user", content: text } });
    push({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } });
  }
  push({ type: "user", message: { role: "user", content: prompt } });
  for (const t of tools) {
    push({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `t${n}`, name: t.name, input: t.input }] } });
    push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${n}`, content: "done" }] } });
  }
  if (assistantText) push({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: assistantText }] } });
  const path = join(dir, "transcript.jsonl");
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

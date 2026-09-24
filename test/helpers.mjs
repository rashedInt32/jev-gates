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
 * noul question (default 0.05), or the chosen key for a choice question
 * (default: the first option). Every request body is recorded.
 */
export async function startMock(plan = () => undefined) {
  const requests = [];
  const state = { status: 200, plan, connections: 0, heads: 0, headKeys: 0 };
  const server = createServer((req, res) => {
    // The broker's connection warm-up. Not a judgment, so it is not recorded as one.
    if (req.method === "HEAD") {
      state.heads += 1;
      if (req.headers.authorization) state.headKeys += 1;
      // An explicit empty body, as real servers send; without it Node drops the connection.
      res.writeHead(405, { "content-length": 0 });
      return res.end();
    }
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
        const planned = state.plan(id, q);
        if (q.type === "noul") {
          answers[id] = { type: "noul", noul: typeof planned === "number" ? planned : 0.05 };
        } else {
          const keys = Object.keys(q.criteria);
          const pick = typeof planned === "string" && keys.includes(planned) ? planned : keys[0];
          const probabilities = Object.fromEntries(keys.map((k) => [k, k === pick ? 0.9 : 0.1 / (keys.length - 1)]));
          answers[id] = { type: "choice", choice: pick, confidence: 0.9, probabilities };
        }
      }
      res.writeHead(200);
      res.end(JSON.stringify({ model: "mock-jev", answers, usage: { input_tokens: 10, output_tokens: 2 } }));
    });
  });
  server.on("connection", () => (state.connections += 1));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    state,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
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

/**
 * Write a transcript in Claude Code's JSONL shape. Each tool may carry a
 * `result` string, recorded as the paired tool_result.
 */
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
    const id = `t${n}`;
    push({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: t.name, input: t.input }] } });
    push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: t.result ?? "done" }] } });
  }
  if (assistantText) push({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: assistantText }] } });
  const path = join(dir, "transcript.jsonl");
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

export const KEY_VAR = ["TYPESAFE", "API", "KEY"].join("_");

/** Environment for a hook run against a mock, with isolated data and home. */
export function hookEnv(mock, extra = {}) {
  // Direct calls by default, so request counts are exact; test/broker.test.mjs turns the broker on.
  return { [KEY_VAR]: "k", JEV_GATES_BASE_URL: mock.url, JEV_GATES_DIR: tempDir("data-"), HOME: tempDir("home-"), JEV_GATES_BROKER: "off", ...extra };
}

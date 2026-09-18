import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runHook, startMock, tempDir, writeTranscript } from "./helpers.mjs";

const KEY_VAR = ["TYPESAFE", "API", "KEY"].join("_");

const PROMPT = "Fix the failing test in auth.test.ts. Update the README to mention the new flag. Thanks, you are doing great.";

/** Every sentence but the thanks is a request; only the README ask went unaddressed. */
const plan = (id, q) => {
  if (id.startsWith("req")) return /thanks/i.test(q.instructions.sentence) ? 0.05 : 0.95;
  return /readme/i.test(q.instructions.ask) ? 0.08 : 0.97;
};

function stopInput(transcript_path, extra = {}) {
  return { hook_event_name: "Stop", transcript_path, stop_hook_active: false, last_assistant_message: "Fixed the test; the suite is green.", ...extra };
}

test("an unaddressed ask blocks the stop once with the ask named", async () => {
  const mock = await startMock(plan);
  const dir = tempDir();
  const data = tempDir("data-");
  try {
    const transcript = writeTranscript(dir, { prompt: PROMPT, tools: [{ name: "Edit", input: { file_path: "auth.test.ts" } }] });
    const env = { [KEY_VAR]: "k", JEV_GATES_BASE_URL: mock.url, JEV_GATES_DIR: data, HOME: tempDir("home-") };

    const first = await runHook("done-gate.mjs", stopInput(transcript), env);
    assert.equal(first.code, 2, "exit 2 blocks the stop");
    assert.match(first.stderr, /1 of 2 asks/);
    assert.match(first.stderr, /Update the README/);
    assert.doesNotMatch(first.stderr, /Thanks/);
    assert.equal(first.stdout, "");

    const body = mock.requests[0];
    assert.equal(Object.keys(body.questions).length, 6, "two questions per candidate sentence");
    assert.deepEqual(body.state.tools_the_assistant_ran_this_turn, ["Edit auth.test.ts"]);
    assert.equal(body.state.assistant_final_response, "Fixed the test; the suite is green.");

    // The second stop of the same turn is never gated.
    const second = await runHook("done-gate.mjs", stopInput(transcript, { stop_hook_active: true }), env);
    assert.equal(second.code, 0);
    assert.equal(mock.requests.length, 1);

    const log = readFileSync(join(data, "decisions.log"), "utf8");
    assert.match(log, /\tdone\tactive\tblock\tasks=2\/3\tmissing=1\t/);
    assert.match(log, /\tdone\tactive\tsecond-stop\t/);
  } finally {
    await mock.close();
  }
});

test("everything addressed, or an explicit decline, lets Claude stop", async () => {
  const mock = await startMock((id) => (id.startsWith("req") ? 0.9 : 0.9));
  const dir = tempDir();
  try {
    const transcript = writeTranscript(dir, { prompt: PROMPT });
    const env = { [KEY_VAR]: "k", JEV_GATES_BASE_URL: mock.url, JEV_GATES_DIR: tempDir("data-"), HOME: tempDir("home-") };
    const run = await runHook("done-gate.mjs", stopInput(transcript), env);
    assert.equal(run.code, 0);
    assert.equal(run.stderr, "");
  } finally {
    await mock.close();
  }
});

test("shadow mode records would-block and never exits 2", async () => {
  const mock = await startMock(plan);
  const dir = tempDir();
  const data = tempDir("data-");
  try {
    const transcript = writeTranscript(dir, { prompt: PROMPT });
    const env = { [KEY_VAR]: "k", JEV_GATES_BASE_URL: mock.url, JEV_GATES_DIR: data, JEV_GATES: "shadow", HOME: tempDir("home-") };
    const run = await runHook("done-gate.mjs", stopInput(transcript), env);
    assert.equal(run.code, 0);
    assert.equal(run.stderr, "");
    assert.match(readFileSync(join(data, "decisions.log"), "utf8"), /\tdone\tshadow\twould-block\t/);
  } finally {
    await mock.close();
  }
});

test("no prompt, no key, or an API failure means Claude stops normally", async () => {
  const mock = await startMock(plan);
  const dir = tempDir();
  try {
    const base = { JEV_GATES_BASE_URL: mock.url, JEV_GATES_DIR: tempDir("data-"), HOME: tempDir("home-") };
    const transcript = writeTranscript(dir, { prompt: PROMPT });

    const noKey = await runHook("done-gate.mjs", stopInput(transcript), base);
    assert.equal(noKey.code, 0);

    const onlyCommand = writeTranscript(tempDir(), { prompt: "<command-name>/model</command-name>" });
    const noPrompt = await runHook("done-gate.mjs", stopInput(onlyCommand), { ...base, [KEY_VAR]: "k" });
    assert.equal(noPrompt.code, 0);
    assert.equal(mock.requests.length, 0);

    mock.state.status = 503;
    const failed = await runHook("done-gate.mjs", stopInput(transcript), { ...base, [KEY_VAR]: "k" });
    assert.equal(failed.code, 0);
    assert.equal(failed.stderr, "");
  } finally {
    await mock.close();
  }
});

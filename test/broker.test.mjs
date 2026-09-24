import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, statSync } from "node:fs";
import net from "node:net";
import { socketPath } from "../lib/broker.mjs";
import { ask, noul, readConfig } from "../lib/jev.mjs";
import { startMock, tempDir } from "./helpers.mjs";

const questions = { q: noul("Is this a question?", "yes", "no") };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await sleep(25);
  }
  return false;
}

function configFor(mock, extra = {}) {
  return readConfig({ JEV_GATES_BASE_URL: mock.url, JEV_GATES_DIR: tempDir("broker-"), JEV_GATES_BROKER_IDLE_MS: "1500", ...extra });
}

test("the first call goes direct and starts a broker; later calls reuse one warm connection", async () => {
  const mock = await startMock(() => 0.8);
  try {
    const config = configFor(mock);
    const first = await ask({ config, key: "k", state: { prompt: "a" }, questions });
    assert.equal(first.via, "direct");
    assert.equal(first.answers.q, 0.8);
    assert.ok(await waitFor(() => existsSync(socketPath(config)) && mock.state.heads === 1), "broker socket appears and warms up");
    assert.equal(statSync(socketPath(config)).mode & 0o777, 0o600);

    const before = mock.state.connections;
    const second = await ask({ config, key: "k", state: { prompt: "b" }, questions });
    const third = await ask({ config, key: "k", state: { prompt: "c" }, questions });
    assert.equal(second.via, "broker");
    assert.equal(third.via, "broker");
    assert.equal(third.answers.q, 0.8);
    assert.equal(mock.state.connections - before, 0, "both broker calls ride the connection the warm-up opened");
    assert.equal(mock.requests.length, 3);
  } finally {
    await mock.close();
  }
});

test("a broker started for another API refuses, and the call still succeeds directly", async () => {
  const mockA = await startMock(() => 0.2);
  const mockB = await startMock(() => 0.7);
  try {
    const configA = configFor(mockA);
    await ask({ config: configA, key: "k", state: {}, questions });
    assert.ok(await waitFor(() => existsSync(socketPath(configA))));

    // Same data dir, different base URL: the broker must not forward it.
    const configB = { ...configA, baseUrl: mockB.url };
    const result = await ask({ config: configB, key: "k", state: {}, questions });
    assert.equal(result.via, "direct");
    assert.equal(result.answers.q, 0.7);
    assert.equal(mockB.requests.length, 1);
    assert.equal(mockA.requests.length, 1);
  } finally {
    await mockA.close();
    await mockB.close();
  }
});

test("a request from a different install is refused and the stale broker exits", async () => {
  const mock = await startMock();
  try {
    const config = configFor(mock, { JEV_GATES_BROKER_IDLE_MS: "60000" });
    await ask({ config, key: "k", state: {}, questions });
    assert.ok(await waitFor(() => existsSync(socketPath(config))));

    const reply = await new Promise((resolve) => {
      const sock = net.connect(socketPath(config), () => sock.end(JSON.stringify({ protocol: 1, id: "/elsewhere/broker.mjs", baseUrl: config.baseUrl, key: "k", body: "{}" }) + "\n"));
      let raw = "";
      sock.on("data", (d) => (raw += d));
      sock.on("end", () => resolve(JSON.parse(raw)));
    });
    assert.equal(reply.refused, "stale broker");
    assert.ok(await waitFor(() => !existsSync(socketPath(config))), "stale broker removes its socket");
  } finally {
    await mock.close();
  }
});

test("an idle broker exits and removes its socket; JEV_GATES_BROKER=off never starts one", async () => {
  const mock = await startMock();
  try {
    const config = configFor(mock, { JEV_GATES_BROKER_IDLE_MS: "300" });
    await ask({ config, key: "k", state: {}, questions });
    assert.ok(await waitFor(() => existsSync(socketPath(config))));
    assert.ok(await waitFor(() => !existsSync(socketPath(config)), 3000), "idle broker exits");

    const off = configFor(mock, { JEV_GATES_BROKER: "off" });
    const result = await ask({ config: off, key: "k", state: {}, questions });
    assert.equal(result.via, "direct");
    await sleep(300);
    assert.equal(existsSync(socketPath(off)), false);
  } finally {
    await mock.close();
  }
});

test("secrets in the state are redacted before any request leaves", async () => {
  const mock = await startMock();
  try {
    const config = configFor(mock, { JEV_GATES_BROKER: "off" });
    const secret = ["0f1e2d3c", "4b5a", "4978", "8a6b", "5c4d3e2f1a0b"].join("-");
    await ask({ config, key: "k", state: { command: `curl -H "Api-Key: ${secret}" x`, nested: [{ note: `token=${secret}` }] }, questions });
    const sent = JSON.stringify(mock.requests[0]);
    assert.ok(!sent.includes(secret), sent);
    assert.match(sent, /Api-Key: \[redacted\]/);
  } finally {
    await mock.close();
  }
});

test("clipping never leaves part of a secret behind", async () => {
  const { clip } = await import("../lib/jev.mjs");
  const token = "gh" + "p_" + "Q7xk2mP9vL4nR8sT1wY6zB3cD5fG0hJ2kL4mN6";
  const command = "cd ~/Documents/codes/packages/some-long-project-name && git clone https://" + token + "@github.com/o/r.git";
  for (const max of [60, 87, 90, 100, 120]) {
    const out = clip(command, max);
    assert.ok(!out.includes("Q7xk2mP9vL"), `max ${max}: ${out}`);
  }
});

test("a dead pooled connection costs a retry, not a judgment", async () => {
  const { createServer } = await import("node:http");
  // Answers the first request on each connection and resets the second, like a
  // keep-alive socket that died while the laptop slept.
  const server = createServer((req, res) => {
    req.socket.seen = (req.socket.seen ?? 0) + 1;
    if (req.socket.seen >= 2) return req.socket.destroy();
    req.resume();
    req.on("end", () => res.end(JSON.stringify({ answers: { q: { type: "noul", noul: 0.6 } } })));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const config = readConfig({ JEV_GATES_BASE_URL: `http://127.0.0.1:${server.address().port}`, JEV_GATES_DIR: tempDir("broker-"), JEV_GATES_BROKER_IDLE_MS: "1500" });
    await ask({ config, key: "k", state: {}, questions });
    assert.ok(await waitFor(() => existsSync(socketPath(config))));
    for (let i = 0; i < 4; i += 1) {
      const result = await ask({ config, key: "k", state: { i }, questions });
      assert.equal(result.answers.q, 0.6, `call ${i}`);
    }
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test("brokers racing over a stale socket file leave exactly one reachable", async () => {
  const { spawnBroker } = await import("../lib/broker.mjs");
  const { writeFileSync } = await import("node:fs");
  const mock = await startMock(() => 0.5);
  try {
    for (let round = 0; round < 3; round += 1) {
      const config = configFor(mock, { JEV_GATES_BROKER_IDLE_MS: "1200" });
      writeFileSync(socketPath(config), ""); // left behind by a crash
      for (let i = 0; i < 4; i += 1) spawnBroker(config);
      let reached = false;
      const end = Date.now() + 3500;
      while (Date.now() < end) {
        const result = await ask({ config, key: "k", state: {}, questions });
        if (result.via === "broker") reached = true;
        // Once a broker answers, losers timing out must never strand it.
        else assert.equal(reached, false, `round ${round}: broker became unreachable`);
        await sleep(150);
      }
      assert.ok(reached, `round ${round}: a broker came up`);
    }
  } finally {
    await mock.close();
  }
});

test("a new broker opens its connection before the first request, without a key", async () => {
  const mock = await startMock(() => 0.8);
  try {
    const config = configFor(mock);
    await ask({ config, key: "k", state: {}, questions });
    assert.ok(await waitFor(() => existsSync(socketPath(config)) && mock.state.heads === 1), "broker warms up on start");
    assert.equal(mock.state.headKeys, 0, "the warm-up carries no key");
    const before = mock.state.connections;
    const first = await ask({ config, key: "k", state: {}, questions });
    assert.equal(first.via, "broker");
    assert.equal(mock.state.connections - before, 0, "the first broker call reuses the warm connection");
  } finally {
    await mock.close();
  }
});

test("an idle broker lives for an hour by default", () => {
  assert.equal(readConfig({}).brokerIdleMs, 3_600_000);
});

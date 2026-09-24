// Warm connection broker. Every hook is a fresh process, so every Jev call used
// to pay a new TCP and TLS handshake: about 650 ms of a ~1,050 ms call. This
// small local process holds one keep-alive connection and forwards requests
// that hooks send it over a Unix socket in the data directory.
//
// Run directly (`node lib/broker.mjs`) it is the server. Imported, it is the
// client. The server holds no secret: the key travels with each request over
// a socket only this user can open, and is never stored.
//
// Nothing here may cost a judgment. A hook that finds no broker spawns one and
// calls Jev directly; any refusal or connection error falls back to direct.

import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const PROTOCOL = 1;

export function socketPath(config) {
  return join(config.dataDir, "broker.sock");
}

// ── Client ─────────────────────────────────────────────────────────────────

/** Errors that mean "no usable broker here": fall back to a direct call. */
export class BrokerUnavailable extends Error {}

/**
 * Send one request through the broker. Resolves `{ status, text }`. Rejects
 * with BrokerUnavailable when there is no broker or it refuses the request,
 * and with a plain Error when a request it accepted fails or times out.
 */
export function brokerPost(config, key, bodyText) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath(config));
    let accepted = false;
    let raw = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(accepted ? new Error("broker timed out") : new BrokerUnavailable("broker did not answer"));
    }, config.timeoutMs);
    sock.setEncoding("utf8");
    sock.on("connect", () => {
      accepted = true;
      sock.end(JSON.stringify({ protocol: PROTOCOL, id: SELF, baseUrl: config.baseUrl, key, body: bodyText, timeoutMs: config.timeoutMs }) + "\n");
    });
    sock.on("data", (d) => (raw += d));
    sock.on("error", (err) => {
      clearTimeout(timer);
      reject(accepted ? err : new BrokerUnavailable(err.code ?? err.message));
    });
    sock.on("end", () => {
      clearTimeout(timer);
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return reject(new BrokerUnavailable("broker sent no reply"));
      }
      if (msg.refused) return reject(new BrokerUnavailable(`broker refused: ${msg.refused}`));
      // The broker could not reach the API; a direct call may still succeed.
      if (msg.error) return reject(new BrokerUnavailable(`broker upstream failed: ${msg.error}`));
      resolve({ status: msg.status, text: msg.text });
    });
  });
}

/** Start a broker in the background. Losing a start race is harmless. */
export function spawnBroker(config) {
  try {
    // The broker reads the caller's settings, and gets no key: keys come per request.
    const env = { ...process.env, JEV_GATES_DIR: config.dataDir, JEV_GATES_BASE_URL: config.baseUrl, JEV_GATES_BROKER_IDLE_MS: String(config.brokerIdleMs) };
    delete env.TYPESAFE_API_KEY;
    delete env.JEV_API_KEY;
    const child = spawn(process.execPath, [SELF], { detached: true, stdio: "ignore", env });
    child.unref();
  } catch {
    // no broker this time; direct calls still work
  }
}

// ── Server ─────────────────────────────────────────────────────────────────

async function serve() {
  const { readConfig } = await import("./jev.mjs");
  const config = readConfig();
  const path = socketPath(config);
  const target = new URL(config.baseUrl);
  const transport = target.protocol === "https:" ? https : http;
  const agent = new transport.Agent({ keepAlive: true, maxSockets: 8 });

  let idle;
  let ownInode = null;
  const stop = () => {
    clearTimeout(idle);
    server.close();
    agent.destroy();
    // Remove the socket file only while it is still ours: a broker that lost a
    // start race must not strand the one that won.
    try {
      if (ownInode !== null && statSync(path).ino === ownInode) unlinkSync(path);
    } catch {
      // already gone
    }
    process.exit(0);
  };
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(stop, config.brokerIdleMs);
  };

  const forward = (msg, attempt = 0) =>
    new Promise((resolve) => {
      const req = transport.request(
        config.baseUrl,
        { method: "POST", agent, timeout: msg.timeoutMs, headers: { "content-type": "application/json", authorization: `Bearer ${msg.key}` } },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (d) => (text += d));
          res.on("end", () => resolve({ status: res.statusCode, text }));
          res.on("error", (err) => resolve({ error: err.message }));
        },
      );
      req.on("timeout", () => req.destroy(new Error("upstream timed out")));
      req.on("error", (err) => {
        // A pooled connection can die unnoticed (sleep, NAT timeout, network change). Retry once fresh.
        if (attempt === 0 && req.reusedSocket && /ECONNRESET|EPIPE/.test(err.code ?? "")) return resolve(forward(msg, 1));
        resolve({ error: err.message });
      });
      req.end(msg.body);
    });

  // Open the upstream connection now, so the first request routed here does not
  // pay the handshake. HEAD with no key: the API refuses it, nothing is billed,
  // and the kept-alive socket goes back to the pool for the first real call.
  // A request arriving mid-handshake waits for it rather than opening a second
  // cold connection: joining a handshake under way is never slower than a new one.
  let warming = Promise.resolve();
  const warm = () => {
    warming = new Promise((done) => {
      const req = transport.request(config.baseUrl, { method: "HEAD", agent, timeout: config.timeoutMs }, (res) => {
        // The agent pools the socket just after "end"; wait for that before releasing requests.
        res.on("end", () => setImmediate(done));
        res.resume();
      });
      req.on("timeout", () => req.destroy());
      req.on("error", done);
      req.end();
    });
  };

  // Clients half-close after sending, so the reply needs the write side kept open.
  const server = net.createServer({ allowHalfOpen: true }, (sock) => {
    touch();
    let raw = "";
    sock.setEncoding("utf8");
    sock.on("error", () => {});
    sock.on("data", async (d) => {
      raw += d;
      if (!raw.includes("\n")) return;
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return sock.end(JSON.stringify({ refused: "bad request" }));
      }
      // A different plugin install or a different API: not ours to serve.
      if (msg.protocol !== PROTOCOL || msg.id !== SELF) {
        sock.end(JSON.stringify({ refused: "stale broker" }));
        return setTimeout(stop, 50);
      }
      if (msg.baseUrl !== config.baseUrl) return sock.end(JSON.stringify({ refused: "different base URL" }));
      if (typeof msg.key !== "string" || typeof msg.body !== "string") return sock.end(JSON.stringify({ refused: "bad request" }));
      await warming;
      sock.end(JSON.stringify(await forward(msg)));
    });
  });

  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  server.on("error", () => process.exit(0));
  // A live broker owns the socket: leave. Otherwise bind a private name, lock it
  // down, and rename it over whatever sits at the path, stale file included.
  // Rename is atomic, so no client ever sees a missing or half-made socket.
  const probe = net.connect(path);
  probe.on("connect", () => {
    probe.destroy();
    process.exit(0);
  });
  probe.on("error", () => {
    const temp = `${path}.${process.pid}`;
    try {
      unlinkSync(temp);
    } catch {
      // none left over
    }
    server.listen(temp, () => {
      try {
        chmodSync(temp, 0o600);
        renameSync(temp, path);
        ownInode = statSync(path).ino;
      } catch {
        process.exit(0);
      }
      touch();
      warm();
    });
  });
}

if (process.argv[1] === SELF) serve().catch(() => process.exit(0));

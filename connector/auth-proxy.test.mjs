import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash, createHmac, randomBytes } from "node:crypto";

import { createProxyServer } from "./auth-proxy.mjs";

const SECRET = "test-secret-not-for-production";

function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

function hmacHex(secret, message) {
  return createHmac("sha256", secret).update(message).digest("hex");
}

// Independent reimplementation of the canonical form from src/sign.ts:
// METHOD \n PATH \n TIMESTAMP \n NONCE \n SHA256HEX(BODY)
function sign({ method, path, timestamp, nonce, body }) {
  const canonical = [method, path, String(timestamp), nonce, sha256Hex(body)].join("\n");
  return hmacHex(SECRET, canonical);
}

function signedHeaders({
  method,
  path,
  body = "",
  nonce = randomBytes(16).toString("hex"),
  timestamp = Math.floor(Date.now() / 1000),
}) {
  return {
    "x-hvo-timestamp": String(timestamp),
    "x-hvo-nonce": nonce,
    "x-hvo-signature": sign({ method, path, timestamp, nonce, body }),
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function call(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// Fake upstream: echoes method + path + body, and reports which x-hvo-* headers
// leaked through. It never interprets signatures itself.
async function withStack(fn) {
  const state = { hits: 0 };

  const upstream = http.createServer((req, res) => {
    state.hits += 1;
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      res.writeHead(200, {
        "content-type": "application/json",
        "x-upstream": "yes",
      });
      res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          body: Buffer.concat(chunks).toString("utf8"),
          hvoHeaders: Object.keys(req.headers).filter((name) => name.startsWith("x-hvo-")),
          clientMeta: req.headers["x-client-meta"] ?? null,
        }),
      );
    });
  });
  const upstreamPort = await listen(upstream);

  const proxy = createProxyServer({
    secret: SECRET,
    upstream: `http://127.0.0.1:${upstreamPort}`,
  });
  const proxyPort = await listen(proxy);

  try {
    return await fn({ proxyPort, state });
  } finally {
    await close(proxy);
    await close(upstream);
  }
}

test("forwards a valid signed request to the upstream (method, path+query, body)", async () => {
  await withStack(async ({ proxyPort, state }) => {
    const path = "/api/echo?x=1&y=2";
    const body = '{"hello":"wörld 👋"}';
    const headers = {
      ...signedHeaders({ method: "POST", path: "/api/echo", body }),
      "content-type": "application/json",
      "x-client-meta": "abc",
    };

    const response = await call(proxyPort, { method: "POST", path, headers, body });

    assert.equal(response.status, 200);
    assert.equal(response.headers["x-upstream"], "yes");

    const echoed = JSON.parse(response.body);
    assert.equal(echoed.method, "POST");
    assert.equal(echoed.url, "/api/echo?x=1&y=2");
    assert.equal(echoed.body, body);
    assert.equal(echoed.clientMeta, "abc");
    assert.deepEqual(echoed.hvoHeaders, [], "x-hvo-* headers must not reach upstream");
    assert.equal(state.hits, 1);
  });
});

test("forwards a valid signed GET with an empty body", async () => {
  await withStack(async ({ proxyPort }) => {
    const headers = signedHeaders({ method: "GET", path: "/api/health" });

    const response = await call(proxyPort, {
      method: "GET",
      path: "/api/health",
      headers,
    });

    assert.equal(response.status, 200);
    const echoed = JSON.parse(response.body);
    assert.equal(echoed.method, "GET");
    assert.equal(echoed.url, "/api/health");
    assert.equal(echoed.body, "");
  });
});

test("rejects a timestamp 301 seconds in the past", async () => {
  await withStack(async ({ proxyPort, state }) => {
    const timestamp = Math.floor(Date.now() / 1000) - 301;
    const headers = signedHeaders({ method: "POST", path: "/api/echo", body: "x", timestamp });

    const response = await call(proxyPort, {
      method: "POST",
      path: "/api/echo",
      headers,
      body: "x",
    });

    assert.equal(response.status, 401);
    assert.equal(JSON.parse(response.body).error, "unauthorized");
    assert.equal(state.hits, 0);
  });
});

test("rejects a timestamp 301 seconds in the future", async () => {
  await withStack(async ({ proxyPort, state }) => {
    const timestamp = Math.floor(Date.now() / 1000) + 301;
    const headers = signedHeaders({ method: "POST", path: "/api/echo", body: "x", timestamp });

    const response = await call(proxyPort, {
      method: "POST",
      path: "/api/echo",
      headers,
      body: "x",
    });

    assert.equal(response.status, 401);
    assert.equal(state.hits, 0);
  });
});

test("rejects a replayed nonce", async () => {
  await withStack(async ({ proxyPort, state }) => {
    const nonce = randomBytes(16).toString("hex");
    const body = "replay-me";
    const headers = { ...signedHeaders({ method: "POST", path: "/api/echo", body, nonce }) };

    const first = await call(proxyPort, { method: "POST", path: "/api/echo", headers, body });
    const second = await call(proxyPort, { method: "POST", path: "/api/echo", headers, body });

    assert.equal(first.status, 200);
    assert.equal(second.status, 401);
    assert.equal(state.hits, 1, "replayed request must not reach upstream");
  });
});

test("rejects a wrong signature", async () => {
  await withStack(async ({ proxyPort, state }) => {
    const headers = signedHeaders({ method: "POST", path: "/api/echo", body: "x" });
    headers["x-hvo-signature"] = "0".repeat(64);

    const response = await call(proxyPort, {
      method: "POST",
      path: "/api/echo",
      headers,
      body: "x",
    });

    assert.equal(response.status, 401);
    assert.equal(state.hits, 0);
  });
});

test("rejects a signature that covers the query string", async () => {
  await withStack(async ({ proxyPort, state }) => {
    // Task 2 canonicalizes the pathname only; a signature over path+query must fail.
    const headers = signedHeaders({ method: "GET", path: "/api/echo?x=1" });

    const response = await call(proxyPort, {
      method: "GET",
      path: "/api/echo?x=1",
      headers,
    });

    assert.equal(response.status, 401);
    assert.equal(state.hits, 0);
  });
});

test("rejects a body that does not match the signature", async () => {
  await withStack(async ({ proxyPort, state }) => {
    const headers = signedHeaders({ method: "POST", path: "/api/echo", body: "signed" });

    const response = await call(proxyPort, {
      method: "POST",
      path: "/api/echo",
      headers,
      body: "tampered",
    });

    assert.equal(response.status, 401);
    assert.equal(state.hits, 0);
  });
});

test("rejects missing auth headers", async () => {
  await withStack(async ({ proxyPort, state }) => {
    const response = await call(proxyPort, { method: "GET", path: "/api/health" });

    assert.equal(response.status, 401);
    assert.equal(state.hits, 0);
  });
});

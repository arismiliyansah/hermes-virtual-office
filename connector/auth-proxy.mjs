#!/usr/bin/env node
import http from "node:http";
import https from "node:https";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";

const DEFAULT_UPSTREAM = "http://127.0.0.1:8788";
const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "127.0.0.1";
const TIMESTAMP_TOLERANCE_S = 300;
const NONCE_TTL_S = 600;
const NONCE_SWEEP_MS = 60_000;
const DEFAULT_MAX_BODY_BYTES = 25 * 1024 * 1024;
const MAX_NONCE_LENGTH = 128;
const SIGNATURE_HEX = /^[0-9a-f]{64}$/i;
const INTEGER = /^(0|[1-9][0-9]{0,14})$/;

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hmacSha256Hex(secret, message) {
  return createHmac("sha256", secret).update(message).digest("hex");
}

// Canonical form shared with src/sign.ts:
// METHOD \n PATHNAME \n TIMESTAMP \n NONCE \n SHA256HEX(BODY)
function canonicalString({ method, pathname, timestamp, nonce, body }) {
  return [method, pathname, timestamp, nonce, sha256Hex(body)].join("\n");
}

function signaturesMatch(expectedHex, providedHex) {
  const expected = Buffer.from(expectedHex, "utf8");
  const provided = Buffer.from(providedHex.toLowerCase(), "utf8");
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    const onData = (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        cleanup();
        const error = new Error("payload too large");
        error.statusCode = 413;
        reject(error);
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };

    function cleanup() {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    }

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function unauthorized(res, reason) {
  sendJson(res, 401, { error: "unauthorized", reason });
}

function forward(req, res, { upstream, body }) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (name.startsWith("x-hvo-")) continue;
    if (HOP_BY_HOP.has(name)) continue;
    if (name === "host" || name === "content-length") continue;
    headers[name] = value;
  }
  headers.host = upstream.host;
  headers["content-length"] = String(body.length);

  const basePath = upstream.pathname.replace(/\/+$/, "");
  const targetPath = `${basePath}${req.url ?? "/"}`;

  const transport = upstream.protocol === "https:" ? https : http;
  const upstreamReq = transport.request(
    {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || (upstream.protocol === "https:" ? 443 : 80),
      method: req.method,
      path: targetPath,
      headers,
    },
    (upstreamRes) => {
      const responseHeaders = {};
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (HOP_BY_HOP.has(name)) continue;
        responseHeaders[name] = value;
      }
      res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
      upstreamRes.pipe(res);
      upstreamRes.on("error", () => res.destroy());
    },
  );

  upstreamReq.on("error", (error) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendJson(res, 502, { error: "bad_gateway", reason: error.message });
  });

  req.on("aborted", () => upstreamReq.destroy());

  upstreamReq.end(body);
}

export function createProxyServer({
  secret,
  upstream = DEFAULT_UPSTREAM,
  timestampToleranceSeconds = TIMESTAMP_TOLERANCE_S,
  nonceTtlSeconds = NONCE_TTL_S,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  now = Date.now,
} = {}) {
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("createProxyServer: secret is required");
  }
  const upstreamUrl = typeof upstream === "string" ? new URL(upstream) : upstream;
  if (upstreamUrl.protocol !== "http:" && upstreamUrl.protocol !== "https:") {
    throw new Error("createProxyServer: upstream must be an http(s) URL");
  }

  const seenNonces = new Map();
  const sweep = setInterval(() => {
    const current = now();
    for (const [nonce, expiresAt] of seenNonces) {
      if (expiresAt <= current) seenNonces.delete(nonce);
    }
  }, NONCE_SWEEP_MS);
  sweep.unref();

  const server = http.createServer(async (req, res) => {
    res.on("error", () => {});

    let body;
    try {
      body = await readBody(req, maxBodyBytes);
    } catch (error) {
      if (req.destroyed || res.destroyed) return;
      if (error.statusCode === 413) {
        res.writeHead(413, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify({ error: "payload_too_large" }), () => req.destroy());
        return;
      }
      res.destroy();
      return;
    }

    const timestampHeader = req.headers["x-hvo-timestamp"];
    const nonce = req.headers["x-hvo-nonce"];
    const signature = req.headers["x-hvo-signature"];

    if (typeof timestampHeader !== "string" || !INTEGER.test(timestampHeader)) {
      return unauthorized(res, "missing_or_invalid_timestamp");
    }
    if (typeof nonce !== "string" || nonce.length === 0 || nonce.length > MAX_NONCE_LENGTH) {
      return unauthorized(res, "missing_or_invalid_nonce");
    }
    if (typeof signature !== "string" || !SIGNATURE_HEX.test(signature)) {
      return unauthorized(res, "missing_or_invalid_signature");
    }

    const timestamp = Number(timestampHeader);
    const current = Math.floor(now() / 1000);
    if (Math.abs(current - timestamp) > timestampToleranceSeconds) {
      return unauthorized(res, "stale_timestamp");
    }

    const pathname = (req.url ?? "/").split("?")[0];
    const expected = hmacSha256Hex(
      secret,
      canonicalString({ method: req.method, pathname, timestamp, nonce, body }),
    );

    if (!signaturesMatch(expected, signature)) {
      return unauthorized(res, "bad_signature");
    }

    // Only recorded after a valid signature so unauthenticated traffic cannot
    // exhaust the nonce cache.
    const expiresAt = now() + nonceTtlSeconds * 1000;
    if ((seenNonces.get(nonce) ?? 0) > now()) {
      return unauthorized(res, "replayed_nonce");
    }
    seenNonces.set(nonce, expiresAt);

    forward(req, res, { upstream: upstreamUrl, body });
  });

  server.once("close", () => clearInterval(sweep));
  return server;
}

export function configFromEnv(env = process.env) {
  const secret = env.HVO_HMAC_SECRET;
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("HVO_HMAC_SECRET is required");
  }

  const upstream = env.HERMES_UPSTREAM ?? DEFAULT_UPSTREAM;
  new URL(upstream);

  const portRaw = env.PORT ?? String(DEFAULT_PORT);
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be an integer between 0 and 65535, got ${portRaw}`);
  }

  const host = env.HVO_HOST ?? DEFAULT_HOST;

  const maxBodyRaw = env.HVO_MAX_BODY_BYTES;
  const maxBodyBytes = maxBodyRaw === undefined ? DEFAULT_MAX_BODY_BYTES : Number(maxBodyRaw);
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new Error(`HVO_MAX_BODY_BYTES must be a positive integer, got ${maxBodyRaw}`);
  }

  return { secret, upstream, port, host, maxBodyBytes };
}

function main() {
  let config;
  try {
    config = configFromEnv();
  } catch (error) {
    console.error(`auth-proxy: ${error.message}`);
    process.exit(1);
  }

  const server = createProxyServer(config);

  server.listen(config.port, config.host, () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : config.port;
    console.log(`auth-proxy: listening on http://${config.host}:${port} -> ${config.upstream}`);
  });

  const shutdown = (signal) => {
    console.log(`auth-proxy: ${signal} received, shutting down`);
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) main();

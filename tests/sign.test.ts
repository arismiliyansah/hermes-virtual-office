import { canonicalString, signRequest, signedHeaders } from "../src/sign";

const encoder = new TextEncoder();

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const sha256Hex = async (input: string): Promise<string> =>
  toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(input))));

const hmacHex = async (secret: string, message: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message))));
};

describe("canonicalString", () => {
  it("uses the exact METHOD\\nPATH\\nTIMESTAMP\\nNONCE\\nSHA256HEX(BODY) format", async () => {
    const canonical = await canonicalString({
      method: "POST",
      path: "/api/agents/a1/message",
      timestamp: 1700000000,
      nonce: "abc123",
      body: '{"text":"hi"}',
    });

    const bodyHash = await sha256Hex('{"text":"hi"}');
    expect(canonical).toBe(
      `POST\n/api/agents/a1/message\n1700000000\nabc123\n${bodyHash}`,
    );
    expect(canonical.split("\n")).toHaveLength(5);
  });

  it("hashes the empty body as the known SHA-256 of the empty string", async () => {
    const canonical = await canonicalString({
      method: "GET",
      path: "/api/health",
      timestamp: 1700000001,
      nonce: "deadbeef",
      body: "",
    });

    expect(canonical).toBe(
      "GET\n/api/health\n1700000001\ndeadbeef\n" +
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("signRequest", () => {
  it("returns hex HMAC-SHA256 matching an independent recomputation", async () => {
    const secret = "s3cr3t";
    const opts = {
      method: "POST",
      path: "/api/agents",
      timestamp: 1700000000,
      nonce: "00112233445566778899aabbccddeeff",
      body: '{"name":"hermes"}',
    };

    const { signature } = await signRequest(secret, opts);

    const expectedMessage =
      `POST\n/api/agents\n1700000000\n00112233445566778899aabbccddeeff\n` +
      (await sha256Hex('{"name":"hermes"}'));
    const expected = await hmacHex(secret, expectedMessage);

    expect(signature).toBe(expected);
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("depends on the secret", async () => {
    const opts = {
      method: "GET",
      path: "/api/state",
      timestamp: 1700000000,
      nonce: "nonce",
      body: "",
    };

    const a = await signRequest("secret-a", opts);
    const b = await signRequest("secret-b", opts);

    expect(a.signature).not.toBe(b.signature);
  });
});

describe("signedHeaders", () => {
  it("returns timestamp in epoch seconds, a 16-byte hex nonce, and a matching signature", async () => {
    const secret = "s3cr3t";
    const now = new Date(1700000000123);

    const headers = await signedHeaders(secret, "PUT", "/api/agents/a1", '{"ok":true}', now);

    expect(headers["x-hvo-timestamp"]).toBe("1700000000");
    expect(headers["x-hvo-nonce"]).toMatch(/^[0-9a-f]{32}$/);
    expect(headers["x-hvo-signature"]).toMatch(/^[0-9a-f]{64}$/);

    const expected = await hmacHex(
      secret,
      `PUT\n/api/agents/a1\n1700000000\n${headers["x-hvo-nonce"]}\n` +
        (await sha256Hex('{"ok":true}')),
    );
    expect(headers["x-hvo-signature"]).toBe(expected);
  });

  it("generates a fresh nonce per call", async () => {
    const now = new Date(1700000000123);

    const first = await signedHeaders("s3cr3t", "GET", "/", "", now);
    const second = await signedHeaders("s3cr3t", "GET", "/", "", now);

    expect(first["x-hvo-nonce"]).not.toBe(second["x-hvo-nonce"]);
  });
});

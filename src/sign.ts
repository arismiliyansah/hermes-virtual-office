export interface CanonicalOpts {
  method: string;
  path: string;
  timestamp: number;
  nonce: string;
  body: string;
}

type SignedHeaders = {
  "x-hvo-timestamp": string;
  "x-hvo-nonce": string;
  "x-hvo-signature": string;
};

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return toHex(new Uint8Array(digest));
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return toHex(new Uint8Array(signature));
}

export async function canonicalString(opts: CanonicalOpts): Promise<string> {
  const bodyHash = await sha256Hex(opts.body);
  return `${opts.method}\n${opts.path}\n${opts.timestamp}\n${opts.nonce}\n${bodyHash}`;
}

export async function signRequest(
  secret: string,
  opts: CanonicalOpts,
): Promise<{ signature: string }> {
  const message = await canonicalString(opts);
  return { signature: await hmacSha256Hex(secret, message) };
}

function randomNonce(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(16)));
}

export async function signedHeaders(
  secret: string,
  method: string,
  path: string,
  body: string,
  now: Date = new Date(),
): Promise<SignedHeaders> {
  const timestamp = Math.floor(now.getTime() / 1000);
  const nonce = randomNonce();
  const { signature } = await signRequest(secret, { method, path, timestamp, nonce, body });

  return {
    "x-hvo-timestamp": String(timestamp),
    "x-hvo-nonce": nonce,
    "x-hvo-signature": signature,
  };
}

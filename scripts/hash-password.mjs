#!/usr/bin/env node
import { pbkdf2Sync, randomBytes } from "node:crypto";

const ITERATIONS = 100_000;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

const password = process.argv[2];

if (password === undefined) {
  console.error("usage: node scripts/hash-password.mjs <password>");
  process.exit(1);
}

const salt = randomBytes(SALT_LENGTH);
const hash = pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, "sha256");

console.log(
  `pbkdf2$${ITERATIONS}$${salt.toString("base64url")}$${hash.toString("base64url")}`,
);

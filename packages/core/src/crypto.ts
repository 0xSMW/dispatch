import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";

export function id(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function requestId() {
  return id("req");
}

export function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function stableHash(value: unknown) {
  return hash(JSON.stringify(sortJson(value)));
}

export function makeKey() {
  const secret = `sk_${randomBytes(24).toString("base64url")}`;
  const prefix = secret.slice(0, 12);
  return { secret, prefix };
}

export function keyHash(secret: string, pepper: string) {
  return createHmac("sha256", pepper).update(secret).digest("hex");
}

// Passwords are hashed with scrypt and a random salt per password. The stored string carries
// its own parameters, "scrypt$N$r$p$salt$hash", so the cost can be raised later and older
// hashes still check. 2^14, 8, 5 is one of OWASP's minimum scrypt settings: 16 MiB per check.
const passwordCost = { N: 16_384, r: 8, p: 5 };

// What a stored hash may ask for. Anything else is refused before it costs memory, and a key or
// salt that decodes short could otherwise make an empty compare that passes.
function usableCost(cost: { N: number; r: number; p: number }) {
  const { N, r, p } = cost;
  return Number.isInteger(N) && N >= 2 && N <= 2 ** 20 && (N & (N - 1)) === 0 && Number.isInteger(r) && r >= 1 && r <= 32 && Number.isInteger(p) && p >= 1 && p <= 16 && 128 * N * r <= 2 ** 28;
}

function derive(password: string, salt: Buffer, cost: { N: number; r: number; p: number }, length: number) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, length, { ...cost, maxmem: 256 * cost.N * cost.r }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export async function hashPassword(password: string) {
  const { N, r, p } = passwordCost;
  const salt = randomBytes(16);
  const key = await derive(password, salt, passwordCost, 64);
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

// False for a wrong password, and for a stored value that is missing or not a hash this code
// wrote. A missing hash still costs one derivation, so an unknown email takes as long to refuse
// as a wrong password.
export async function checkPassword(password: string, stored: string | null | undefined) {
  const parts = (stored ?? "").split("$");
  const [scheme, N, r, p, salt, key] = parts;
  const cost = { N: Number(N), r: Number(r), p: Number(p) };
  const saltBytes = Buffer.from(salt ?? "", "base64url");
  const keyBytes = Buffer.from(key ?? "", "base64url");
  const valid = parts.length === 6 && scheme === "scrypt" && usableCost(cost) && saltBytes.length >= 16 && keyBytes.length === 64;
  const expected = valid ? keyBytes : Buffer.alloc(64);
  const given = await derive(password, valid ? saltBytes : randomBytes(16), valid ? cost : passwordCost, 64);
  return valid && timingSafeEqual(given, expected);
}

export function sign(payload: string, secret: string, idValue = id("evt"), timestamp = Math.floor(Date.now() / 1000)) {
  const content = `${idValue}.${timestamp}.${payload}`;
  const signature = createHmac("sha256", secret).update(content).digest("base64url");
  return { id: idValue, timestamp, signature };
}

export function verify(payload: string, secret: string, idValue: string, timestamp: string, signature: string) {
  const expected = sign(payload, secret, idValue, Number(timestamp)).signature;
  const left = Buffer.from(expected);
  const right = Buffer.from(signature);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function makeWebhookSecret() {
  return `whsec_${randomBytes(24).toString("base64")}`;
}

export function signWebhook(payload: string, secrets: string[], msgId: string, timestamp = Math.floor(Date.now() / 1000)) {
  const signatures = secrets.map((secret) => {
    const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
    return `v1,${createHmac("sha256", key).update(`${msgId}.${timestamp}.${payload}`).digest("base64")}`;
  });
  return { id: msgId, timestamp, signature: signatures.join(" ") };
}

export function verifyWebhook(
  payload: string,
  secret: string,
  headers: { id: string; timestamp: string; signature: string },
  toleranceSecs = 300
) {
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(headers.timestamp));
  if (!Number.isFinite(age) || age > toleranceSecs) return false;
  const expected = Buffer.from(signWebhook(payload, [secret], headers.id, Number(headers.timestamp)).signature.slice(3), "base64");
  return headers.signature.split(" ").some((entry) => {
    const given = Buffer.from(entry.replace(/^v1,/, ""), "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

// APP_SECRET does two jobs: it signs tokens and it protects stored webhook secrets. The two
// must not share a key. Tokens are signed with the secret itself. Stored secrets are encrypted
// with a key derived from it for that one purpose, so neither key says anything about the other.
// Values written before this used a plain hash of the secret. They carry the v1 prefix and are
// still read, so nothing stored has to be rewritten.
const legacyPrefix = "enc:v1:";
const secretPrefix = "enc:v2:";

function encryptionKey(secret: string, prefix: string) {
  if (prefix === legacyPrefix) return createHash("sha256").update(secret).digest();
  return Buffer.from(hkdfSync("sha256", secret, "dispatch", "webhook-secret-encryption", 32));
}

// True for a value encrypt() wrote, in either format. A legacy plaintext secret is false.
export function encrypted(value: string) {
  return value.startsWith(secretPrefix) || value.startsWith(legacyPrefix);
}

export function encrypt(plaintext: string, secret: string) {
  const key = encryptionKey(secret, secretPrefix);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${secretPrefix}${iv.toString("base64url")}.${tag.toString("base64url")}.${body.toString("base64url")}`;
}

export function decrypt(value: string, secret: string) {
  const prefix = [secretPrefix, legacyPrefix].find((item) => value.startsWith(item));
  if (!prefix) return value;
  const [iv, tag, body] = value.slice(prefix.length).split(".");
  if (!iv || !tag || !body) throw new Error("Webhook secret could not be decrypted");
  const key = encryptionKey(secret, prefix);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, sortJson(child)])
    );
  }
  return value;
}

export function seal(payload: Record<string, unknown>, secret: string) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function unseal<T extends { exp?: number }>(token: string, secret: string): T | null {
  const [body, signature] = token.split(".");
  if (!body || !signature || token.split(".").length !== 2) return null;
  const expected = Buffer.from(createHmac("sha256", secret).update(body).digest("base64url"));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

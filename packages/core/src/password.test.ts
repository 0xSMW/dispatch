import { scryptSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkPassword, devPassword, hashPassword, passwordChangeSchema, seedPassword, sessionSchema, userSchema, userUpdateSchema } from "./index.js";

describe("passwords", () => {
  it("hashes with scrypt, a fresh salt, and the parameters in the string", async () => {
    const first = await hashPassword("correct horse battery");
    const second = await hashPassword("correct horse battery");
    expect(first).toMatch(/^scrypt\$16384\$8\$5\$[\w-]+\$[\w-]+$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain("correct horse");
  });

  it("checks a password against its hash", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(await checkPassword("correct horse battery", stored)).toBe(true);
    expect(await checkPassword("correct horse batterY", stored)).toBe(false);
    expect(await checkPassword("", stored)).toBe(false);
  });

  it("checks a hash made with other parameters", async () => {
    const salt = Buffer.from("a fixed salt of 16+");
    const key = scryptSync("correct horse battery", salt, 64, { N: 1024, r: 8, p: 1 });
    const cheaper = `scrypt$1024$8$1$${salt.toString("base64url")}$${key.toString("base64url")}`;
    expect(await checkPassword("correct horse battery", cheaper)).toBe(true);
    expect(await checkPassword("wrong horse battery", cheaper)).toBe(false);
  });

  it("refuses a missing or malformed hash", async () => {
    expect(await checkPassword("correct horse battery", null)).toBe(false);
    expect(await checkPassword("correct horse battery", undefined)).toBe(false);
    expect(await checkPassword("correct horse battery", "plain")).toBe(false);
    expect(await checkPassword("correct horse battery", "scrypt$x$8$1$salt$hash")).toBe(false);
  });

  it("refuses a stored hash whose key or salt decodes short, or that asks for too much memory", async () => {
    const salt = Buffer.alloc(16, 1).toString("base64url");
    // An empty key once made an empty compare that matched any password.
    expect(await checkPassword("anything at all", `scrypt$16384$8$1$${salt}$!!!`)).toBe(false);
    expect(await checkPassword("anything at all", "scrypt$16384$8$1$c2FsdA$!!!")).toBe(false);
    const key = Buffer.alloc(64).toString("base64url");
    expect(await checkPassword("anything at all", `scrypt$1048576$64$1$${salt}$${key}`)).toBe(false);
    expect(await checkPassword("anything at all", `scrypt$1000$8$1$${salt}$${key}`)).toBe(false);
  });

  it("allows 12 to 200 characters and nothing else", () => {
    const base = { email: "ada@example.com", name: "Ada" };
    expect(userSchema.safeParse({ ...base, password: "a".repeat(12) }).success).toBe(true);
    expect(userSchema.safeParse({ ...base, password: "a".repeat(200) }).success).toBe(true);
    expect(userSchema.safeParse({ ...base, password: "a".repeat(11) }).success).toBe(false);
    expect(userSchema.safeParse({ ...base, password: "a".repeat(201) }).success).toBe(false);
    expect(userSchema.safeParse(base).success).toBe(true);
    expect(userUpdateSchema.safeParse({ password: "short" }).success).toBe(false);
    expect(passwordChangeSchema.safeParse({ current_password: "x", password: "a".repeat(12) }).success).toBe(true);
    expect(passwordChangeSchema.safeParse({ password: "a".repeat(12) }).success).toBe(false);
  });

  it("signs in with a password or an API key, not both and not neither", () => {
    expect(sessionSchema.safeParse({ email: "ada@example.com", password: "p" }).success).toBe(true);
    expect(sessionSchema.safeParse({ email: "ada@example.com", api_key: "sk_x" }).success).toBe(true);
    expect(sessionSchema.safeParse({ email: "ada@example.com" }).success).toBe(false);
    expect(sessionSchema.safeParse({ email: "ada@example.com", password: "p", api_key: "sk_x" }).success).toBe(false);
  });
});

describe("seedPassword", () => {
  it("defaults to the development password outside production", () => {
    expect(seedPassword({})).toBe(devPassword);
    expect(seedPassword({ DISPATCH_PASSWORD: "my own password" })).toBe("my own password");
    expect(() => seedPassword({ DISPATCH_PASSWORD: "short" })).toThrow(/DISPATCH_PASSWORD/);
  });

  it("refuses to run in production without a private password", () => {
    expect(() => seedPassword({ NODE_ENV: "production" })).toThrow(/DISPATCH_PASSWORD/);
    expect(() => seedPassword({ NODE_ENV: "production", DISPATCH_PASSWORD: devPassword })).toThrow(/DISPATCH_PASSWORD/);
    expect(() => seedPassword({ NODE_ENV: "production", DISPATCH_PASSWORD: "short" })).toThrow(/DISPATCH_PASSWORD/);
    expect(seedPassword({ NODE_ENV: "production", DISPATCH_PASSWORD: "a private password" })).toBe("a private password");
  });
});

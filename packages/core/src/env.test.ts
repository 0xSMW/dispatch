import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEnv, workspaceRoot } from "./env.js";

describe("loadEnv", () => {
  it("reads the workspace root's .env from a package folder, the way pnpm --filter starts a process", () => {
    const root = mkdtempSync(join(tmpdir(), "dispatch-env-"));
    try {
      const pkg = join(root, "apps", "api");
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
      writeFileSync(join(root, ".env"), "RATE_LIMIT_PER_SECOND=200\nSHARED=root\nKEPT=root\n");
      writeFileSync(join(pkg, ".env"), "SHARED=package\n");
      expect(workspaceRoot(pkg)).toBe(root);

      const env: NodeJS.ProcessEnv = { KEPT: "environment" };
      expect(loadEnv(pkg, env)).toEqual([join(pkg, ".env"), join(root, ".env")]);
      // The root file is read. The package's own file wins over it, and the environment over both.
      expect(env.RATE_LIMIT_PER_SECOND).toBe("200");
      expect(env.SHARED).toBe("package");
      expect(env.KEPT).toBe("environment");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does nothing when there is no file", () => {
    const dir = mkdtempSync(join(tmpdir(), "dispatch-env-"));
    try {
      const env: NodeJS.ProcessEnv = {};
      expect(loadEnv(dir, env)).toEqual([]);
      expect(env).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

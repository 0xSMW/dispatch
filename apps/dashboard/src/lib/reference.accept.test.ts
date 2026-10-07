// Milestone 8 only: REFERENCE_ACCEPTANCE=true pnpm vitest run apps/dashboard/src/lib/reference.accept.test.ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { go, referenceFor, references, sdk } from "./reference";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const calls = Object.keys(references).flatMap(path => referenceFor(path.replace(/:[a-z_]+/g, "resource_123"))!.calls);

describe.runIf(process.env.REFERENCE_ACCEPTANCE === "true")("shipped reference snippet compilation", () => {
  it("typechecks complete TypeScript examples against the actual SDK source", () => {
    const directory = mkdtempSync(join(tmpdir(), "dispatch-reference-ts-"));
    try {
      const files = calls.flatMap((call, index) => {
        const code = sdk(call, "https://api.acme.test");
        if (!code) return [];
        const file = join(directory, `example-${index}.ts`);
        writeFileSync(file, code.replace('"@dispatchmail/sdk"', JSON.stringify(join(root, "packages/sdk/src/index.ts"))));
        return [file];
      });
      const config = ts.readConfigFile(join(root, "tsconfig.base.json"), ts.sys.readFile);
      expect(config.error).toBeUndefined();
      const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
      const program = ts.createProgram(files, {
        ...parsed.options, noEmit: true, types: ["node"],
        typeRoots: [join(root, "node_modules/@types")],
        module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
        allowImportingTsExtensions: true,
      });
      const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
      expect(diagnostics.map(item => ts.flattenDiagnosticMessageText(item.messageText, "\n"))).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("compiles complete Go examples against the actual local SDK without running sends", () => {
    const directory = mkdtempSync(join(tmpdir(), "dispatch-reference-go-"));
    try {
      writeFileSync(join(directory, "go.mod"), [
        "module dispatch-reference",
        "go 1.22",
        "require github.com/dispatch/dispatch-go v0.0.0",
        `replace github.com/dispatch/dispatch-go => ${JSON.stringify(join(root, "packages/sdk-go"))}`,
      ].join("\n"));
      let examples = 0;
      calls.forEach((call, index) => {
        const code = go(call, "https://api.acme.test");
        if (!code) return;
        const example = join(directory, `example-${index}`);
        mkdirSync(example);
        writeFileSync(join(example, "main.go"), code);
        examples++;
      });
      expect(examples).toBeGreaterThan(0);
      // No tests or main functions execute; Go compiles each independent package.
      const result = spawnSync("go", ["test", "./..."], {
        cwd: directory, encoding: "utf8", timeout: 120_000,
        env: { ...process.env, GOPROXY: "off", GOTOOLCHAIN: "local" },
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 130_000);
});

// Run: pnpm exec tsx --test scripts/llms.test.ts
// These tests use only disposable Git repositories, never the checkout's index.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  generateLlms,
  llmsOutputs,
  loadPublicDocs,
  publicDocs,
  rebaseLinks,
  renderLlms,
} from "./llms.js";

async function repository(t: TestContext) {
  const root = await mkdtemp("/tmp/dispatch-llms-");
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", root]);
  await mkdir(join(root, "docs"));
  const write = async (path: string, content: string, tracked = true) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
    if (tracked) execFileSync("git", ["-C", root, "add", "--", path]);
  };
  return { root, write };
}

test("includes tracked root README and approved public guides, including the API guide", async (t) => {
  const { root, write } = await repository(t);
  await write("README.md", "# Dispatch\r\n\r\nSend email.\r\n");
  await write("docs/api/README.md", "# API\n\nUse a Bearer token.\n");
  await write("docs/templates.md", "# Templates\n\nPublish a template.\n");
  assert.deepEqual(
    (await loadPublicDocs(root)).map((doc) => doc.path),
    ["README.md", "docs/api/README.md", "docs/templates.md"],
  );
  const result = await generateLlms({ root });
  assert.equal(result.outputs.length, 2);
  const full = await readFile(result.outputs[1]!, "utf8");
  assert.match(full, /Use a Bearer token/);
  assert.match(full, /Publish a template/);
  assert.equal(full.includes("\r"), false);
});

test("excludes internal, research, security, generated, and untracked inputs even if internal files are tracked", async (t) => {
  const { root, write } = await repository(t);
  await write("README.md", "# Dispatch\n\nPublic overview.\n");
  await write("docs/api/README.md", "# API\n\nPublic API.\n");
  await write("docs/templates.md", "UNTRACKED_PUBLIC_GUIDE", false);
  await write(
    ".gitignore",
    "docs/lifecycle-plan.md\ndocs/ignored-research.md\n",
  );
  await write("docs/lifecycle-plan.md", "PRIVATE_PLAN", false);
  await write("docs/ignored-research.md", "IGNORED_RESEARCH", false);
  for (const path of [
    "docs/security-review.md",
    "docs/loops-analysis.md",
    "docs/resend-parity.md",
    "docs/deployment.md",
    "docs/dry-refactor.md",
    "docs/new-guide.md",
    "docs/api/openapi.json",
    ...llmsOutputs,
  ])
    await write(path, `NOT_PUBLIC_INPUT ${path}\n`);
  const documents = await loadPublicDocs(root);
  assert.deepEqual(
    documents.map((doc) => doc.path),
    ["README.md", "docs/api/README.md"],
  );
  const { index, full } = renderLlms(documents);
  for (const marker of [
    "PRIVATE_PLAN",
    "IGNORED_RESEARCH",
    "UNTRACKED_PUBLIC_GUIDE",
    "NOT_PUBLIC_INPUT",
  ]) {
    assert.equal(index.includes(marker), false);
    assert.equal(full.includes(marker), false);
  }
  assert.equal(
    publicDocs.some((doc) =>
      (llmsOutputs as readonly string[]).includes(doc.path),
    ),
    false,
  );
});

test("rejects explicitly requested untracked approved inputs before writing either output", async (t) => {
  const { root, write } = await repository(t);
  await write("README.md", "# Dispatch\n");
  await write("docs/templates.md", "# Untracked template guide\n", false);
  for (const path of llmsOutputs) await write(path, "PREVIOUS_OUTPUT\n", false);
  await assert.rejects(
    generateLlms({ root, inputs: ["README.md", "docs/templates.md"] }),
    /untracked: docs\/templates.md/,
  );
  for (const path of llmsOutputs)
    assert.equal(await readFile(join(root, path), "utf8"), "PREVIOUS_OUTPUT\n");
});

test("rejects internal, generated, absolute, and traversal paths requested explicitly", async (t) => {
  const { root, write } = await repository(t);
  await write("README.md", "# Dispatch\n");
  await write("docs/security-review.md", "PRIVATE_SECURITY_REPORT");
  for (const path of [
    "docs/security-review.md",
    "docs/llms.txt",
    "docs/llms-full.txt",
    "../README.md",
    "/README.md",
    "./README.md",
  ]) {
    await assert.rejects(
      loadPublicDocs(root, [path]),
      /Not an approved public document/,
    );
  }
});

test("omits ignored approved docs even when force-tracked and rejects explicitly requesting them", async (t) => {
  const { root, write } = await repository(t);
  await write("README.md", "# Dispatch\n");
  await write("docs/templates.md", "PRIVATE_TRACKED_AND_IGNORED");
  await write(".gitignore", "docs/templates.md\n");
  assert.deepEqual(
    (await loadPublicDocs(root)).map((doc) => doc.path),
    ["README.md"],
  );
  await assert.rejects(
    loadPublicDocs(root, ["docs/templates.md"]),
    /ignored: docs\/templates.md/,
  );
});

test("honors local Git exclude rules without relying on tracked status", async (t) => {
  const { root, write } = await repository(t);
  await write("README.md", "# Dispatch\n");
  await write("docs/templates.md", "LOCAL_PRIVATE_GUIDE");
  await writeFile(join(root, ".git/info/exclude"), "docs/templates.md\n");
  assert.deepEqual(
    (await loadPublicDocs(root)).map((doc) => doc.path),
    ["README.md"],
  );
});

test("is byte-repeatable regardless of requested order, duplicate inputs, or existing generated output", async (t) => {
  const { root, write } = await repository(t);
  await write("README.md", "# Dispatch\n\n[API](docs/api/README.md)\n");
  await write("docs/api/README.md", "# API\n\n[Templates](../templates.md)\n");
  await write("docs/templates.md", "# Templates\n");
  const first = await generateLlms({ root });
  const snapshot = await Promise.all(
    first.outputs.map((path) => readFile(path)),
  );
  await generateLlms({
    root,
    inputs: [
      "docs/templates.md",
      "README.md",
      "docs/api/README.md",
      "README.md",
    ],
  });
  const second = await Promise.all(first.outputs.map((path) => readFile(path)));
  assert.deepEqual(second, snapshot);
  for (const path of llmsOutputs)
    execFileSync("git", ["-C", root, "add", "--", path]);
  await generateLlms({ root });
  assert.deepEqual(
    await Promise.all(first.outputs.map((path) => readFile(path))),
    snapshot,
  );
  await generateLlms({ root, check: true });
});

test("index, source, and merged Markdown links resolve from the docs output directory", async (t) => {
  const { root, write } = await repository(t);
  await write(
    "README.md",
    "# Dispatch\n\n[API](docs/api/README.md#sending)\n[Code](packages/sdk/src/index.ts)\n",
  );
  await write(
    "docs/api/README.md",
    "# API\n\n[OpenAPI](openapi.json)\n[Templates](../templates.md#variables)\n[Sending](#sending)\n",
  );
  await write("docs/templates.md", "# Templates\n\n[Home](../README.md)\n");
  const { outputs } = await generateLlms({ root });
  const index = await readFile(outputs[0]!, "utf8");
  const full = await readFile(outputs[1]!, "utf8");
  for (const path of ["README.md", "docs/api/README.md", "docs/templates.md"]) {
    const relative = posix.relative("docs", path);
    assert.ok(index.includes(`](${relative}): `));
    assert.ok(full.includes(`Source: [${path}](${relative})`));
    assert.equal(posix.normalize(posix.join("docs", relative)), path);
  }
  assert.match(index, /\[Full documentation\]\(llms-full\.txt\)/);
  assert.match(full, /\[Documentation index\]\(llms\.txt\)/);
  assert.match(full, /\[API\]\(api\/README\.md#sending\)/);
  assert.match(full, /\[Code\]\(\.\.\/packages\/sdk\/src\/index\.ts\)/);
  assert.match(full, /\[OpenAPI\]\(api\/openapi\.json\)/);
  assert.match(full, /\[Templates\]\(templates\.md#variables\)/);
  assert.match(full, /\[Sending\]\(api\/README\.md#sending\)/);
  assert.match(full, /\[Home\]\(\.\.\/README\.md\)/);
});

test("rebases Markdown links and reference definitions while preserving URLs and code examples", () => {
  const source = [
    '[Template](../templates.md "Guide") ![Logo](../assets/logo.png)',
    "[API](<README.md#sending>) [External](https://example.com/a) [Mail](mailto:user@example.test)",
    "[Root](/health) [CDN](//example.com/a) [Query](?mode=raw)",
    '[guide]: ../templates.md#variables "Guide"',
    "`[Inline](../leave.md)` and [Real](../templates.md)",
    "``literal ` [Inline](../leave.md)`` and [Real](../templates.md)",
    "```md",
    "[Example](../leave.md)",
    "```",
    "~~~",
    "[Example](../leave.md)",
    "~~~",
  ].join("\n");
  const result = rebaseLinks(source, "docs/api/README.md");
  assert.ok(
    result.includes(
      '[Template](templates.md "Guide") ![Logo](assets/logo.png)',
    ),
  );
  assert.ok(result.includes("[API](<api/README.md#sending>)"));
  assert.ok(result.includes('[guide]: templates.md#variables "Guide"'));
  assert.ok(
    result.includes("`[Inline](../leave.md)` and [Real](templates.md)"),
  );
  assert.ok(
    result.includes(
      "``literal ` [Inline](../leave.md)`` and [Real](templates.md)",
    ),
  );
  for (const unchanged of [
    "[External](https://example.com/a)",
    "[Mail](mailto:user@example.test)",
    "[Root](/health)",
    "[CDN](//example.com/a)",
    "```md\n[Example](../leave.md)\n```",
    "~~~\n[Example](../leave.md)\n~~~",
  ])
    assert.ok(result.includes(unchanged));
  assert.ok(result.includes("[Query](api/README.md?mode=raw)"));
});

test("rejects missing tracked docs and symlinked input files or directories", async (t) => {
  const { root, write } = await repository(t);
  await write("README.md", "# Dispatch\n");
  await write("docs/templates.md", "# Templates\n");
  await rm(join(root, "docs/templates.md"));
  await assert.rejects(loadPublicDocs(root), /ENOENT/);
  await write("docs/internal.md", "PRIVATE_SYMLINK_TARGET", false);
  await symlink("internal.md", join(root, "docs/templates.md"));
  await assert.rejects(
    loadPublicDocs(root),
    /Expected a regular public document/,
  );
  await rm(join(root, "docs/templates.md"));
  await write("docs/templates.md", "# Templates\n");
  await write("docs/api/README.md", "# API\n");
  await rm(join(root, "docs/api"), { recursive: true });
  await mkdir(join(root, "private"));
  await write("private/README.md", "PRIVATE_DIRECTORY_TARGET", false);
  await symlink("../private", join(root, "docs/api"));
  await assert.rejects(
    loadPublicDocs(root),
    /Expected a regular public document|beyond a symbolic link/,
  );
});

test("checks output freshness without writing and rejects symlinked output destinations", async (t) => {
  const { root, write } = await repository(t);
  await write("README.md", "# Dispatch\n");
  await assert.rejects(
    generateLlms({ root, check: true }),
    /stale: docs\/llms.txt/,
  );
  const { outputs } = await generateLlms({ root });
  await generateLlms({ root, check: true });
  await write("README.md", "# Changed overview\n");
  const before = await Promise.all(
    outputs.map((path) => readFile(path, "utf8")),
  );
  await assert.rejects(generateLlms({ root, check: true }), /stale/);
  assert.deepEqual(
    await Promise.all(outputs.map((path) => readFile(path, "utf8"))),
    before,
  );
  await write("private.md", "PRIVATE_CONTENT", false);
  await rm(outputs[1]!);
  await symlink("../private.md", outputs[1]!);
  await assert.rejects(
    generateLlms({ root }),
    /Expected a regular public document/,
  );
  assert.equal(
    await readFile(join(root, "private.md"), "utf8"),
    "PRIVATE_CONTENT",
  );
  assert.equal(await readFile(outputs[0]!, "utf8"), before[0]);
});

test("rejects an empty selection and a nested document root", async (t) => {
  const { root, write } = await repository(t);
  await assert.rejects(loadPublicDocs(root), /No tracked public documents/);
  await write("README.md", "# Dispatch\n");
  await assert.rejects(loadPublicDocs(root, []), /No tracked public documents/);
  await assert.rejects(
    loadPublicDocs(join(root, "docs")),
    /must be the Git repository root/,
  );
});

test("CLI help is discoverable and an explicitly untracked input exits nonzero without creating outputs", async (t) => {
  const { root, write } = await repository(t);
  await write("README.md", "# Dispatch\n");
  await write("docs/templates.md", "# Untracked\n", false);
  const script = fileURLToPath(new URL("./llms.ts", import.meta.url));
  const run = (args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", script, ...args], {
      encoding: "utf8",
    });
  const help = run(["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: pnpm exec tsx scripts\/llms.ts/);
  const rejected = run(["--root", root, "--input", "docs/templates.md"]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Public document is untracked/);
  await assert.rejects(readFile(join(root, "docs/llms.txt")), /ENOENT/);
  const generated = run(["--root", root]);
  assert.equal(generated.status, 0, generated.stderr);
  assert.match(
    generated.stdout,
    /Generated 2 files from 1 tracked public documents/,
  );
  assert.equal(run(["--root", root, "--check"]).status, 0);
  const unknown = run(["--unknown"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown argument/);
  const missing = run(["--input"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Missing value/);
});

import { spawnSync } from "node:child_process";

const accepted = {
  id: "GHSA-ch52-4w7c-c8xp",
  module: "http-cache-semantics",
  version: "4.2.0",
  path: "apps__api>workflow>@workflow/nest>@swc/cli>@xhmikosr/bin-wrapper>@xhmikosr/downloader>got>cacheable-request>http-cache-semantics",
};

const packageManager = process.env.npm_execpath;
const audit = spawnSync(
  packageManager ? process.execPath : "pnpm",
  [...(packageManager ? [packageManager] : []), "audit", "--prod", "--json"],
  {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  },
);
if (audit.error) throw audit.error;

let report;
try {
  report = JSON.parse(audit.stdout);
} catch {
  process.stderr.write(audit.stderr);
  throw new Error("pnpm audit did not return valid JSON");
}
if (report.error) {
  throw new Error(
    `pnpm audit failed: ${report.error.message ?? report.error.code ?? "unknown error"}`,
  );
}

const severe = Object.values(report.advisories ?? {}).filter((advisory) =>
  ["high", "critical"].includes(advisory.severity),
);
const blocked = severe.filter((advisory) => {
  const paths = (advisory.findings ?? []).flatMap((finding) =>
    (finding.paths ?? []).map((path) => ({ path, version: finding.version })),
  );
  return !(
    advisory.github_advisory_id === accepted.id &&
    advisory.module_name === accepted.module &&
    advisory.patched_versions === "<0.0.0" &&
    paths.length > 0 &&
    paths.every(
      (finding) =>
        finding.version === accepted.version && finding.path === accepted.path,
    )
  );
});

if (blocked.length > 0) {
  for (const advisory of blocked) {
    process.stderr.write(
      `${advisory.severity}: ${advisory.github_advisory_id ?? advisory.id} ${advisory.module_name}\n`,
    );
  }
  process.exitCode = 1;
} else {
  const counts = report.metadata?.vulnerabilities ?? {};
  process.stdout.write(
    `Production audit passed (${counts.critical ?? 0} critical, ${counts.high ?? 0} high, ${counts.moderate ?? 0} moderate, ${counts.low ?? 0} low).\n`,
  );
  if (severe.length === 1) {
    process.stdout.write(
      `Accepted ${accepted.id}: unpatched cache advisory confined to Workflow's unused optional Nest/SWC downloader path.\n`,
    );
  }
}

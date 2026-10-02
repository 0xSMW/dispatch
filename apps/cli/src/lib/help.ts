export const globalOptions = [
  ["--api-key <key>", "API key (overrides env and saved profile)"],
  ["--api-url <url>", "API base URL (overrides env and saved profile)"],
  ["-p, --profile <name>", "Profile to use (overrides DISPATCH_PROFILE)"],
  ["--json", "Force JSON output"],
  ["-q, --quiet", "Suppress spinners and status output (implies --json)"],
];

// The footer every command shares: global options, output, error codes, examples.
// The root command already lists the global options, so it passes globals: false.
export function helpText(spec: { output?: string; codes?: string[]; examples?: string[]; globals?: boolean }) {
  const width = Math.max(...globalOptions.map(([flag]) => flag!.length));
  const lines = [
    ...(spec.globals === false ? [] : ["", "Global options:", ...globalOptions.map(([flag, text]) => `  ${flag!.padEnd(width)}  ${text}`)]),
    "",
    "Output:",
    `  ${spec.output ?? "Human-readable on a terminal. JSON when piped or with --json."}`,
    "",
    "Errors:",
    `  ${["auth_error", ...(spec.codes ?? [])].filter((code, index, all) => all.indexOf(code) === index).join(", ")}`,
  ];
  if (spec.examples?.length) lines.push("", "Examples:", ...spec.examples.map((example) => `  $ ${example}`));
  return lines.join("\n");
}

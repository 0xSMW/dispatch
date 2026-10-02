export type Globals = {
  apiKey?: string;
  apiUrl?: string;
  profile?: string;
  json?: boolean;
  quiet?: boolean;
};

export function interactive() {
  return (
    Boolean(process.stdin.isTTY && process.stdout.isTTY) &&
    !["true", "1"].includes(process.env.CI ?? "") &&
    !process.env.GITHUB_ACTIONS &&
    process.env.TERM !== "dumb"
  );
}

export function jsonMode(globals: Globals) {
  return Boolean(globals.json || globals.quiet || !process.stdout.isTTY);
}

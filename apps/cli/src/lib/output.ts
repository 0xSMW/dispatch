import pc from "picocolors";
import { ApiError, Cancelled, CliError } from "./errors.js";
import { safe } from "./safe.js";
import { jsonMode, type Globals } from "./tty.js";

export function output(data: unknown, globals: Globals, human?: () => void) {
  if (jsonMode(globals) || !human) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  human();
}

// Status lines go to stderr so stdout stays clean for pipes.
export function status(message: string, globals: Globals) {
  if (globals.quiet) return;
  if (jsonMode(globals) && !process.stderr.isTTY) return;
  console.error(message);
}

export function errorBody(error: unknown, code: string) {
  if (error instanceof ApiError) {
    return { message: error.message, code: error.code || code, ...(error.statusCode ? { statusCode: error.statusCode } : {}) };
  }
  if (error instanceof CliError) return { message: error.message, code: error.code };
  return { message: error instanceof Error ? error.message : String(error), code };
}

export function fail(error: unknown, code: string, globals: Globals): never {
  if (error instanceof Cancelled) {
    console.error("Cancelled.");
    process.exit(130);
  }
  const body = errorBody(error, code);
  if (jsonMode(globals)) console.error(JSON.stringify({ error: body }, null, 2));
  else console.error(pc.red(`Error: ${safe(body.message)}`));
  process.exit(1);
}

// Unwinds to the command's error handler, which prints "Cancelled." and exits 130.
export function cancel(): never {
  throw new Cancelled();
}

// Print every scalar field of a record as "key: value", and summarize the rest.
export function renderRecord(data: unknown) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    console.log(safe(data));
    return;
  }
  const entries = Object.entries(data as Record<string, unknown>);
  const width = Math.max(0, ...entries.map(([key]) => key.length));
  for (const [key, value] of entries) {
    const label = pc.dim(`${key.padEnd(width)} `);
    if (Array.isArray(value)) {
      const scalars = value.every((item) => item === null || typeof item !== "object");
      console.log(`${label}${scalars ? safe(value.join(", ")) : pc.dim(`(${value.length} items)`)}`);
    } else if (value && typeof value === "object") {
      console.log(`${label}${safe(JSON.stringify(value))}`);
    } else {
      console.log(`${label}${safe(value)}`);
    }
  }
}

import { readFile } from "node:fs/promises";
import { CliError } from "./errors.js";

export const input = { stdin: process.stdin as NodeJS.ReadableStream, used: false };

async function stdin() {
  if (input.used) throw new CliError("stdin_conflict", "Only one flag can read from stdin (-)");
  input.used = true;
  const chunks: Buffer[] = [];
  for await (const chunk of input.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// Read a file, or stdin when the path is "-".
export async function readBytes(path: string): Promise<Buffer> {
  if (path === "-") return stdin();
  try {
    return await readFile(path);
  } catch (error) {
    throw new CliError("file_error", `Could not read ${path}: ${(error as Error).message}`);
  }
}

export async function read(path: string) {
  return (await readBytes(path)).toString("utf8");
}

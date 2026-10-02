#!/usr/bin/env node
import "./lib/env.js";
import { legacy } from "./lib/legacy.js";
import { fail } from "./lib/output.js";
import { program } from "./program.js";

// Exit quietly when the reader goes away, as in `dispatch commands | head`.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

// pnpm passes a bare "--" through to the script; drop it before parsing.
const argv = process.argv.slice(2);
if (argv[0] === "--") argv.shift();

program.parseAsync(legacy(argv), { from: "user" }).catch((error) => fail(error, "unexpected_error", program.opts()));

import { jsonMode, type Globals } from "./tty.js";

const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// A spinner on stderr, shown only to a person at a terminal.
export async function withSpinner<T>(message: string, work: () => Promise<T>, globals: Globals): Promise<T> {
  if (!process.stderr.isTTY || jsonMode(globals)) return work();
  let frame = 0;
  const draw = () => process.stderr.write(`\r${frames[frame++ % frames.length]} ${message}`);
  draw();
  const timer = setInterval(draw, 80);
  try {
    return await work();
  } finally {
    clearInterval(timer);
    process.stderr.write("\r\u001b[2K");
  }
}

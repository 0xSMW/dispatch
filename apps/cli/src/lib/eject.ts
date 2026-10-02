import { constants } from "node:fs";
import { cp, copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "./errors.js";

// Copy one library template plus the shared files it imports: every entry
// whose name starts with "_", such as _components/ and _theme.ts.
//
// Nothing the user already has is replaced unless `force` is set. The shared files are the ones
// people edit after the first eject, and a second eject must not undo that.
export async function ejectTemplate(sourceDir: string, slug: string, destDir: string, options: { force?: boolean } = {}) {
  const names = await readdir(sourceDir, { withFileTypes: true });
  if (!names.some((entry) => entry.name === `${slug}.tsx`)) {
    throw new CliError("not_found", `No library template named "${slug}"`);
  }
  await mkdir(destDir, { recursive: true });
  const target = join(destDir, `${slug}.tsx`);
  try {
    await copyFile(join(sourceDir, `${slug}.tsx`), target, options.force ? 0 : constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new CliError("exists", `${target} already exists. Pass --force to replace it`);
  }
  for (const entry of names) {
    if (!entry.name.startsWith("_")) continue;
    await cp(join(sourceDir, entry.name), join(destDir, entry.name), {
      recursive: true,
      force: Boolean(options.force),
      filter: (path) => !path.split(/[\\/]/).at(-1)!.startsWith("."),
    });
  }
}

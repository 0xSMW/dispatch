import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ejectTemplate } from "../../src/lib/eject.js";

describe("ejectTemplate", () => {
  it("copies the template and the shared components", async () => {
    const root = await mkdtemp(join(tmpdir(), "dispatch-eject-"));
    try {
      const source = join(root, "emails");
      const dest = join(root, "out");
      await mkdir(join(source, "_components"), { recursive: true });
      await writeFile(join(source, "welcome.tsx"), "export default function Welcome() { return null }\n");
      await writeFile(join(source, "_components", "Layout.tsx"), "export function Layout() { return null }\n");
      await writeFile(join(source, "_theme.ts"), "export const theme = {}\n");
      await writeFile(join(source, "other.tsx"), "export default function Other() { return null }\n");
      await ejectTemplate(source, "welcome", dest);
      expect(await readFile(join(dest, "welcome.tsx"), "utf8")).toContain("function Welcome");
      expect(await readFile(join(dest, "_components", "Layout.tsx"), "utf8")).toContain("function Layout");
      expect(await readFile(join(dest, "_theme.ts"), "utf8")).toContain("theme");
      await expect(readFile(join(dest, "other.tsx"), "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the user's edits on a second eject unless forced", async () => {
    const root = await mkdtemp(join(tmpdir(), "dispatch-eject-"));
    try {
      const source = join(root, "emails");
      const dest = join(root, "out");
      await mkdir(join(source, "_components"), { recursive: true });
      await writeFile(join(source, "welcome.tsx"), "library welcome\n");
      await writeFile(join(source, "receipt.tsx"), "library receipt\n");
      await writeFile(join(source, "_components", "Layout.tsx"), "library layout\n");
      await writeFile(join(source, "_theme.ts"), "library theme\n");
      await ejectTemplate(source, "welcome", dest);
      await writeFile(join(dest, "_theme.ts"), "my theme\n");
      await writeFile(join(dest, "_components", "Layout.tsx"), "my layout\n");
      await writeFile(join(dest, "welcome.tsx"), "my welcome\n");

      await ejectTemplate(source, "receipt", dest);
      expect(await readFile(join(dest, "receipt.tsx"), "utf8")).toBe("library receipt\n");
      expect(await readFile(join(dest, "_theme.ts"), "utf8")).toBe("my theme\n");
      expect(await readFile(join(dest, "_components", "Layout.tsx"), "utf8")).toBe("my layout\n");

      await expect(ejectTemplate(source, "welcome", dest)).rejects.toMatchObject({ code: "exists" });
      expect(await readFile(join(dest, "welcome.tsx"), "utf8")).toBe("my welcome\n");

      await ejectTemplate(source, "welcome", dest, { force: true });
      expect(await readFile(join(dest, "welcome.tsx"), "utf8")).toBe("library welcome\n");
      expect(await readFile(join(dest, "_theme.ts"), "utf8")).toBe("library theme\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails with not_found for an unknown slug", async () => {
    const root = await mkdtemp(join(tmpdir(), "dispatch-eject-"));
    try {
      await expect(ejectTemplate(root, "missing", join(root, "out"))).rejects.toMatchObject({ code: "not_found" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

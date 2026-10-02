import { build, type Plugin } from "esbuild";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CliError } from "./errors.js";

const renderers = ["react-email", "@react-email/components", "@react-email/render"];

export type TemplateSource = {
  key: string;
  prop?: string;
  type?: string;
  fallback_value?: string | number | null;
  fields?: string[];
};

export function rendererFor(resolveName: (name: string) => string) {
  return renderers.find((name) => {
    try {
      resolveName(name);
      return true;
    } catch {
      return false;
    }
  });
}

function realPath(path: string) {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

function exportRenderer(entry: string): Plugin {
  return {
    name: "dispatch-export-renderer",
    setup(builder) {
      const projectRequire = createRequire(entry);
      const renderer = rendererFor((name) => projectRequire.resolve(name));
      // esbuild hands over the real path. The entry may have been given through a symlink
      // (/tmp and /var are symlinks on macOS), so both sides are compared as real paths.
      const real = realPath(entry);
      builder.onLoad({ filter: /.*/ }, async (args) => {
        if (realPath(args.path) !== real) return undefined;
        if (!renderer) {
          throw new Error("Install `react-email` in your project to use --react-email.");
        }
        return {
          contents: `${await readFile(args.path, "utf8")}
            export { render as __render } from ${JSON.stringify(renderer)};
            export { createElement as __createElement } from "react";`,
          loader: "tsx",
          resolveDir: dirname(args.path),
        };
      });
    },
  };
}

// Bundles the file once and returns its static fields with a render function. The bundle lives
// in memory after it is loaded, so the temporary directory is removed before this returns.
export async function loadFile(file: string) {
  const entry = resolve(file);
  const dir = await mkdtemp(join(tmpdir(), "dispatch-react-email-"));
  const outfile = join(dir, "email.cjs");
  let bundle: {
    default?: unknown;
    __render: (node: unknown) => Promise<string> | string;
    __createElement: (component: unknown, props: Record<string, unknown>) => unknown;
  };
  try {
    try {
      await build({
        entryPoints: [entry],
        outfile,
        bundle: true,
        platform: "node",
        format: "cjs",
        jsx: "automatic",
        logLevel: "silent",
        plugins: [exportRenderer(entry)],
      });
    } catch (error) {
      throw new CliError("react_email_build_error", error instanceof Error ? error.message : String(error));
    }
    bundle = createRequire(import.meta.url)(outfile);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const Component = bundle.default as
    | (((props: Record<string, unknown>) => unknown) & {
        Variables?: TemplateSource[];
        Subject?: string;
        Track?: boolean;
        Brand?: boolean;
        PreviewProps?: Record<string, unknown>;
      })
    | undefined;
  if (typeof Component !== "function") {
    throw new CliError("react_email_build_error", `${file} has no default export`);
  }
  return {
    variables: Component.Variables ?? [],
    subject: Component.Subject,
    track: typeof Component.Track === "boolean" ? Component.Track : undefined,
    brand: Component.Brand !== false,
    async render(props?: Record<string, unknown>) {
      try {
        return String(await bundle.__render(bundle.__createElement(Component, props ?? Component.PreviewProps ?? {})));
      } catch (error) {
        throw new CliError("react_email_render_error", error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export async function renderFile(file: string, props?: Record<string, unknown>) {
  const loaded = await loadFile(file);
  return { html: await loaded.render(props), variables: loaded.variables, subject: loaded.subject };
}

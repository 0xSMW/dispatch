import { describe, expect, it, vi } from "vitest";
import { script } from "../../src/commands/completion.js";
import { paths, tree, type Node } from "../../src/lib/tree.js";
import { program } from "../../src/program.js";
import { run, setNonInteractive, spies, captureExit } from "../helpers.js";

vi.mock("@dispatchmail/sdk", async () => (await import("../helpers.js")).sdk);

function find(node: Node, path: string[]): Node | undefined {
  if (path.length === 0) return node;
  const child = node.subcommands.find((item) => item.name === path[0]);
  return child && find(child, path.slice(1));
}

describe("commands", () => {
  it("prints the tree as { name, aliases, description, subcommands, options }", async () => {
    setNonInteractive();
    captureExit();
    const { stdout } = spies();
    expect(await run(program, ["commands"])).toBe(0);
    const root = JSON.parse(stdout()) as Node;
    expect(Object.keys(root)).toEqual(expect.arrayContaining(["name", "aliases", "description", "subcommands", "options"]));
    expect(root.name).toBe("dispatch");
    expect(root.options.map((option) => option.flags)).toContain("--api-url <url>");
  });

  it("uses Resend's group names and keeps the Dispatch-only commands", () => {
    const root = tree(program);
    const names = root.subcommands.map((node) => node.name);
    for (const name of [
      "emails",
      "domains",
      "api-keys",
      "webhooks",
      "templates",
      "broadcasts",
      "contacts",
      "contact-properties",
      "segments",
      "topics",
      "suppressions",
      "automations",
      "events",
      "logs",
      "login",
      "logout",
      "whoami",
      "auth",
      "doctor",
      "usage",
      "open",
      "commands",
      "completion",
      "dev",
      "tail",
      "timeline",
      "system",
    ])
      expect(names).toContain(name);
    expect(names).not.toContain("send");
    expect(names).not.toContain("keys");
    expect(find(root, ["emails", "receiving", "listen"])).toBeDefined();
    expect(find(root, ["emails", "receiving", "simulate"])).toBeDefined();
    expect(find(root, ["webhooks", "events", "replay"])).toBeDefined();
    expect(find(root, ["templates", "eject"])).toBeDefined();
    expect(find(root, ["suppressions", "batch", "remove"])).toBeDefined();
    expect(find(root, ["domains", "list"])?.aliases).toEqual(["ls"]);
    expect(find(root, ["domains", "delete"])?.aliases).toEqual(["rm"]);
  });

  it("gives every destructive command --yes and every list --limit, --after, --before", () => {
    const visit = (node: Node, path: string[]) => {
      const flags = node.options.map((option) => option.flags);
      if (node.name === "delete") expect(flags, path.join(" ")).toContain("--yes");
      if (node.name === "list" && path[0] !== "auth") {
        expect(flags, path.join(" ")).toEqual(expect.arrayContaining(["--limit <n>", "--after <cursor>", "--before <cursor>"]));
      }
      for (const child of node.subcommands) visit(child, [...path, child.name]);
    };
    visit(tree(program), []);
  });

  it("hides old flags from the tree", () => {
    const send = find(tree(program), ["emails", "send"])!;
    const flags = send.options.map((option) => option.flags);
    expect(flags).toContain("--react-email <file>");
    expect(flags).not.toContain("--variables <json>");
  });
});

describe("completion", () => {
  const table = paths({ ...tree(program), options: [] }, ["--json"]);

  it("knows each command path, aliases included", () => {
    expect(table.get("")).toEqual(expect.arrayContaining(["emails", "domains", "--json", "--help"]));
    expect(table.get("emails receiving")).toEqual(expect.arrayContaining(["list", "ls", "listen", "simulate"]));
    expect(table.get("domains ls")).toEqual(expect.arrayContaining(["--limit", "--after"]));
  });

  it.each(["bash", "zsh", "fish", "powershell"] as const)("generates a %s script", (shell) => {
    const text = script(shell, table);
    expect(text).toContain("emails receiving");
    expect(text.length).toBeGreaterThan(1000);
  });

  it("registers the right hook per shell", () => {
    expect(script("bash", table)).toContain("complete -o default -F _dispatch dispatch");
    expect(script("zsh", table)).toContain("bashcompinit");
    expect(script("fish", table)).toContain("complete -c dispatch");
    expect(script("powershell", table)).toContain("Register-ArgumentCompleter -Native -CommandName dispatch");
  });
});

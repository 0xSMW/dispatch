import { describe, expect, it } from "vitest";
import { compact, jsonFlag, many, pairs } from "../../src/lib/json.js";
import { legacy } from "../../src/lib/legacy.js";
import { safe } from "../../src/lib/safe.js";
import { renderTable } from "../../src/lib/table.js";

describe("json flags", () => {
  it("parses JSON or fails with invalid_json naming the flag", () => {
    expect(jsonFlag('{"a":1}', "--props")).toEqual({ a: 1 });
    expect(jsonFlag(undefined, "--props")).toBeUndefined();
    expect(() => jsonFlag("{a", "--props")).toThrowError(
      expect.objectContaining({ code: "invalid_json", message: "--props must be valid JSON" }),
    );
  });

  it("turns repeatable key=value flags into an object, keeping = in values", () => {
    expect(pairs(["a=1", "b=x=y"], "--var")).toEqual({ a: "1", b: "x=y" });
    expect(pairs(undefined, "--var")).toBeUndefined();
    expect(() => pairs(["novalue"], "--var")).toThrowError(expect.objectContaining({ code: "invalid_flag" }));
  });

  it("splits repeatable comma lists and drops undefined fields", () => {
    expect(many(["a@x.com,b@x.com", "c@x.com"])).toEqual(["a@x.com", "b@x.com", "c@x.com"]);
    expect(many([])).toBeUndefined();
    expect(compact({ a: 1, b: undefined, c: false })).toEqual({ a: 1, c: false });
  });
});

describe("safe", () => {
  it("strips terminal escapes and control characters", () => {
    expect(safe("\u001b[31mred\u001b[0m")).toBe("red");
    expect(safe("title\u001b]0;pwned\u0007 ok")).toBe("title ok");
    expect(safe("a\u0000b\u0007c\td")).toBe("abc\td");
    expect(safe(null)).toBe("");
    expect(safe({ a: 1 })).toBe('{"a":1}');
  });

  it("is applied to every table cell", () => {
    expect(renderTable(["A"], [["\u001b[2Jx"]])).toContain("x");
    expect(renderTable(["A"], [["\u001b[2Jx"]])).not.toContain("\u001b[2J");
  });
});

describe("legacy", () => {
  it("rewrites old top-level names, after global options", () => {
    expect(legacy(["send", "--to", "a@x.com"])).toEqual(["emails", "send", "--to", "a@x.com"]);
    expect(legacy(["--api-key", "sk", "keys", "create", "x"])).toEqual(["--api-key", "sk", "api-keys", "create", "x"]);
    expect(legacy(["-p", "prod", "received"])).toEqual(["-p", "prod", "emails", "receiving"]);
    expect(legacy(["listen", "--port", "8787"])).toEqual(["webhooks", "listen", "--port", "8787"]);
    expect(legacy(["replay", "wh_1"])).toEqual(["webhooks", "events", "replay", "wh_1"]);
    expect(legacy(["test-webhook"])).toEqual(["webhooks", "test"]);
    expect(legacy(["verify-domain", "d_1"])).toEqual(["domains", "doctor", "d_1"]);
  });

  it("rewrites renamed subcommands", () => {
    expect(legacy(["suppressions", "create", "a@x.com"])).toEqual(["suppressions", "add", "a@x.com"]);
    expect(legacy(["broadcasts", "clone", "bc_1"])).toEqual(["broadcasts", "duplicate", "bc_1"]);
    expect(legacy(["webhooks", "attempts", "wh_1"])).toEqual(["webhooks", "events", "list", "wh_1"]);
  });

  it("leaves current names and option values alone", () => {
    expect(legacy(["emails", "send", "--subject", "send"])).toEqual(["emails", "send", "--subject", "send"]);
    expect(legacy(["--profile", "send", "domains"])).toEqual(["--profile", "send", "domains"]);
    expect(legacy([])).toEqual([]);
  });
});

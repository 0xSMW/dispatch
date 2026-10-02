import { beforeEach, describe, expect, it } from "vitest";
import { ApiError, Cancelled, CliError } from "../../src/lib/errors.js";
import { cancel, errorBody, fail, output, status } from "../../src/lib/output.js";
import { jsonMode } from "../../src/lib/tty.js";
import { captureExit, errorJson, exitCode, setInteractive, setNonInteractive, spies } from "../helpers.js";

describe("output", () => {
  beforeEach(() => {
    setNonInteractive();
    captureExit();
  });

  it("prints pretty JSON when stdout is not a TTY", () => {
    const { stdout } = spies();
    let ran = false;
    output({ id: "x" }, {}, () => (ran = true));
    expect(stdout()).toBe(JSON.stringify({ id: "x" }, null, 2));
    expect(ran).toBe(false);
  });

  it("uses the human printer on a TTY, and JSON with --json or --quiet", () => {
    setInteractive();
    const { stdout } = spies();
    output({ id: "x" }, {}, () => console.log("human"));
    output({ id: "y" }, { json: true }, () => console.log("human"));
    output({ id: "z" }, { quiet: true }, () => console.log("human"));
    expect(stdout().split("\n")[0]).toBe("human");
    expect(stdout()).toContain('"id": "y"');
    expect(stdout()).toContain('"id": "z"');
    expect(jsonMode({})).toBe(false);
  });

  it("keeps status lines off stderr in quiet mode", () => {
    setInteractive();
    const { stderr } = spies();
    status("hello", {});
    status("hidden", { quiet: true });
    expect(stderr()).toBe("hello");
  });
});

describe("fail", () => {
  beforeEach(() => {
    setNonInteractive();
    captureExit();
  });

  it("writes the API error name as the code, with the status, and exits 1", async () => {
    const { stderr } = spies();
    const code = await exitCode(
      Promise.resolve().then(() =>
        fail(new ApiError({ name: "validation_error", statusCode: 422, message: "Bad from" }), "send_error", {}),
      ),
    );
    expect(code).toBe(1);
    expect(errorJson(stderr())).toEqual({ error: { message: "Bad from", code: "validation_error", statusCode: 422 } });
  });

  it("uses the CliError code, and the fallback code for anything else", () => {
    expect(errorBody(new CliError("missing_id", "Missing domain id"), "x")).toEqual({ message: "Missing domain id", code: "missing_id" });
    expect(errorBody(new Error("boom"), "list_error")).toEqual({ message: "boom", code: "list_error" });
    expect(errorBody("text", "list_error")).toEqual({ message: "text", code: "list_error" });
    expect(errorBody(new ApiError({ name: "application_error", statusCode: null, message: "offline" }), "x")).toEqual({
      message: "offline",
      code: "application_error",
    });
  });

  it("prints a red one-line message on a terminal", async () => {
    setInteractive();
    const { stderr } = spies();
    await exitCode(Promise.resolve().then(() => fail(new CliError("missing_id", "Missing domain id"), "x", {})));
    expect(stderr()).toContain("Error: Missing domain id");
  });

  it("cancel prints Cancelled. and exits 130", async () => {
    const { stderr } = spies();
    expect(await exitCode(Promise.resolve().then(() => fail(new Cancelled(), "x", {})))).toBe(130);
    expect(() => cancel()).toThrowError(Cancelled);
    expect(stderr()).toBe("Cancelled.");
  });
});

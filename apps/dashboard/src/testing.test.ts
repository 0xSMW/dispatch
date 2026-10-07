// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

describe("browser test HTTP globals", () => {
  it("accepts a controller signal in the native Request", () => {
    const controller = new AbortController();
    const request = new Request("https://example.test", { signal: controller.signal });
    controller.abort();
    expect(request.signal.aborted).toBe(true);
  });

  it("accepts static abort signals in the native Request", () => {
    const request = new Request("https://example.test", { signal: AbortSignal.abort() });
    expect(request.signal.aborted).toBe(true);
  });

  it("keeps controller signals usable by DOM event listeners", () => {
    const controller = new AbortController();
    const target = document.createElement("button");
    let calls = 0;
    target.addEventListener("click", () => { calls += 1; }, { signal: controller.signal });
    target.click();
    controller.abort();
    target.click();
    expect(calls).toBe(1);
  });
});

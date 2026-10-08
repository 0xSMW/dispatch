// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { h } from "../testing";
import { Code } from "./Code";

afterEach(cleanup);

it("tints JavaScript as inert text while preserving the exact snippet", () => {
  const value = '// Browser example\nconst markup = "<img src=x onerror=alert(1)>";\nreturn 16;';
  const { container } = render(h(Code, { value, language: "javascript", copy: false }));
  expect(container.querySelector("code")!.textContent).toBe(value);
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector(".tokComment")!.textContent).toBe("// Browser example");
  expect(container.querySelector(".tokString")!.textContent).toBe('"<img src=x onerror=alert(1)>"');
  expect(container.querySelector(".tokLiteral")!.textContent).toBe("const");
  expect(container.querySelector(".tokNumber")!.textContent).toBe("16");
});

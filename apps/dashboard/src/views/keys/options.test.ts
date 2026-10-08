// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useKeyOptions } from "./options";

vi.mock("../../hooks/useList", () => ({ useList: () => ({ rows: [
  { id: "key_owner", name: "owner" },
  { id: "key_named", name: "production API" },
  { id: "key_custom", name: "OWNER" },
] }) }));

it("displays the default owner key as Owner and preserves custom names", () => {
  expect(renderHook(useKeyOptions).result.current).toEqual([
    { value: "key_owner", label: "Owner" },
    { value: "key_named", label: "production API" },
    { value: "key_custom", label: "OWNER" },
  ]);
});

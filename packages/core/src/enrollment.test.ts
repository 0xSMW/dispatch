import { describe, expect, it } from "vitest";
import { automationEnrollSchema } from "./index.js";

describe("explicit enrollment input", () => {
  it.each([{ all: true }, { segment_id: "seg_1" }])("accepts one audience %j", (input) => {
    expect(automationEnrollSchema.parse(input)).toEqual(input);
  });
  it.each([{}, { all: false }, { all: "true" }, { segment_id: "" }, { all: true, segment_id: "seg_1" }, { all: true, from: "free" }])(
    "refuses ambiguous or extra audience fields %j", (input) => {
      expect(automationEnrollSchema.safeParse(input).success).toBe(false);
    },
  );
});

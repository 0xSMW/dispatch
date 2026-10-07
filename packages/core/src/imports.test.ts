import { describe, expect, it } from "vitest";
import { contactImportSchema, settingsSchema, settingsUpdateSchema } from "./index.js";

describe("import automation entry policy", () => {
  it("leaves an omitted import override unresolved while tenant settings default to false", () => {
    expect(contactImportSchema.parse({}).trigger_automations).toBeUndefined();
    expect(settingsSchema.parse({}).import_trigger_automations).toBe(false);
    expect(settingsUpdateSchema.parse({}).import_trigger_automations).toBeUndefined();
  });

  it.each([[true, true], [false, false], ["true", true], ["false", false]])(
    "parses the boolean or multipart flag %j as %s",
    (input, expected) => {
      expect(contactImportSchema.parse({ trigger_automations: input }).trigger_automations).toBe(expected);
    },
  );

  it.each(["TRUE", "False", "yes", "no", "1", "0", " true ", "", 1, 0, null, [], {}])(
    "rejects invalid import entry flag %j instead of truthiness coercion",
    (trigger_automations) => {
      expect(contactImportSchema.safeParse({ trigger_automations }).success).toBe(false);
    },
  );

  it.each([true, false])("retains explicit tenant preference %s in settings and updates", (import_trigger_automations) => {
    expect(settingsSchema.parse({ import_trigger_automations }).import_trigger_automations).toBe(import_trigger_automations);
    expect(settingsUpdateSchema.parse({ import_trigger_automations })).toEqual({ import_trigger_automations });
  });

  it.each(["true", "false", 1, 0, null])("does not coerce tenant setting %j", (import_trigger_automations) => {
    expect(settingsSchema.safeParse({ import_trigger_automations }).success).toBe(false);
    expect(settingsUpdateSchema.safeParse({ import_trigger_automations }).success).toBe(false);
  });
});

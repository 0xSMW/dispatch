import { membership } from "./membership.js";

export const addSegment = membership("add-segment", "Add a contact to a segment", "Added to segment", (api, input) =>
  api.contacts.segments.add(input),
);

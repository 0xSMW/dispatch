import { membership } from "./membership.js";

export const removeSegment = membership("remove-segment", "Remove a contact from a segment", "Removed from segment", (api, input) =>
  api.contacts.segments.remove(input),
);

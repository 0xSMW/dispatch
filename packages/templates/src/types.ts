export const stages = ["acquisition", "onboarding", "retention", "reengagement", "dunning", "reactivation"] as const;

export type LibraryStage = (typeof stages)[number];

export type LibraryVariable = {
  key: string;
  type: "string" | "number" | "list";
  fallback_value: string | number | null;
  fields?: string[];
};

export type LibraryTemplate = {
  slug: string;
  name: string;
  category: string;
  kind: "transactional" | "marketing";
  stage: LibraryStage | null;
  when: string;
  track: boolean;
  subject: string;
  description: string;
  preview: string;
  variables: LibraryVariable[];
  sample: Record<string, unknown>;
  html: string;
  text: string;
  preview_html: string;
};

export type Library = {
  version: string;
  templates: LibraryTemplate[];
};

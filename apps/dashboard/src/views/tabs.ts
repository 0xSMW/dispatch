import type { Tab } from "../components/Tabs";

// Route tabs shared by the pages of one area.

export const emailTabs: Tab[] = [
  { id: "sending", label: "Sending", to: "/emails" },
  { id: "receiving", label: "Receiving", to: "/emails/receiving" },
  { id: "suppressions", label: "Suppressions", to: "/emails/suppressions" },
  // { id: "send", label: "Test send", to: "/emails/send" },
];

export const audienceTabs: Tab[] = [
  { id: "contacts", label: "Contacts", to: "/audience" },
  { id: "topics", label: "Topics", to: "/audience/topics" },
  { id: "properties", label: "Properties", to: "/audience/properties" },
  { id: "segments", label: "Segments", to: "/audience/segments" },
  { id: "forms", label: "Forms", to: "/audience/forms" },
];

export const settingsTabs: Tab[] = [
  { id: "usage", label: "Usage", to: "/settings/usage" },
  { id: "general", label: "General", to: "/settings/general" },
  { id: "team", label: "Team", to: "/settings/team" },
  { id: "smtp", label: "SMTP", to: "/settings/smtp" },
  { id: "integrations", label: "Integrations", to: "/settings/integrations" },
  { id: "brand", label: "Brand", to: "/settings/brand" },
  { id: "unsubscribe-page", label: "Unsubscribe page", to: "/settings/unsubscribe-page" },
];

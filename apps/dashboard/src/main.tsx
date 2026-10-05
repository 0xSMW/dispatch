import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom";
import { Login } from "./shell/Login";
import { Root } from "./shell/Root";
import { EventsRedirect, Shell } from "./shell/Shell";
import { applyTheme } from "./shell/theme";
import { AutomationEditor } from "./views/automations/AutomationEditor";
import { Automations } from "./views/automations/Automations";
import { Events } from "./views/automations/Events";
import { Contact } from "./views/audience/Contact";
import { Contacts } from "./views/audience/Contacts";
import { Properties } from "./views/audience/Properties";
import { Segments } from "./views/audience/Segments";
import { Topics } from "./views/audience/Topics";
import { Broadcast } from "./views/broadcasts/Broadcast";
import { BroadcastEditor } from "./views/broadcasts/BroadcastEditor";
import { Broadcasts } from "./views/broadcasts/Broadcasts";
import { Domain } from "./views/domains/Domain";
import { DomainAdd } from "./views/domains/DomainAdd";
import { Domains } from "./views/domains/Domains";
import { Email } from "./views/emails/Email";
import { Emails } from "./views/emails/Emails";
import { Received } from "./views/emails/Received";
import { ReceivedEmail } from "./views/emails/ReceivedEmail";
import { Send } from "./views/emails/Send";
import { Suppressions } from "./views/emails/Suppressions";
import { Key } from "./views/keys/Key";
import { Keys } from "./views/keys/Keys";
import { Log } from "./views/logs/Log";
import { Logs } from "./views/logs/Logs";
import { Metrics } from "./views/metrics/Metrics";
import { Goals } from "./views/goals/Goals";
import { NotFound } from "./views/NotFound";
import { Shared } from "./views/public/Shared";
import { Unsubscribe } from "./views/public/Unsubscribe";
import { ConfirmPage } from "./views/public/ConfirmPage";
import { Forms } from "./views/forms/Forms";
import { Brand } from "./views/settings/Brand";
import { General } from "./views/settings/General";
import { Smtp } from "./views/settings/Smtp";
import { Integrations } from "./views/settings/Integrations";
import { Team } from "./views/settings/Team";
import { UnsubscribePage } from "./views/settings/UnsubscribePage";
import { Usage } from "./views/settings/Usage";
import { Setup } from "./views/setup/Setup";
import { Library } from "./views/templates/Library";
import { Template } from "./views/templates/Template";
import { TemplateEditor } from "./views/templates/TemplateEditor";
import { Templates } from "./views/templates/Templates";
import { Timeline } from "./views/timeline/Timeline";
import { Webhook } from "./views/webhooks/Webhook";
import { Webhooks } from "./views/webhooks/Webhooks";
import "./styles.css";

// Every page in the dashboard, one entry each.
// Static segments such as `emails/receiving` outrank `emails/:id`, so order does not matter.
export const routes = [
  {
    element: <Root />,
    children: [
      { path: "login", element: <Login /> },
      { path: "shared", element: <Shared /> },
      { path: "unsubscribe", element: <Unsubscribe /> },
      { path: "confirm/:token", element: <ConfirmPage /> },
      {
        element: <Shell />,
        children: [
          { index: true, element: <Navigate to="/emails" replace /> },
          { path: "setup", element: <Setup /> },

          { path: "emails", element: <Emails /> },
          { path: "emails/:id", element: <Email /> },
          { path: "emails/receiving", element: <Received /> },
          { path: "emails/receiving/:id", element: <ReceivedEmail /> },
          { path: "emails/suppressions", element: <Suppressions /> },
          { path: "emails/send", element: <Send /> },

          { path: "broadcasts", element: <Broadcasts /> },
          { path: "broadcasts/:id", element: <Broadcast /> },
          { path: "broadcasts/:id/editor", element: <BroadcastEditor /> },

          { path: "automations", element: <Automations /> },
          { path: "events", element: <Events /> },
          { path: "automations/events", element: <EventsRedirect /> },
          { path: "automations/:id/editor", element: <AutomationEditor /> },

          { path: "templates", element: <Templates /> },
          { path: "templates/library", element: <Library /> },
          { path: "templates/:id", element: <Template /> },
          { path: "templates/:id/editor", element: <TemplateEditor /> },

          { path: "audience", element: <Contacts /> },
          { path: "audience/contacts/:id", element: <Contact /> },
          { path: "audience/properties", element: <Properties /> },
          { path: "audience/segments", element: <Segments /> },
          { path: "audience/topics", element: <Topics /> },
          { path: "audience/forms", element: <Forms /> },

          { path: "metrics", element: <Metrics /> },
          { path: "goals", element: <Goals /> },

          { path: "domains", element: <Domains /> },
          { path: "domains/add", element: <DomainAdd /> },
          { path: "domains/:id", element: <Domain /> },

          { path: "logs", element: <Logs /> },
          { path: "logs/:id", element: <Log /> },

          { path: "api-keys", element: <Keys /> },
          { path: "api-keys/:id", element: <Key /> },

          { path: "webhooks", element: <Webhooks /> },
          { path: "webhooks/:id", element: <Webhook /> },

          { path: "settings", element: <Navigate to="/settings/general" replace /> },
          { path: "settings/usage", element: <Usage /> },
          { path: "settings/general", element: <General /> },
          { path: "settings/team", element: <Team /> },
          { path: "settings/smtp", element: <Smtp /> },
          { path: "settings/integrations", element: <Integrations /> },
          { path: "settings/brand", element: <Brand /> },
          { path: "settings/unsubscribe-page", element: <UnsubscribePage /> },

          { path: "timeline", element: <Timeline /> },
          { path: "*", element: <NotFound /> },
        ],
      },
    ],
  },
];

applyTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={createBrowserRouter(routes)} />
  </StrictMode>,
);

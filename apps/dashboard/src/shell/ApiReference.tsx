import { useState } from "react";
import { useLocation } from "react-router-dom";
import { Badge } from "../components/Badge";
import { Code } from "../components/Code";
import { Drawer } from "../components/Drawer";
import { Tabs } from "../components/Tabs";
import { curl, referenceFor, sdk } from "../lib/reference";
import "../styles/shell.css";

type Language = "curl" | "node";

const methodTone = { GET: "info", POST: "success", PATCH: "warning", DELETE: "danger" } as const;

/** The in-app API reference: the calls behind the page on screen, with copyable snippets. */
export function ApiReference({ apiUrl, onClose }: { apiUrl: string; onClose: () => void }) {
  const { pathname } = useLocation();
  const reference = referenceFor(pathname);
  const [language, setLanguage] = useState<Language>("curl");

  return (
    <Drawer isOpen width="wide" label="API reference" title={reference?.title ?? "This page"} onClose={onClose}>
      {!reference ? (
        <p className="muted">No API calls are listed for this page.</p>
      ) : (
        <div className="stack">
          <p className="muted">
            The calls this page makes. Set <span className="mono">DISPATCH_API_KEY</span> to a key from API keys.
          </p>
          <Tabs
            label="Snippet language"
            value={language}
            onChange={setLanguage}
            tabs={[
              { id: "curl", label: "cURL" },
              { id: "node", label: "Node.js" },
            ]}
          />
          {reference.calls.map((call) => {
            const snippet = language === "node" ? sdk(call, apiUrl) : curl(call, apiUrl);
            return (
              <section key={`${call.method} ${call.path}`} className="apiCall" aria-label={`${call.method} ${call.path}`}>
                <header className="apiCallHead">
                  <Badge value={call.method} variant={methodTone[call.method]} />
                  <span className="mono">{call.path}</span>
                </header>
                <p className="muted">{call.summary}</p>
                {snippet ? <Code value={snippet} language="text" /> : <p className="dim">The Node.js SDK has no method for this call yet. Use cURL.</p>}
              </section>
            );
          })}
        </div>
      )}
    </Drawer>
  );
}

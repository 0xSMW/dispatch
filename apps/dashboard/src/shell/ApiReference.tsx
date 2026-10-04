import { useState } from "react";
import { useLocation } from "react-router-dom";
import { Badge } from "../components/Badge";
import { Code } from "../components/Code";
import { Copy } from "../components/Copy";
import { Drawer } from "../components/Drawer";
import { Tabs } from "../components/Tabs";
import { curl, go, llmsLinks, python, referenceFor, sdk } from "../lib/reference";
import "../styles/shell.css";

type Language = "curl" | "typescript" | "python" | "go" | "agent";

const snippets = { curl, typescript: sdk, python, go };
const languageNames = { curl: "cURL", typescript: "TypeScript", python: "Python", go: "Go" };

const methodTone = { GET: "info", POST: "success", PATCH: "warning", DELETE: "danger" } as const;

/** The in-app API reference: the calls behind the page on screen, with copyable snippets. */
export function ApiReference({ apiUrl, onClose }: { apiUrl: string; onClose: () => void }) {
  const { pathname } = useLocation();
  const reference = referenceFor(pathname);
  const [language, setLanguage] = useState<Language>("curl");
  const links = llmsLinks();

  return (
    <Drawer isOpen width="wide" label="API reference" title={reference?.title ?? "This page"} onClose={onClose}>
      {!reference ? (
        <p className="muted">No API calls are listed for this page.</p>
      ) : (
        <div className="stack">
          <p className="muted">
            The API for this page. Set <span className="mono">DISPATCH_API_KEY</span> to a key from API keys.
          </p>
          <Tabs
            label="Snippet language"
            value={language}
            onChange={setLanguage}
            tabs={[
              { id: "curl", label: "cURL" },
              { id: "typescript", label: "TypeScript" },
              { id: "python", label: "Python" },
              { id: "go", label: "Go" },
              { id: "agent", label: "Agent" },
            ]}
          />
          {language === "agent" ? (
            <section className="stack" aria-label="Agent prompt">
              <div className="toolbar">
                <h3>Ask your agent</h3>
                <Copy value={reference.prompt} chip display="Copy prompt" label="Copy prompt" />
              </div>
              <Code value={reference.prompt} copy={false} />
              <p className="muted">This prompt contains no API key or dashboard session credentials.</p>
            </section>
          ) : reference.calls.map((call) => {
            const snippet = snippets[language](call, apiUrl);
            return (
              <section key={`${call.method} ${call.path}`} className="apiCall" aria-label={`${call.method} ${call.path}`}>
                <header className="apiCallHead">
                  <Badge value={call.method} variant={methodTone[call.method]} />
                  <span className="mono">{call.path}</span>
                </header>
                <p className="muted">{call.summary}</p>
                {snippet ? <Code value={snippet} language="text" /> : (
                  <div className="stack">
                    <p className="dim">The {languageNames[language]} SDK does not support this call with these options yet. Use cURL.</p>
                    <Code value={curl(call, apiUrl)} />
                  </div>
                )}
              </section>
            );
          })}
          {links.length ? (
            <nav className="learnLinks" aria-label="Agent documentation">
              {links.map(({ label, href }) => (
                <a key={href} className="learnChip" href={href} target="_blank" rel="noopener noreferrer">{label}</a>
              ))}
            </nav>
          ) : null}
        </div>
      )}
    </Drawer>
  );
}

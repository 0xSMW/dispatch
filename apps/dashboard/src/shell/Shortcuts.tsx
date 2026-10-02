import { Modal } from "../components/Modal";
import { scopes, shortcuts, type Shortcut } from "../lib/shortcuts";
import "../styles/shell.css";

/** The `?` dialog: every shortcut from lib/shortcuts.ts, grouped by where it works. */
export function Shortcuts({ onClose }: { onClose: () => void }) {
  const all: Shortcut[] = Object.values(shortcuts);
  return (
    <Modal isOpen title="Keyboard shortcuts" onClose={onClose} size="small">
      <div className="stack">
        {scopes.map((scope) => (
          <section key={scope} aria-label={scope}>
            <h3 className="typeLabel">{scope}</h3>
            <dl className="shortcutList">
              {all
                .filter((item) => item.scope === scope)
                .map((item) => (
                  <div key={item.combo} className="shortcutRow">
                    <dt>{item.label}</dt>
                    <dd>
                      {item.keys.map((key) => (
                        <kbd key={key}>{key}</kbd>
                      ))}
                    </dd>
                  </div>
                ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}

import { Modal } from "../components/Modal";
import { scopes, shortcuts, type Shortcut } from "../lib/shortcuts";
import "../styles/shell.css";

/** The `?` dialog: every shortcut from lib/shortcuts.ts, grouped by where it works. */
export function Shortcuts({ onClose, canvas = false }: { onClose: () => void; canvas?: boolean }) {
  const all: Shortcut[] = Object.values(shortcuts);
  return (
    <Modal isOpen title="Keyboard shortcuts" onClose={onClose} size="small">
      <div className="stack">
        {canvas ? <section aria-label="Canvas">
          <h3 className="typeLabel">Canvas</h3>
          <dl className="shortcutList">
            <div className="shortcutRow"><dt>Pan canvas</dt><dd><kbd>Space</kbd> + drag</dd></div>
            <div className="shortcutRow"><dt>Pan with a trackpad or mouse wheel</dt><dd>Scroll</dd></div>
            <div className="shortcutRow"><dt>Change canvas zoom</dt><dd>− / + controls</dd></div>
            <div className="shortcutRow"><dt>Bring every step into view</dt><dd>Fit</dd></div>
            <div className="shortcutRow"><dt>Close the step inspector outside a field or dialog</dt><dd><kbd>Esc</kbd></dd></div>
          </dl>
        </section> : null}
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

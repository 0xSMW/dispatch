import { useState } from "react";
import { Monitor, Smartphone } from "lucide-react";
import { EmailFrame } from "../../components/EmailFrame";
import { Empty } from "../../components/Empty";

/**
 * The Preview tab: the email HTML in `EmailFrame`, with a desktop and phone width toggle.
 * `untrusted` is for received mail: remote images stay off until the reader asks for them.
 */
export function Preview({ html, untrusted = false }: { html: string | null | undefined; untrusted?: boolean }) {
  const [width, setWidth] = useState<"desktop" | "phone">("desktop");
  const [images, setImages] = useState(false);
  if (!html) return <Empty title="No HTML version" body="This email is plain text only. Open the Plain text tab to view." />;
  return (
    <div className="stack">
      <div className="segmented" role="group" aria-label="Preview width">
        <button type="button" className={width === "desktop" ? "ghost small active" : "ghost small"} aria-pressed={width === "desktop"} onClick={() => setWidth("desktop")}>
          <Monitor size={14} /> Desktop
        </button>
        <button type="button" className={width === "phone" ? "ghost small active" : "ghost small"} aria-pressed={width === "phone"} onClick={() => setWidth("phone")}>
          <Smartphone size={14} /> Phone
        </button>
      </div>
      {untrusted && !images ? (
        <p className="fieldHint">
          Remote images are off, so the sender cannot tell that you opened this.{" "}
          <button type="button" className="ghost small" onClick={() => setImages(true)}>
            Load remote images
          </button>
        </p>
      ) : null}
      <EmailFrame html={html} width={width} remote={untrusted ? (images ? "allow" : "block") : undefined} />
    </div>
  );
}

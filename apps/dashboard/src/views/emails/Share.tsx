import { useState } from "react";
import { Copy } from "../../components/Copy";
import { Select } from "../../components/Field";
import { Modal } from "../../components/Modal";
import { useMutation } from "../../hooks/useMutation";
import { useClient } from "../../shell/session";
import type { ShareLink } from "../../types";

const expiries = [
  { value: "1h", label: "1 hour" },
  { value: "24h", label: "24 hours" },
  { value: "48h", label: "48 hours" },
];

/** Creates a public link to one sent or received email through `POST /emails/:id/share`. */
export function Share({ emailId, onClose }: { emailId: string; onClose: () => void }) {
  const client = useClient();
  const [expiresIn, setExpiresIn] = useState("24h");
  const share = useMutation(() => client.post<ShareLink>(`/emails/${emailId}/share`, { expires_in: expiresIn }), {
    success: "Share link created.",
  });

  if (share.data) {
    return (
      <Modal
        isOpen
        title="Share email"
        onClose={onClose}
        actions={
          <button type="button" onClick={onClose}>
            Done
          </button>
        }
      >
        <div className="stack">
          <p className="muted">Anyone with this link can read the email until it expires.</p>
          <Copy value={share.data.url} chip className="wrap" />
        </div>
      </Modal>
    );
  }

  return (
    <Modal isOpen title="Share email" onClose={onClose} onSubmit={() => void share.mutate()} submitLabel="Create link" submitting={share.isLoading} size="small">
      <div className="form">
        <p className="muted">The link shows the subject, sender, recipients, and body. It needs no sign in.</p>
        <Select label="Expires after" value={expiresIn} onChange={setExpiresIn} options={expiries} />
      </div>
    </Modal>
  );
}

import { useState, type ReactNode } from "react";
import { useMutation } from "../hooks/useMutation";
import { Copy } from "./Copy";
import { Modal } from "./Modal";

export interface ConfirmPhraseProps {
  title: string;
  body: ReactNode;
  /** What the user must type, such as the resource name or `DELETE 120 CONTACTS`. */
  phrase: string;
  /** Button label, such as "Delete domain". */
  action: string;
  onConfirm: () => Promise<unknown>;
  onClose: () => void;
  /** Runs after `onConfirm` succeeds, before the dialog closes. Toast and navigate here. */
  onDone?: () => void;
}

/** Type-to-confirm dialog for destructive actions. Render it only while open. */
export function ConfirmPhrase({ title, body, phrase, action, onConfirm, onClose, onDone }: ConfirmPhraseProps) {
  const [typed, setTyped] = useState("");
  const { mutate, isLoading } = useMutation(onConfirm, {
    onSuccess: () => {
      onDone?.();
      onClose();
    },
  });

  return (
    <Modal
      isOpen
      title={title}
      onClose={onClose}
      onSubmit={() => void mutate()}
      submitLabel={action}
      submitDisabled={typed !== phrase}
      submitting={isLoading}
      danger
      size="small"
    >
      <div className="stack">
        <div className="muted">{body}</div>
        <p className="confirmHint">
          Type <Copy value={phrase} chip /> to confirm.
        </p>
        <input
          aria-label="Confirmation phrase"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          autoFocus
          autoComplete="off"
          spellCheck={false}
        />
      </div>
    </Modal>
  );
}

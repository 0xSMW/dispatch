import { useState } from "react";
import { Field } from "../components/Field";
import { Modal } from "../components/Modal";
import { useMutation } from "../hooks/useMutation";
import { useClient } from "./session";

/** Passwords are 12 to 200 characters. The API checks the same rule. */
export function passwordError(password: string): string | null {
  if (!password) return null;
  if (password.length < 12) return "Use at least 12 characters.";
  if (password.length > 200) return "Use at most 200 characters.";
  return null;
}

/** The signed-in user's own password, through `POST /me/password`. Their other sessions end. */
export function ChangePassword({ onClose }: { onClose: () => void }) {
  const client = useClient();
  const [form, setForm] = useState({ current: "", password: "", confirm: "" });
  const mismatch = form.confirm && form.confirm !== form.password ? "The passwords do not match." : null;
  const { mutate, isLoading } = useMutation(
    () => client.post("/me/password", { current_password: form.current, password: form.password }),
    { success: "Password changed.", onSuccess: onClose },
  );

  return (
    <Modal
      isOpen
      size="small"
      title="Change password"
      onClose={onClose}
      onSubmit={() => void mutate()}
      submitLabel="Change password"
      submitDisabled={!form.current || !form.password || Boolean(passwordError(form.password)) || form.confirm !== form.password}
      submitting={isLoading}
    >
      <div className="form">
        <Field
          label="Current password"
          type="password"
          value={form.current}
          onChange={(current) => setForm({ ...form, current })}
          required
          autoFocus
          autoComplete="current-password"
        />
        <Field
          label="New password"
          type="password"
          value={form.password}
          onChange={(password) => setForm({ ...form, password })}
          error={passwordError(form.password)}
          hint="12 to 200 characters. Your other sessions are signed out."
          required
          autoComplete="new-password"
        />
        <Field
          label="Confirm new password"
          type="password"
          value={form.confirm}
          onChange={(confirm) => setForm({ ...form, confirm })}
          error={mismatch}
          required
          autoComplete="new-password"
        />
      </div>
    </Modal>
  );
}

import { useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { Activity } from "lucide-react";
import { Field } from "../components/Field";
import { defaultApiUrl, errorMessage } from "../lib/client";
import { useSession } from "./session";

/**
 * Sign in: email and password, exchanged for a session token through `POST /sessions`. The API
 * URL field shows only when the build has no VITE_API_URL.
 */
export function Login() {
  const { session, signIn } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? "/emails";
  const [form, setForm] = useState({ apiUrl: defaultApiUrl(), email: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (session) return <Navigate to={from} replace />;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(form);
      navigate(from, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="loginPage">
      <form className="loginCard" onSubmit={submit}>
        <div className="brand">
          <span className="brandMark" aria-hidden>
            <Activity size={18} />
          </span>
          <span>Dispatch</span>
        </div>
        <h1>Sign in</h1>
        {import.meta.env.VITE_API_URL ? null : (
          <Field label="API URL" type="url" value={form.apiUrl} onChange={(apiUrl) => setForm({ ...form, apiUrl })} required mono />
        )}
        <Field
          label="Email"
          type="email"
          value={form.email}
          onChange={(email) => setForm({ ...form, email })}
          required
          autoFocus
          autoComplete="username"
        />
        <Field
          label="Password"
          type="password"
          value={form.password}
          onChange={(password) => setForm({ ...form, password })}
          required
          autoComplete="current-password"
        />
        {error ? (
          <div className="alert" role="alert">
            {error}
          </div>
        ) : null}
        <button type="submit" disabled={busy} aria-busy={busy}>
          {busy ? <span className="spinner" aria-hidden /> : null}
          Sign in
        </button>
      </form>
    </div>
  );
}

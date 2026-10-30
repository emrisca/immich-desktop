import { useState } from "react";
import { createAdmin } from "@/app/setup";
import { Button } from "@/ui/Button";
import { Field } from "@/ui/Field";
import { Panel } from "@/ui/Panel";

type Props = { onCreated: () => void };

const emailLooksReal = (value: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim());

/**
 * The only screen between a new installation and a working server. Immich's own
 * rules apply (password of 8+ characters, a real-looking email), so the button
 * stays disabled until they are met rather than letting the server reject it.
 */
export function FirstRun({ onCreated }: Props) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = name.trim().length > 0 && emailLooksReal(email) && password.length >= 8;

  const submit = async () => {
    if (!ready || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createAdmin({ name: name.trim(), email: email.trim(), password });
      onCreated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  return (
    <div className="page setup">
      <header>
        <p className="eyebrow">First run</p>
        <h1 className="display display--gradient">One account, and you&apos;re in.</h1>
        <p className="lede">
          This is the login for the server on this computer. Nothing is sent anywhere and there
          is no email to confirm — the account is created locally, in the folder you picked.
        </p>
      </header>

      <Panel index={1}>
        <form
          className="setup__form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Field
            label="Your name"
            value={name}
            autoComplete="name"
            placeholder="Ada"
            onChange={(event) => setName(event.target.value)}
          />
          <Field
            label="Email"
            type="email"
            value={email}
            autoComplete="username"
            placeholder="you@example.com"
            onChange={(event) => setEmail(event.target.value)}
          />
          <Field
            label="Password"
            type="password"
            value={password}
            autoComplete="new-password"
            hint="At least 8 characters. There is no reset email, so keep it somewhere safe."
            onChange={(event) => setPassword(event.target.value)}
          />

          {error ? (
            <p className="setup__error" role="alert">
              {error}
            </p>
          ) : null}

          <div className="phone__actions">
            <Button type="submit" variant="primary" disabled={!ready || busy}>
              {busy ? "Creating your account" : "Create my account"}
            </Button>
            <span className="hint">
              You can sign in on your phone with the same details.
            </span>
          </div>
        </form>
      </Panel>
    </div>
  );
}

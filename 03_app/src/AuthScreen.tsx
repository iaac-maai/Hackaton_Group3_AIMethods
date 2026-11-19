
import { useState, type FormEvent } from "react";
import { authClient } from "./auth-client";

export function AuthScreen() {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const result =
        mode === "signup"
          ? await authClient.signUp.email({
              name,
              email,
              password,
            })
          : await authClient.signIn.email({
              email,
              password,
            });

      if (result.error) {
        setError(result.error.message ?? "Authentication failed.");
      }
    } catch {
      setError("Could not connect to the server.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="auth-screen">
      <section className="auth-card">
        <h1>Motion Atlas</h1>
        <p>Movement safety analysis</p>

        <h2>{mode === "login" ? "Log in" : "Create account"}</h2>

        <form onSubmit={handleSubmit}>
          {mode === "signup" && (
            <label>
              Name
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </label>
          )}

          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>

          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={8}
              required
            />
          </label>

          {error && <p role="alert">{error}</p>}

          <button type="submit" disabled={loading}>
            {loading
              ? "Please wait..."
              : mode === "login"
                ? "Log in"
                : "Sign up"}
          </button>
        </form>

        <button
          type="button"
          onClick={() => {
            setMode(mode === "login" ? "signup" : "login");
            setError("");
          }}
        >
          {mode === "login"
            ? "Don't have an account? Sign up"
            : "Already have an account? Log in"}
        </button>
      </section>
    </main>
  );
}

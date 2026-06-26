"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getCurrentUser, login } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const nextPathRef = useRef("/dashboard");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    nextPathRef.current = params.get("next") || "/dashboard";

    getCurrentUser()
      .then(() => router.replace(nextPathRef.current))
      .catch(() => undefined);
  }, [router]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    try {
      await login(username, password);
      router.replace(nextPathRef.current);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-panel">
        <div className="login-header">
          <span className="brand-mark">SOC</span>
          <div>
            <h1>SOC AI Agent</h1>
            <p>Admin authentication</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="login-form">
          <label>
            Username
            <input
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
            />
          </label>
          <label>
            Password
            <input
              autoComplete="current-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          {error ? <div className="alert error">{error}</div> : null}
          <button className="button primary full" type="submit" disabled={loading}>
            {loading ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </section>
    </main>
  );
}

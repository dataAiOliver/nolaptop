"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Spinner } from "@/components/SessionCard";

export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // No password configured means no gate: go straight through.
  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/status", { cache: "no-store" });
      const data = (await res.json()) as { authenticated?: boolean };
      if (data.authenticated) router.replace("/");
    })();
  }, [router]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const data = (await res.json()) as { error?: string };
    if (!res.ok) {
      setError(data.error ?? "Sign-in failed.");
      setBusy(false);
      return;
    }
    router.replace("/");
    router.refresh();
  }

  return (
    <div className="mx-auto mt-16 max-w-sm">
      <div className="mb-6 text-center">
        <span
          aria-hidden
          className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-[var(--accent)] text-lg font-bold text-[var(--accent-text)]"
        >
          NL
        </span>
        <h1 className="mt-4 text-[22px] font-semibold tracking-tight">NoLaptop</h1>
        <p className="mt-1 text-[14px] text-[var(--text-muted)]">Enter the app password.</p>
      </div>

      <form onSubmit={submit} className="space-y-3">
        <input
          className="field"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          autoComplete="current-password"
          autoFocus
          enterKeyHint="go"
        />
        {error ? <p className="text-[13px] text-[var(--bad-fg)]">{error}</p> : null}
        <button type="submit" className="btn btn-primary btn-lg w-full" disabled={busy || !password}>
          {busy ? <Spinner /> : null}
          Sign in
        </button>
      </form>
    </div>
  );
}

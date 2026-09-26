"use client";

import { useEffect, useState } from "react";

/**
 * Shown when the app has no secrets configured. It refuses to do anything else
 * until then, because an open instance would be a remote shell for whoever
 * finds the port.
 */
export default function SetupPage() {
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/status", { cache: "no-store" });
      const data = (await res.json()) as { setupRequired?: boolean; problem?: string };
      if (!data.setupRequired) {
        window.location.href = "/";
        return;
      }
      setProblem(data.problem ?? null);
    })();
  }, []);

  return (
    <div className="mx-auto mt-12 max-w-lg space-y-5">
      <header className="text-center">
        <span
          aria-hidden
          className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-[var(--accent)] text-lg font-bold text-[var(--accent-text)]"
        >
          NL
        </span>
        <h1 className="mt-4 text-[22px] font-semibold tracking-tight">Finish setup</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-[var(--text-muted)]">
          NoLaptop holds SSH keys for every server you add, so it will not serve anything until it
          is configured.
        </p>
      </header>

      {problem ? (
        <p className="card border-[var(--warn-fg)] p-3 text-[13px] leading-snug text-[var(--warn-fg)]">
          {problem}
        </p>
      ) : null}

      <section className="card p-4">
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-[var(--text-faint)]">
          Run this once
        </h2>
        <pre className="terminal mt-3">npm run setup</pre>
        <p className="mt-3 text-[13px] leading-snug text-[var(--text-muted)]">
          It writes a <code className="font-mono">.env</code> with a generated encryption key and a
          password, and prints the password once. Then restart the app.
        </p>
      </section>

      <section className="card p-4 text-[13px] leading-snug text-[var(--text-muted)]">
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-[var(--text-faint)]">
          Or set them yourself
        </h2>
        <dl className="mt-3 space-y-2">
          <div>
            <dt className="font-mono text-[12px] text-[var(--text)]">NL_ENCRYPTION_KEY</dt>
            <dd>32+ characters. Encrypts stored SSH keys and service credentials.</dd>
          </div>
          <div>
            <dt className="font-mono text-[12px] text-[var(--text)]">NL_APP_PASSWORD</dt>
            <dd>8+ characters. The password for this web UI.</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

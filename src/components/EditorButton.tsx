"use client";

import Link from "next/link";
import { useState } from "react";
import type { EditorLink } from "@/lib/editor";
import { VsCodeIcon } from "./SessionCard";

/**
 * "Open in VS Code", always visible.
 *
 * When the browser route is not switched on yet, the button stays and explains
 * itself instead of vanishing: a `vscode://` link can only ever open the
 * desktop app, so the difference is worth naming rather than hiding.
 */
export function EditorButton({ editor, size = "sm" }: { editor: EditorLink; size?: "sm" | "lg" }) {
  const [open, setOpen] = useState(false);
  const cls = `btn btn-secondary w-full${size === "lg" ? " btn-lg" : ""}`;

  if (editor.state === "ready" && editor.url) {
    return (
      <a
        className={cls}
        href={editor.url}
        target={editor.browser ? "_blank" : undefined}
        rel={editor.browser ? "noopener noreferrer" : undefined}
      >
        <VsCodeIcon />
        {editor.label}
        {!editor.browser ? (
          <span className="text-[11px] font-normal text-[var(--text-faint)]">desktop</span>
        ) : null}
      </a>
    );
  }

  return (
    <>
      <button className={cls} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <VsCodeIcon />
        {editor.label}
      </button>

      {open ? (
        <div className="rounded-xl border border-[var(--border-strong)] p-3">
          <p className="text-[12px] leading-snug text-[var(--text-muted)]">
            {editor.reason} Switching it on takes a one-time sign-in on the host — it is free, and
            nothing gets exposed to the network.
          </p>
          <div className="mt-2 flex flex-col gap-2">
            {editor.setupHref ? (
              <Link className="btn btn-primary w-full" href={editor.setupHref}>
                Set up VS Code for {editor.serverName}
              </Link>
            ) : null}
            {editor.desktopUrl ? (
              <a className="btn btn-ghost w-full text-[12px]" href={editor.desktopUrl}>
                Open the desktop app instead
              </a>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

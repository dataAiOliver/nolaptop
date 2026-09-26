import type { Server } from "@prisma/client";

/**
 * "Open this project in VS Code" — as a link, from wherever you are.
 *
 * There is no single right answer here, so the mode is per server:
 *
 *  - TUNNEL      `code tunnel` on the host, opened at vscode.dev. First-party
 *                Microsoft, full Marketplace, and the host makes only outbound
 *                connections — nothing has to be exposed. Needs a one-off
 *                GitHub/Microsoft sign-in on the host.
 *  - CODE_SERVER A self-hosted code-server (MIT, Coder). Fully in the browser,
 *                nothing leaves your network, extensions come from Open VSX.
 *  - DESKTOP_SSH `vscode://` deep link into desktop VS Code over Remote-SSH.
 *                Zero setup if you already use Remote-SSH, but it opens the
 *                desktop app rather than a browser tab.
 *  - CUSTOM      Any other editor with a URL, via a template.
 */

export const EDITOR_MODES = [
  "NONE",
  "TUNNEL",
  "CODE_SERVER",
  "DESKTOP_SSH",
  "CUSTOM",
] as const;

export type EditorMode = (typeof EDITOR_MODES)[number];

export const EDITOR_MODE_UI: Record<EditorMode, { label: string; hint: string; browser: boolean }> = {
  NONE: {
    label: "No editor link",
    hint: "Session cards show no VS Code button.",
    browser: false,
  },
  TUNNEL: {
    label: "VS Code tunnel (vscode.dev)",
    hint: "Opens in any browser through Microsoft's tunnel. Nothing on the host has to be exposed.",
    browser: true,
  },
  CODE_SERVER: {
    label: "code-server",
    hint: "Your own VS Code in the browser. Needs code-server running and reachable.",
    browser: true,
  },
  DESKTOP_SSH: {
    label: "Desktop VS Code over SSH",
    hint: "Opens the installed VS Code app via Remote-SSH. Works today, but not in a browser.",
    browser: false,
  },
  CUSTOM: {
    label: "Custom URL",
    hint: "Your own template. {path}, {pathEncoded} and {project} are substituted.",
    browser: true,
  },
};

export function isEditorMode(value: string): value is EditorMode {
  return (EDITOR_MODES as readonly string[]).includes(value);
}

export type EditorLink = {
  url: string;
  /** Button label, e.g. "Open in VS Code". */
  label: string;
  /** Whether the link opens a browser tab rather than a desktop app. */
  browser: boolean;
} | null;

/**
 * Encode an absolute POSIX path for use as URL *path segments*.
 *
 * The leading slash is dropped, because the tunnel URL already ends in one:
 * `https://vscode.dev/tunnel/<machine>/home/me/project`.
 */
function pathSegments(absolutePath: string): string {
  return absolutePath
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function editorLinkFor(
  server: Pick<
    Server,
    "editorMode" | "editorBaseUrl" | "editorTunnelName" | "editorSshHost" | "editorUrlTemplate" | "host"
  >,
  project: { projectPath: string; projectName: string },
): EditorLink {
  const mode: EditorMode = isEditorMode(server.editorMode) ? server.editorMode : "NONE";
  if (mode === "NONE") return null;

  switch (mode) {
    case "TUNNEL": {
      const name = server.editorTunnelName?.trim();
      if (!name) return null;
      return {
        url: `https://vscode.dev/tunnel/${encodeURIComponent(name)}/${pathSegments(project.projectPath)}`,
        label: "Open in VS Code",
        browser: true,
      };
    }

    case "CODE_SERVER": {
      const base = server.editorBaseUrl?.trim().replace(/\/+$/, "");
      if (!base) return null;
      // code-server takes ?folder= (and ?workspace=) to choose what to open.
      return {
        url: `${base}/?folder=${encodeURIComponent(project.projectPath)}`,
        label: "Open in VS Code",
        browser: true,
      };
    }

    case "DESKTOP_SSH": {
      // The alias as it appears in *your* ~/.ssh/config, which need not match
      // the address this app connects to.
      const sshHost = (server.editorSshHost?.trim() || server.host).trim();
      if (!sshHost) return null;
      return {
        url: `vscode://vscode-remote/ssh-remote+${encodeURIComponent(sshHost)}${project.projectPath}`,
        label: "Open in VS Code",
        browser: false,
      };
    }

    case "CUSTOM": {
      const template = server.editorUrlTemplate?.trim();
      if (!template) return null;
      const url = template
        .replaceAll("{pathEncoded}", encodeURIComponent(project.projectPath))
        .replaceAll("{path}", pathSegments(project.projectPath))
        .replaceAll("{project}", encodeURIComponent(project.projectName));
      return { url, label: "Open in editor", browser: true };
    }

    default:
      return null;
  }
}

/** Validation for the server form, so a broken link is rejected before saving. */
export function validateEditorConfig(input: {
  editorMode: string;
  editorBaseUrl?: string | null;
  editorTunnelName?: string | null;
  editorUrlTemplate?: string | null;
}): string | null {
  if (!isEditorMode(input.editorMode)) return "Unknown editor mode.";

  if (input.editorMode === "TUNNEL" && !input.editorTunnelName?.trim()) {
    return "A tunnel needs the machine name that `code tunnel` registered.";
  }
  if (input.editorMode === "CODE_SERVER") {
    const base = input.editorBaseUrl?.trim();
    if (!base) return "A code-server link needs its base URL.";
    try {
      const parsed = new URL(base);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return "The code-server URL has to be http or https.";
      }
    } catch {
      return "That is not a valid URL.";
    }
  }
  if (input.editorMode === "CUSTOM") {
    const template = input.editorUrlTemplate?.trim();
    if (!template) return "A custom link needs a URL template.";
    if (!/^[a-z][a-z0-9+.-]*:/i.test(template)) {
      return "The template has to start with a scheme, for example https:// or vscode://.";
    }
  }
  return null;
}

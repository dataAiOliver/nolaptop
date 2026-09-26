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

/**
 * The card always offers VS Code. When the browser route is not set up yet the
 * button is still there — it explains what is missing and points at the switch,
 * which is more useful than a button that quietly does not exist.
 */
export type EditorLink = {
  /** "ready" — there is a URL. "setup" — it has to be switched on first. */
  state: "ready" | "setup";
  label: string;
  url: string | null;
  /** True when the URL opens a browser tab rather than the desktop app. */
  browser: boolean;
  /** For "setup": what is missing, in one sentence. */
  reason: string | null;
  /** For "setup": where to switch it on. */
  setupHref: string | null;
  /** A desktop fallback, offered alongside the hint when one is possible. */
  desktopUrl: string | null;
  serverName: string;
};

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

function desktopSshUrl(
  server: Pick<Server, "editorSshHost" | "host">,
  projectPath: string,
): string | null {
  // The alias as it appears in *your* ~/.ssh/config, which need not match the
  // address this app connects with.
  const sshHost = (server.editorSshHost?.trim() || server.host).trim();
  if (!sshHost) return null;
  return `vscode://vscode-remote/ssh-remote+${encodeURIComponent(sshHost)}${projectPath}`;
}

export function editorLinkFor(
  server: Pick<
    Server,
    | "id"
    | "name"
    | "editorMode"
    | "editorBaseUrl"
    | "editorTunnelName"
    | "editorSshHost"
    | "editorUrlTemplate"
    | "host"
  >,
  project: { projectPath: string; projectName: string },
): EditorLink {
  const mode: EditorMode = isEditorMode(server.editorMode) ? server.editorMode : "NONE";
  const desktopUrl = desktopSshUrl(server, project.projectPath);

  const setup = (reason: string): EditorLink => ({
    state: "setup",
    label: "Open in VS Code",
    url: null,
    browser: true,
    reason,
    setupHref: `/servers?vscode=${encodeURIComponent(server.id)}`,
    desktopUrl,
    serverName: server.name,
  });

  const ready = (url: string, browser: boolean): EditorLink => ({
    state: "ready",
    label: "Open in VS Code",
    url,
    browser,
    reason: null,
    setupHref: null,
    desktopUrl,
    serverName: server.name,
  });

  switch (mode) {
    case "TUNNEL": {
      const name = server.editorTunnelName?.trim();
      if (!name) return setup(`The VS Code tunnel on ${server.name} has not been started yet.`);
      return ready(
        `https://vscode.dev/tunnel/${encodeURIComponent(name)}/${pathSegments(project.projectPath)}`,
        true,
      );
    }

    case "CODE_SERVER": {
      const base = server.editorBaseUrl?.trim().replace(/\/+$/, "");
      if (!base) return setup(`code-server on ${server.name} has no address configured.`);
      // code-server takes ?folder= (and ?workspace=) to choose what to open.
      return ready(`${base}/?folder=${encodeURIComponent(project.projectPath)}`, true);
    }

    case "CUSTOM": {
      const template = server.editorUrlTemplate?.trim();
      if (!template) return setup(`${server.name} has no editor URL template.`);
      return ready(
        template
          .replaceAll("{pathEncoded}", encodeURIComponent(project.projectPath))
          .replaceAll("{path}", pathSegments(project.projectPath))
          .replaceAll("{project}", encodeURIComponent(project.projectName)),
        true,
      );
    }

    case "DESKTOP_SSH":
      // Configured on purpose, so honour it — but say that the browser route
      // exists, because a vscode:// link cannot open in a browser by design.
      return desktopUrl
        ? { ...ready(desktopUrl, false), state: "ready" }
        : setup(`${server.name} has no SSH host for the desktop link.`);

    default:
      return setup(`VS Code in the browser is not set up for ${server.name} yet.`);
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

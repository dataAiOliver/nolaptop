import path from "node:path";

/**
 * Everything that crosses into a remote shell goes through here.
 *
 * The rule for this app: no string coming from a client ever reaches a shell
 * un-quoted, and no path is accepted from a client at all — paths are always
 * *derived* on the server from a stored project root plus a validated slug.
 */

/** Wrap a value in single quotes, POSIX-safely, so the shell treats it as one literal word. */
export function sq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Project/session names: lowercase slug, no dots, no slashes, no leading dash. */
const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;

export function isValidProjectName(name: string): boolean {
  if (!PROJECT_NAME_RE.test(name)) return false;
  // Reject anything that could walk the tree or hide a path.
  if (name.includes("..")) return false;
  if (name === "." || name === "..") return false;
  return true;
}

export function normalizeProjectName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+/g, "-")
    .replace(/-$/, "")
    .slice(0, 63);
}

/** An absolute, normalised POSIX path with no trailing slash and no traversal. */
export function isSafeAbsolutePath(p: string): boolean {
  if (!p.startsWith("/")) return false;
  if (p.includes("\0")) return false;
  const normalized = path.posix.normalize(p);
  if (normalized !== p.replace(/\/+$/, "") && normalized !== p) return false;
  if (normalized.split("/").includes("..")) return false;
  return true;
}

export function normalizeRoot(p: string): string {
  const normalized = path.posix.normalize(p.trim());
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

/**
 * Join a validated project name onto a project root and prove the result is
 * still inside that root. Belt and braces: the name is already slug-checked,
 * this catches any future caller that forgets.
 */
export function projectPathWithin(projectRoot: string, projectName: string): string {
  if (!isValidProjectName(projectName)) {
    throw new Error(`Invalid project name: ${projectName}`);
  }
  const root = normalizeRoot(projectRoot);
  if (!isSafeAbsolutePath(root)) {
    throw new Error(`Project root must be an absolute path without traversal: ${projectRoot}`);
  }
  const full = path.posix.normalize(path.posix.join(root, projectName));
  if (full !== `${root}/${projectName}`) {
    throw new Error(`Refusing to resolve ${projectName} outside of ${root}`);
  }
  return full;
}

/**
 * tmux session name: unique per managed session, reproducible, and free of the
 * characters tmux treats specially (":" and "." address windows and panes).
 */
export function tmuxSessionName(projectName: string, sessionId: string): string {
  const slug = projectName.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 32);
  return `cc-${slug}-${sessionId.slice(-8)}`;
}

/** A second session per project, for the template's long-running app. */
export function appTmuxSessionName(projectName: string, sessionId: string): string {
  const slug = projectName.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 28);
  return `cc-${slug}-${sessionId.slice(-8)}-app`;
}

export function isValidTmuxName(name: string): boolean {
  return /^cc-[a-zA-Z0-9_-]{1,48}$/.test(name);
}

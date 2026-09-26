import type { Resource, ResourceAllocation, Server, Session, SessionLink } from "@prisma/client";

/**
 * "I am at my laptop now" — the command that makes a project's ports local.
 *
 * Everything NoLaptop starts on a server binds to that server's loopback: the
 * dev server, the shared database, the object store. That is the right default,
 * and it means you cannot just type the server's address into a browser.
 *
 * So the app hands you the one command that fixes it — an SSH tunnel with every
 * port this project actually uses, ready to paste. No guessing which ports
 * matter, no remembering the `-L` syntax.
 */

export type ForwardedPort = {
  port: number;
  /** Local port, which differs only when the obvious one is taken by convention. */
  localPort: number;
  label: string;
  /** Where it lands in a browser once the tunnel is up, when that makes sense. */
  localUrl: string | null;
};

export type ForwardPlan = {
  ports: ForwardedPort[];
  /** `user@host`, or your own SSH alias when one is configured. */
  target: string;
  sshPort: number;
  commands: {
    bash: string;
    bashBackground: string;
    powershell: string;
    powershellBackground: string;
  };
  /** Links that are not ports and so are not forwarded. */
  plainLinks: { label: string; url: string }[];
};

type SessionForForward = Session & {
  server: Server;
  links?: SessionLink[];
  allocations?: (ResourceAllocation & { resource: Resource })[];
};

function httpUrl(port: number): string {
  return `http://localhost:${port}`;
}

export function buildForwardPlan(session: SessionForForward): ForwardPlan {
  const ports: ForwardedPort[] = [];
  const seen = new Set<number>();

  const add = (port: number | null | undefined, label: string, web: boolean) => {
    if (!port || !Number.isInteger(port) || seen.has(port)) return;
    seen.add(port);
    ports.push({ port, localPort: port, label, localUrl: web ? httpUrl(port) : null });
  };

  add(session.devPort, "Dev server", true);

  for (const link of session.links ?? []) {
    if (link.port) add(link.port, link.label, true);
  }

  // The project's own database and bucket, so a local client can reach them too.
  for (const allocation of session.allocations ?? []) {
    if (allocation.state !== "READY") continue;
    let meta: Record<string, unknown> = {};
    try {
      meta = allocation.metaJson ? (JSON.parse(allocation.metaJson) as Record<string, unknown>) : {};
    } catch {
      meta = {};
    }
    if (allocation.resource.kind === "POSTGRES") {
      add(Number(meta.port), `PostgreSQL · ${allocation.namespace}`, false);
    } else {
      const endpoint = typeof meta.endpoint === "string" ? meta.endpoint : "";
      const port = endpoint ? Number(new URL(endpoint).port) : NaN;
      add(port, `Object storage · ${allocation.namespace}`, false);
    }
  }

  const server = session.server;
  // Your own alias from ~/.ssh/config wins: it may use a different address,
  // a jump host or a different key than the one NoLaptop connects with.
  const alias = server.editorSshHost?.trim();
  const target = alias || `${server.username}@${server.host}`;
  const portFlag = !alias && server.port !== 22 ? ` -p ${server.port}` : "";

  const forwards = ports.map((p) => `-L ${p.localPort}:127.0.0.1:${p.port}`).join(" ");
  const base = forwards ? `ssh -N${portFlag} ${forwards} ${target}` : "";

  const plainLinks = (session.links ?? [])
    .filter((l) => !l.port && l.url)
    .map((l) => ({ label: l.label, url: l.url as string }));

  return {
    ports,
    target,
    sshPort: server.port,
    plainLinks,
    commands: {
      bash: base,
      // -f backgrounds it, but only after authentication succeeded, so a wrong
      // key still fails visibly instead of silently.
      bashBackground: base ? base.replace("ssh -N", "ssh -f -N") : "",
      powershell: base,
      powershellBackground: base
        ? `Start-Process ssh -ArgumentList '-N${portFlag} ${forwards} ${target}' -WindowStyle Hidden`
        : "",
    },
  };
}

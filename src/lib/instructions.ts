import type { Resource, ResourceAllocation, Server, Session } from "@prisma/client";
import { prisma } from "./db";
import { writeProjectFile } from "./remote/ops";
import { toAllocationView } from "./resources";
import { logEvent } from "./sessions";

/**
 * The instructions file every project gets — the thing that stops you having to
 * explain the same environment to the agent over and over.
 *
 * `AGENTS.md` is the default on purpose. Claude Code reads it natively, and so
 * do Codex, Cursor and the Gemini CLI, so one file covers every agent. The
 * catch worth knowing: if a project also has a `CLAUDE.md`, Claude Code uses
 * that one and ignores `AGENTS.md` entirely. So this writes exactly one file,
 * and warns when the other is present.
 */

/** Everything below this line survives regeneration. */
export const KEEP_MARKER = "<!-- your own notes below this line — kept when this file is regenerated -->";

export const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
export type InstructionFileName = (typeof INSTRUCTION_FILES)[number];

export function otherInstructionFile(name: string): InstructionFileName {
  return name === "CLAUDE.md" ? "AGENTS.md" : "CLAUDE.md";
}

type AllocationWithResource = ResourceAllocation & { resource: Resource };

export function renderInstructions(input: {
  server: Server;
  session: Session;
  allocations: AllocationWithResource[];
  preserved: string;
}): string {
  const { server, session, allocations, preserved } = input;
  const lines: string[] = [];

  lines.push(`# ${session.projectName}`);
  lines.push("");
  lines.push(
    "Written by NoLaptop when this project was created. It describes the environment",
    "you are running in — things you cannot see by reading the code.",
    "",
  );

  // --- where you are -------------------------------------------------------
  lines.push("## Environment");
  lines.push("");
  lines.push(`- Host: \`${server.name}\` (${server.host})`);
  lines.push(`- Project directory: \`${session.projectPath}\``);
  lines.push(
    "- This machine is shared with other projects. Anything outside this directory",
    "  belongs to someone else — do not change it.",
  );
  if (session.devPort) {
    lines.push(
      `- **Dev server port: ${session.devPort}** (also in \`.env\` as \`PORT\`). It is reserved`,
      "  for this project. Use it instead of picking a port, so two projects never collide.",
    );
  }
  lines.push(
    "- This session runs inside tmux and is managed from outside. Do not kill it,",
    "  and do not start a second Claude Code in this directory.",
    "",
  );

  // --- what it can talk to -------------------------------------------------
  const ready = allocations.filter((a) => a.state === "READY");
  if (ready.length > 0) {
    lines.push("## Backing services");
    lines.push("");
    lines.push(
      "Reserved for this project alone. Credentials are in `.env` — read them from the",
      "environment, never hard-code them, and never commit that file.",
      "",
    );

    for (const allocation of ready) {
      const view = toAllocationView(allocation);
      if (allocation.resource.kind === "POSTGRES") {
        lines.push("### PostgreSQL");
        lines.push("");
        lines.push(`- Database \`${allocation.namespace}\`, user \`${allocation.username}\``);
        lines.push(`- Reachable at \`${view.meta.host}:${view.meta.port}\` from this machine`);
        lines.push("- Connection string: `process.env.DATABASE_URL` (also `PG*` variables)");
        lines.push(
          "- This database is yours. Other projects have their own `proj_*` databases",
          "  on the same server — do not connect to them.",
          "",
        );
      } else {
        lines.push("### Object storage (S3-compatible)");
        lines.push("");
        lines.push(`- Bucket \`${view.meta.bucket}\`${view.meta.prefix ? `, prefix \`${view.meta.prefix}\`` : ""}`);
        lines.push(`- Endpoint \`${view.meta.endpoint}\`, region \`${view.meta.region}\``);
        lines.push(
          "- Credentials: `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` (the AWS SDK also",
          "  picks up the `AWS_*` aliases). Use path-style addressing.",
          "- The bucket is yours; the key is shared with the store. Stay in your bucket.",
          "",
        );
      }
    }
  } else {
    lines.push("## Backing services");
    lines.push("");
    lines.push(
      "None attached. If this project needs a database or object storage, say so —",
      "they can be added from the NoLaptop dashboard rather than installed by hand.",
      "",
    );
  }

  // --- the operator's own rules -------------------------------------------
  const preamble = server.agentsPreamble?.trim();
  if (preamble) {
    lines.push("## Project conventions");
    lines.push("");
    lines.push(preamble);
    lines.push("");
  }

  lines.push(KEEP_MARKER);
  lines.push("");
  if (preserved.trim()) lines.push(preserved.trim(), "");

  return lines.join("\n");
}

export type InstructionSyncResult = {
  fileName: string;
  path: string;
  /** Set when the other convention's file exists and would take precedence. */
  shadowWarning: string | null;
};

/**
 * Write (or rewrite) the instructions file in the project directory, keeping
 * anything the user added below the marker.
 */
export async function syncInstructions(
  server: Server,
  session: Session,
): Promise<InstructionSyncResult> {
  const fileName = (server.agentsFileName as InstructionFileName) ?? "AGENTS.md";
  const other = otherInstructionFile(fileName);

  const allocations = await prisma.resourceAllocation.findMany({
    where: { sessionId: session.id },
    include: { resource: true },
    orderBy: { createdAt: "asc" },
  });

  const { readProjectFile } = await import("./remote/ops");

  let preserved = "";
  try {
    const current = await readProjectFile(server, session.projectPath, fileName);
    if (current) {
      const index = current.indexOf(KEEP_MARKER);
      preserved = index >= 0 ? current.slice(index + KEEP_MARKER.length) : "";
    }
  } catch {
    preserved = "";
  }

  const content = renderInstructions({ server, session, allocations, preserved });
  await writeProjectFile(server, session.projectPath, fileName, content);

  // Claude Code reads only one of the two. Say so rather than letting the
  // carefully written context be silently ignored.
  let shadowWarning: string | null = null;
  try {
    const rival = await readProjectFile(server, session.projectPath, other);
    if (rival) {
      shadowWarning =
        other === "CLAUDE.md"
          ? `This project also has a CLAUDE.md. Claude Code prefers it and will ignore ${fileName}. Remove one of them.`
          : `This project also has an AGENTS.md, which Claude Code will ignore while ${fileName} exists.`;
    }
  } catch {
    shadowWarning = null;
  }

  await logEvent(
    session.id,
    "action",
    shadowWarning ? `Wrote ${fileName}. ${shadowWarning}` : `Wrote ${fileName}.`,
  );

  return { fileName, path: `${session.projectPath}/${fileName}`, shadowWarning };
}

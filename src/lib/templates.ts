/**
 * Starter templates — the "what do I get" behind the Launch button.
 *
 * A template is a fixed set of files plus, optionally, a fixed command to
 * install and run them. Both are defined here in code: the client picks a
 * template by id, never by handing over files or a command line.
 *
 * The files are deliberately tiny and dependency-light. The point is not to be
 * a scaffolding tool — it is that the project is *already running* when you
 * open it, so the agent has something real to change.
 */

export type TemplateFile = { path: string; content: string; executable?: boolean };

export type Template = {
  id: string;
  label: string;
  /** One line, shown under the option in the New Project screen. */
  summary: string;
  /** Whether this template expects a database and object storage. */
  needsServices: boolean;
  files: (ctx: TemplateContext) => TemplateFile[];
  /** Fixed command, run once in the project directory. */
  install?: string;
  /** Fixed command, left running in its own tmux window. */
  start?: string;
};

export type TemplateContext = {
  projectName: string;
  devPort: number | null;
};

const PORT = (ctx: TemplateContext) => ctx.devPort ?? 3000;

// --------------------------------------------------------------------- blank

const blank: Template = {
  id: "blank",
  label: "Empty project",
  summary: "Just the folder. The agent starts from nothing.",
  needsServices: false,
  files: () => [],
};

// ---------------------------------------------------------------- node-basic

const nodeBasic: Template = {
  id: "node-basic",
  label: "Node web app",
  summary: "A running HTTP server on your reserved port. No dependencies.",
  needsServices: false,
  install: undefined,
  start: "node --env-file=.env server.mjs",
  files: (ctx) => [
    {
      path: "server.mjs",
      content: `import http from "node:http";

// The port is reserved for this project — see AGENTS.md.
const port = Number(process.env.PORT ?? ${PORT(ctx)});

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(\`<!doctype html>
<meta charset="utf-8">
<title>${ctx.projectName}</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 34rem; margin: 15vh auto; padding: 0 1.5rem; }
  code { background: #eee; padding: .1rem .35rem; border-radius: .25rem; }
</style>
<h1>${ctx.projectName}</h1>
<p>This project is running on port <code>\${port}</code>.</p>
<p>It was created by NoLaptop. Ask the agent to change something.</p>\`);
});

server.listen(port, () => console.log(\`${ctx.projectName} listening on \${port}\`));
`,
    },
    {
      path: "package.json",
      content: JSON.stringify(
        {
          name: ctx.projectName,
          private: true,
          type: "module",
          scripts: {
            start: "node --env-file=.env server.mjs",
            dev: "node --env-file=.env --watch server.mjs",
          },
        },
        null,
        2,
      ) + "\n",
    },
  ],
};

// ------------------------------------------------------------- node-services

const nodeServices: Template = {
  id: "node-services",
  label: "Node app with database and storage",
  summary: "Reads and writes its own PostgreSQL database and S3 bucket, out of the box.",
  needsServices: true,
  install: "npm install",
  start: "node --env-file=.env server.mjs",
  files: (ctx) => [
    {
      path: "server.mjs",
      content: `import http from "node:http";
import crypto from "node:crypto";
import pg from "pg";
import {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";

/*
 * Everything below reads its configuration from .env, which NoLaptop wrote.
 * Nothing is hard-coded: the database and the bucket belong to this project.
 */

const port = Number(process.env.PORT ?? ${PORT(ctx)});

if (!process.env.DATABASE_URL || !process.env.S3_BUCKET) {
  console.error(
    "DATABASE_URL or S3_BUCKET is missing. This app is started with",
    "\`node --env-file=.env server.mjs\` so it picks up the file NoLaptop wrote.",
  );
  process.exit(1);
}

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION ?? "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});
const bucket = process.env.S3_BUCKET;

await db.query(\`
  CREATE TABLE IF NOT EXISTS visits (
    id    bigserial PRIMARY KEY,
    at    timestamptz NOT NULL DEFAULT now(),
    note  text
  )
\`);

try {
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
} catch {
  // Already there — NoLaptop created it when the project was set up.
}

const server = http.createServer(async (req, res) => {
  try {
    const { rows } = await db.query(
      "INSERT INTO visits (note) VALUES ($1) RETURNING id, at",
      [\`hit from \${req.socket.remoteAddress ?? "somewhere"}\`],
    );
    const visit = rows[0];

    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: \`visits/\${visit.id}-\${crypto.randomUUID()}.json\`,
        Body: JSON.stringify(visit),
        ContentType: "application/json",
      }),
    );

    const [{ rows: counted }, stored] = await Promise.all([
      db.query("SELECT count(*)::int AS n FROM visits"),
      s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: "visits/" })),
    ]);

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(\`<!doctype html>
<meta charset="utf-8">
<title>${ctx.projectName}</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 34rem; margin: 12vh auto; padding: 0 1.5rem; }
  dt { color: #666; font-size: .85rem; } dd { margin: 0 0 .75rem; font-weight: 600; }
  code { background: #eee; padding: .1rem .35rem; border-radius: .25rem; }
</style>
<h1>${ctx.projectName}</h1>
<p>Every page load writes a row to PostgreSQL and an object to S3.</p>
<dl>
  <dt>Rows in <code>visits</code></dt><dd>\${counted[0].n}</dd>
  <dt>Objects in <code>\${bucket}</code></dt><dd>\${stored.KeyCount ?? 0}</dd>
  <dt>Database</dt><dd><code>\${process.env.PGDATABASE}</code></dd>
  <dt>Port</dt><dd><code>\${port}</code></dd>
</dl>
<p>Reload to watch both numbers go up.</p>\`);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Something went wrong:\\n\\n" + String(err));
  }
});

server.listen(port, () => console.log(\`${ctx.projectName} listening on \${port}\`));
`,
    },
    {
      path: "package.json",
      content: JSON.stringify(
        {
          name: ctx.projectName,
          private: true,
          type: "module",
          scripts: {
            start: "node --env-file=.env server.mjs",
            dev: "node --env-file=.env --watch server.mjs",
          },
          dependencies: { pg: "^8.13.0", "@aws-sdk/client-s3": "^3.700.0" },
        },
        null,
        2,
      ) + "\n",
    },
  ],
};

export const TEMPLATES: Template[] = [blank, nodeBasic, nodeServices];

export function templateById(id: string | null | undefined): Template {
  return TEMPLATES.find((t) => t.id === id) ?? blank;
}

export const TEMPLATE_IDS = TEMPLATES.map((t) => t.id);

/** Relative paths a template may write. Keeps a template honest. */
export function isSafeRelativePath(p: string): boolean {
  if (!p || p.startsWith("/") || p.includes("\0")) return false;
  if (p.includes("..")) return false;
  if (p.split("/").length > 4) return false;
  return /^[A-Za-z0-9._/-]+$/.test(p);
}

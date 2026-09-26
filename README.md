# NoLaptop

**Start a coding agent on any of your servers — from your phone.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-20%2B-brightgreen.svg)](https://nodejs.org)
[![Self-hosted](https://img.shields.io/badge/self--hosted-yes-orange.svg)](#install)

I run most of my coding agents on remote servers. Every time I had an idea, I still had to:

```
open the laptop
ssh dev
cd ~/projects
mkdir idea-37
cd idea-37
tmux new -s idea-37
claude
/remote-control
copy the link
```

So I built a button.

Now it is: pick a server, type a name, tap **Launch**. A few seconds later the project
exists, its database and bucket exist, a starter app is already serving on a reserved
port, and Claude Code is running with Remote Control on — ready to open from the phone
that started it.

Which means questionable side projects can now begin on the bus.

---

## What it actually does

Type a name, tap Launch, and on the server you get:

```
~/projects/my-idea
├── .env              database URL, S3 credentials, reserved port
├── AGENTS.md         what this project is, what it can talk to
├── server.mjs        a starter app, already running
└── tmux
    ├── my-idea       Claude Code + Remote Control
    └── my-idea-app   your app on its own port
```

Plus, in the dashboard: a live status for every session, one button to open it in
Claude, one to open it in VS Code, and honest answers when something needs you.

## Not just another session dashboard

There are several good tmux-and-Claude dashboards. The difference here is what happens
*before* the agent starts:

| | Most dashboards | NoLaptop |
| --- | --- | --- |
| Where it runs | your laptop | any number of remote servers, over SSH |
| Sessions | watches existing ones | creates them |
| Environment | you set it up | database, bucket, port and instructions, generated |
| Phone | responsive | designed for it first; installable PWA |

## Features

- **Servers** — several hosts, each with SSH details and one project root.
  Reachability, `claude` version, `tmux` and sign-in state are probed on a schedule.
- **One-tap projects** — folder, tmux session, Claude Code with Remote Control,
  starter template, all from a name.
- **Optional shared services** — enable PostgreSQL and S3-compatible storage per
  server, in one click. Each project then gets *its own* database and bucket.
- **`AGENTS.md` generated for you** — the agent knows its database, bucket, port and
  host without being told.
- **Reserved dev port per project** — two agents on one box never fight over 3000.
- **Real status** — never "the database says it is running". Every check reads `tmux`,
  the live Claude process and the Remote Control bridge on the host.
- **Login and approvals from the browser** — when Claude wants a sign-in or is blocked
  on a terminal prompt, the dashboard says so and offers the action.
- **Reconnect without losing the conversation** — a dropped Remote Control is restored
  with `/remote-control`; a stopped session comes back with `--resume`.
- **Per-project notes, ports and links** — plus a copy-paste `ssh -L` command,
  for bash and PowerShell, that makes those ports local when you sit down at a
  laptop.
- **Open in VS Code** — an optional one-time setup per server turns on
  Microsoft's tunnel, and every session then opens at vscode.dev.
- **Usage** — token counts read from Claude Code's own transcript. Nothing estimated.

## Install

You need Node 20+ on the machine running NoLaptop, and on every server you manage:
`tmux`, the `claude` CLI, and an SSH account with a key. Claude must already be signed
in there (`claude auth login`) — NoLaptop never handles Anthropic credentials itself.

```bash
git clone https://github.com/YOUR-NAME/nolaptop.git
cd nolaptop
make check      # tells you what is missing, changes nothing
make install    # dependencies, generated secrets, database
make dev        # http://localhost:4400
```

`make install` prints your generated password once. It is also in `.env`.

<details>
<summary>With Docker instead</summary>

```bash
cp .env.example .env
npm run setup          # generates the two secrets into .env
docker compose up -d
```

</details>

### Try it without thinking

With a server added and online:

```bash
make demo        # creates two example projects and tells you what happened
make demo-clean  # removes them again, including their database and bucket
```

One is a plain Node app. The other gets its own PostgreSQL database and S3 bucket and
writes to both on every page load — the point being that you did not configure any of
it.

## Configuration

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | SQLite file. Default `file:./data/nolaptop.db`. |
| `NL_ENCRYPTION_KEY` | **Required**, 32+ chars. Encrypts SSH keys and service credentials (AES-256-GCM). |
| `NL_APP_PASSWORD` | **Required**, 8+ chars. The UI password. |
| `NL_MONITOR_INTERVAL_MS` | Health-check interval, default 15000. |
| `NL_POSTGRES_IMAGE` / `NL_S3_IMAGE` | Override the shared-service images. |

Both required values are generated by `npm run setup`. **NoLaptop refuses to serve
without them** — it holds SSH keys for your servers, and an open instance of that is a
remote shell for whoever finds the port.

## Publishing it

NoLaptop binds to localhost and speaks plain HTTP. Do not expose that directly —
it holds SSH keys to your servers.

**On a private network (simplest).** Put the machine on Tailscale or WireGuard and open
`http://<private-ip>:4400`. Nothing is published, no certificate needed, and your phone
just works. This is what I use.

**On a hostname with TLS.** There is a command for it:

```bash
make deploy
```

It needs four things in `.env`, and nothing about your setup is ever committed:

```bash
NL_PUBLIC_HOSTNAME="nolaptop.example.com"
NL_PROXY="traefik"              # traefik | caddy | none
NL_TRAEFIK_NETWORK="proxy"      # only for NL_PROXY=traefik
NL_TRAEFIK_CERTRESOLVER="letsencrypt"
```

Before running it, point an **A record** at the machine:

```
nolaptop   A   203.0.113.10     ← your server's public IP
```

Check it arrived with `dig +short nolaptop.example.com`. Then `make deploy` will:

1. verify the hostname resolves to *this* machine, and say so if it does not,
2. check that your proxy's Docker network exists,
3. build the image and start the container behind the proxy,
4. wait until `https://your-host/api/status` answers, so you know it really worked.

`make deploy-stop` takes it down again.

### Which proxy

| `NL_PROXY` | For | What happens |
| --- | --- | --- |
| `traefik` | you already run Traefik with Docker discovery | labels are added, the container joins your proxy network, no host port is published |
| `caddy` | a machine with nothing in front yet | a Caddy container comes along and gets the certificate itself; ports 80 and 443 must be free |
| `none` | you will wire up your own proxy | stays on `127.0.0.1:4400` |

If you bring your own proxy, the one thing to get right is the live-update stream:
`/api/events` is Server-Sent Events, so disable response buffering. In nginx that is
`proxy_buffering off;` with `proxy_read_timeout 1h;`. Caddy needs `flush_interval -1`.
The bundled configurations already do this.

## Shared services

Off by default. On a server's card, **Enable** starts one container on that host:

- **PostgreSQL** (`postgres:18-alpine`) — each project gets its own database
  `proj_<name>` with its own owning role. Real isolation, one instance.
- **Object storage** (`chrislusf/seaweedfs`) — each project gets its own bucket
  `proj-<name>`.

Both bind to that host's **localhost** and are reached through the SSH connection
NoLaptop already has. Nothing is published to the network. A database with a generated
password on an open VPS port is how these stories usually end.

Credentials land in the project's `.env` and are described in its `AGENTS.md`, so the
agent finds them without being told.

### VS Code in the browser

Also off by default, and on the same card. Nothing to buy, but three things have to
exist on the server, so NoLaptop walks you through them and shows the output of each:

1. the VS Code CLI (downloaded if the host has none),
2. a one-time sign-in with GitHub or Microsoft — NoLaptop shows the device code and
   the link, and never sees your credentials,
3. a tunnel process, kept in its own tmux session.

After that, every session card on that host gets an **Open in VS Code** button that
opens the project at `vscode.dev`. The server only makes outbound connections; nothing
is exposed. If you would rather run code-server, or open the desktop app over
Remote-SSH, both are options in the server settings.

## Working from a laptop

Ports on a server's localhost are not reachable from your machine — which is the point,
but inconvenient when you actually sit down at a laptop. Each project's page therefore
shows the exact command:

```bash
ssh -N -L 3101:127.0.0.1:3101 -L 5433:127.0.0.1:5433 -L 8333:127.0.0.1:8333 you@server
```

It covers the project's dev port, any port you saved on it, and its own database and
bucket — so a local `psql` or S3 client reaches them too. There is a Windows variant
next to it, and a background variant for both. Windows 10 and 11 ship the `ssh` client,
so it is the same command.

### Why SeaweedFS and not MinIO

MinIO is the obvious choice and it is not the one here, for two reasons.

The practical one: MinIO closed anonymous pulls of `minio/minio`. A default that fails
on a fresh host is not a default.

The real one: MinIO moved its community edition behind AGPL and has been steadily
shifting capability into its commercial product.
[SeaweedFS](https://github.com/seaweedfs/seaweedfs) is Apache-2.0, actively maintained,
and speaks the S3 API surface this app uses — ListBuckets, HeadBucket, CreateBucket,
PutObject, SigV4. For a tool whose whole point is that you own the machine, the object
store should be one you get to keep.

If you prefer something else, set `NL_S3_IMAGE`. Anything S3-compatible works: the code
uses plain S3 verbs and signs them itself, with no vendor SDK.

## `AGENTS.md`, not `CLAUDE.md`

Each project gets one generated instructions file. The default is `AGENTS.md`, and the
reason is worth knowing:

- Claude Code reads `AGENTS.md` natively — and so do Codex, Cursor and the Gemini CLI.
- If a project has **both**, Claude Code uses `CLAUDE.md` and ignores `AGENTS.md`
  entirely.

So `AGENTS.md` covers every agent, `CLAUDE.md` covers one, and keeping both is a quiet
way to lose your context. NoLaptop writes exactly one and warns if the other appears.
The filename is switchable per server.

Anything you write below the marker in that file survives regeneration.

## How the status is determined

Claude Code keeps machine-readable state, so almost none of this is screen scraping:

| Question | Source |
| --- | --- |
| Which Claude processes are running? | `claude agents --json` |
| Is Remote Control on, and what is the link? | `~/.claude/sessions/<pid>.json` → `bridgeSessionId`; the URL is `https://claude.ai/code/<bridgeSessionId>` |
| Is the session signed in? | `claude auth status --json` |
| Token usage | `~/.claude/projects/<dir>/<session>.jsonl` |
| Is a dialog blocking the session? | `tmux capture-pane`, only when the structured sources say something is off |

A session with no `bridgeSessionId` genuinely has no Remote Control. Anything that
cannot be determined reliably is shown as **Not available** — cost is one of those, so
no number is invented.

### Session states

`STARTING` · `RUNNING` · `REMOTE_CONNECTED` · `REMOTE_DISCONNECTED` · `AUTH_REQUIRED` ·
`APPROVAL_REQUIRED` · `STOPPED` · `ERROR` · `SERVER_OFFLINE`

## Safety

This app holds SSH keys to your servers, so the boring parts matter:

- **No "run arbitrary command" API.** `src/lib/remote/ops.ts` and
  `src/lib/remote/stack.ts` are the complete set of operations that can reach a server.
  Every interpolated value is single-quoted; container images, names and arguments are
  constants.
- **Project paths are never accepted from a client.** They are derived from the
  server's stored project root plus a slug-validated name, and re-checked to be inside
  that root.
- **Only known files** may be written into a project: `.env`, the instructions file,
  and a template's own fixed file list.
- **Terminal input is restricted** to a short list of named keys, or one line of text
  sent literally.
- **One dialog is auto-answered** — the workspace-trust prompt for a directory
  NoLaptop just created. Anything touching authentication or remote access is handed
  to you.
- **SSH host keys are pinned** on first connection; a changed key is refused, not
  silently trusted.
- **Secrets are encrypted at rest** and never returned to the browser. Project
  credentials are sent only when you explicitly reveal them.
- **Nothing is destroyed implicitly.** Removing a project leaves the folder, the
  conversation, the database and the bucket alone. Dropping data takes an explicit
  request and two confirmations.

## Project layout

```
src/lib/
  ssh.ts               pooled SSH connections, host-key pinning
  tunnel.ts            port forwarding for services bound to a server's localhost
  remote/ops.ts        the whitelisted remote operations
  remote/stack.ts      starting the optional shared services
  claude/adapter.ts    everything Claude-CLI-specific lives here
  claude/state.ts      session states
  claude/interrupts.ts recognising blocking terminal dialogs
  resources/           per-project databases and buckets
  instructions.ts      the generated AGENTS.md
  templates.ts         starter projects
  sessions.ts          orchestration and state transitions
  monitor.ts           the background health loop
```

When the Claude CLI changes, `src/lib/claude/adapter.ts` is the file to fix. Adding
another agent (Codex, Gemini CLI) means a sibling of that file, not a rewrite.

## Development

```bash
make dev
make typecheck
npx prisma db push              # after editing prisma/schema.prisma
python3 scripts/make-icons.py   # regenerate PWA icons
```

## Contributing

Issues and pull requests are welcome — especially:

- **another agent**: the Claude-specific parts are behind `src/lib/claude/adapter.ts`,
  so Codex or the Gemini CLI would be a sibling of that file, not a rewrite;
- **another starter template** in `src/lib/templates.ts`;
- **another proxy** for `make deploy`.

Before opening a pull request:

```bash
make typecheck
make build
```

If you change anything that talks to a server, please say in the pull request how you
tested it against a real host. This project is full of things that look right and are
not, and most of the bugs found so far came from actually running it rather than from
reading it.

## Support and contact

- **Bug or idea** → open an issue.
- **Anything else, including commercial enquiries** → **data.ai.oliver@gmail.com**

If you are reporting a problem, the two most useful things are the session state shown
in the dashboard and the output of `make check`. Please do not paste `.env`, SSH keys,
or the contents of a project's `.env` into an issue.

### Security

If you find a security issue, please email **data.ai.oliver@gmail.com** rather than
opening a public issue, and give me a reasonable window to fix it before disclosing.
The areas most worth looking at are `src/lib/remote/ops.ts`, `src/lib/remote/stack.ts`
and `src/lib/shell.ts` — everything that reaches a server goes through those.

## Built with

[Next.js](https://nextjs.org) · [Prisma](https://prisma.io) · [Tailwind CSS](https://tailwindcss.com) ·
[ssh2](https://github.com/mscdex/ssh2) · [SeaweedFS](https://github.com/seaweedfs/seaweedfs) ·
[PostgreSQL](https://www.postgresql.org)

It orchestrates [Claude Code](https://claude.com/claude-code), which is Anthropic's, not
mine. NoLaptop is not affiliated with or endorsed by Anthropic.

## License

MIT — see [LICENSE](LICENSE). Do what you like with it.

# Contributing to NoLaptop

Thanks for looking. This is a small, opinionated tool; the bar for changes is that they
keep it small and opinionated.

## Getting set up

```bash
make check      # tells you what is missing, changes nothing
make install    # dependencies, generated secrets, database
make dev
```

You need a server to point it at: any Linux host with `tmux`, the `claude` CLI signed
in, and SSH key access. Your own laptop works if it runs sshd.

## Before a pull request

```bash
make typecheck
make build
```

And please say how you tested it against a real host. Almost every bug found in this
project so far survived code review and died the first time someone actually ran it —
a stale `.env`, a container that could not write its database, a `tmux` target that
silently matched nothing.

## Where things live

| I want to… | Look at |
| --- | --- |
| support another agent (Codex, Gemini CLI) | `src/lib/claude/adapter.ts` — everything CLI-specific is there |
| add a starter template | `src/lib/templates.ts` |
| add a remote operation | `src/lib/remote/ops.ts` |
| add a proxy for `make deploy` | `scripts/deploy.sh` + a compose overlay |
| change how state is detected | `src/lib/claude/interrupts.ts` |

## Two rules that are not negotiable

**No arbitrary command execution from the API.** `src/lib/remote/ops.ts` and
`src/lib/remote/stack.ts` are the complete set of things that can reach a server.
Container images, container names and command lines are constants in the source, not
values from a request. If a feature seems to need a generic "run this", it needs a
named operation instead.

**Nothing destructive by default.** Removing a project leaves the folder, the
conversation, the database and the bucket alone. Anything that deletes data takes an
explicit request and a confirmation.

## Reporting bugs

Useful: the session state from the dashboard, the output of `make check`, and what the
terminal view shows for the affected session.

Please do not paste `.env`, SSH keys, or a project's credentials into an issue.

Security issues: email **data.ai.oliver@gmail.com** instead of opening an issue.

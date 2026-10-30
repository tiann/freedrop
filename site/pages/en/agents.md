---
title: freedrop for AI agents: send files to and from people
description: How a coding agent in a sandbox, container or remote machine hands a person a file, or takes one from them, with npx -y freedrop --json and stable exit codes.
---

# Send files between AI agents and people

Coding agents run where your downloads folder can't reach: sandboxes, containers, CI runners, remote machines. **freedrop** gives an agent one command to hand you a file — you open a link on any device — and one to take a file you picked in your browser. Nothing is uploaded anywhere: the bytes go straight between the two ends, end-to-end encrypted.

## Tell your agent about it

Paste this into the instructions your agent reads (`AGENTS.md`, `CLAUDE.md`, a system prompt):

```text
To send me files, run `npx -y freedrop --json --timeout 10m <files>` in the
background and give me the `link` from its first output line. To get files
from me, ask me for the link https://freedrop.dev/ shows me, then run
`npx -y freedrop --json -y -o <dir> '<link>'`.
Details: https://freedrop.dev/llms.txt
```

Any agent that can run shell commands can use it: Claude Code, Codex CLI, Gemini CLI, Cursor, Aider and the like. It needs Node.js 22 or newer on the agent's side; nothing on yours but a browser.

## What happens

1. **Agent → you.** The agent starts the sender in the background. Its first stdout line is a `ready` event carrying the `link`; the agent passes it on, you open it on your phone or laptop and save the files. The sender exits 0 once every byte is verified on your side.
2. **You → agent.** You open [freedrop.dev](/), pick the files and paste the link the page shows into the chat. The agent runs the receiver; every verified file produces a `saved` event with its absolute path. Keep the page open until it says done.

## Why it behaves well in an agent's shell

- **No terminal, no prompts.** Without a TTY the CLI prints plain lines — no QR code, no progress bar redrawn in place — and a receiver without `-y` exits at once instead of waiting for an answer nobody can give.
- **Output that parses.** With `--json`, stdout carries one JSON event per line and nothing else; human text moves to stderr.
- **Exit codes that say what to do next.** A lost connection (8) means re-run the same command to resume; a failed connection (4) means retry with a TURN relay; a timeout (7) means nobody came.
- **Bounded waits.** `--timeout` counts only time with no transfer under way, so a slow transfer is never cut short.
- **The link or the code.** A receiver takes the browser link as readily as the bare code, with or without `https://`.

## Reference

The same reference served at [/llms.txt](https://freedrop.dev/llms.txt), the guide written for agents themselves.

@include llms.txt

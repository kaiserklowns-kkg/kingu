# ai-memory

Long-term memory for your agents, from [ai-memory](https://github.com/akitaonrails/ai-memory)
(MIT, by Fabio Akita). Every Claude Code session in Kingu is captured into a plain-markdown wiki
on your machine; the next session starts with a brief of where you left off, and agents can
search past decisions, gotchas and procedures.

## Get started

1. **Install** this snap.
2. If Kingu says *ai-memory is not installed*, press **Install ai-memory**. It runs the project's
   checksum-verified `install.sh` (pinned to the `version` setting) in a terminal.
3. That's it: Kingu starts the ai-memory server while the snap is enabled, and new agent sessions
   get its tools, skills and capture hooks.

## What it adds

| For you | For agents |
| --- | --- |
| Tasks: status, doctor, install | MCP tools: `memory_query`, `memory_write_page`, handoffs… |
| The ai-memory server, run by Kingu | Skills: retrieval, durable pages, handoff |
| Settings: program path, server URL | Hooks: captures Claude Code sessions, injects the handoff at start |

## Good to know

- Nothing calls an LLM unless you configure a provider on the ai-memory server.
- On its first start the server downloads a small local embedding model (about 87 MB,
  checksum-pinned) for vector search; nothing leaves your machine. Set **embeddingProvider** to
  `none` for keyword search only.
- Memory lives in `~/Library/Application Support/ai-memory` (macOS) as markdown in git.
- Already run ai-memory as a service, or point at a team server? Turn **runServer** off and set
  **serverUrl**.
- Don't also run `ai-memory setup`: it wires agents globally and they would be captured twice.

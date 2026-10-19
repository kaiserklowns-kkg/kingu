---
name: kingu
description: Control the Kingu app you are running in with the `kingu` command — list and start Kingu tasks (each in its own git worktree with its own agent), open a file or folder in the editor for the user, post a desktop notification when long work finishes, and check what folder is open. Use it when the user asks to hand work off to a new Kingu task, split work into parallel tasks, show them a file in Kingu, or be notified.
---

# The `kingu` command

You are running inside Kingu, an editor and agent workspace. The `kingu` command talks to the
running app over a private socket; it is on `PATH` in Kingu's terminals and agent sessions. If
`kingu status` says Kingu is not running or the command is missing, tell the user and continue
without it — never try to start the app or install the command yourself.

## Commands

```sh
kingu status                 # app version, the open folder and how many tasks it has
kingu task list              # one task per line: slug<TAB>status<TAB>title
kingu task create "<title>" --prompt "<instructions>" [--base <branch>] [--mode terminal|timeline] [--background]
kingu task open <slug>       # show a task to the user
kingu open <path>[:line[:column]]   # open a file of the open folder (or a folder) in Kingu
kingu notify "<message>" [--title "<title>"]
```

- Add `--json` to any command for machine-readable output (`kingu --json task list`).
- `task create` prints the new task's slug. The task gets its own branch and worktree forked
  from `--base` (default: the folder's base branch) and its own agent, which starts with the
  prompt. `--prompt -` reads the prompt from stdin, which is best for long instructions:

  ```sh
  kingu task create "Add rate limiting to the API" --prompt - <<'EOF'
  Add per-token rate limiting to the HTTP API in server/api …
  EOF
  ```

- `--background` creates the task without switching the user's view to it.
- Exit codes: 0 done, 1 Kingu refused (the message says why), 2 bad arguments, 3 Kingu is not
  running or not reachable.

## Guidelines

- Only create tasks when the user asks for work to be handed off or parallelised; each task
  starts an agent that spends time and money. Give every task a short title and a prompt that
  stands on its own (the new agent does not see this conversation): the goal, the relevant
  files, constraints and how to verify.
- Check `kingu task list` first to avoid starting a duplicate of an existing task.
- Use `kingu notify` once at the end of long-running work, not for every step.
- `kingu open` only opens files inside the folder open in Kingu; paths are relative to your
  current directory.

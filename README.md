# Auto-Mate

Auto-Mate is a local app in development for turning plain-language data tasks into repeatable outputs. The developer preview now includes the application shell, AI provider configuration, and a text-only task conversation surface. You can describe a task, follow the persisted agent conversation live, reconnect without losing its ordered transcript, and cancel an active run. Settings provides provider, model, and reasoning-effort selection plus credential status and a live connection test. Uploads, generated-code workflows, script execution, artifact rendering, and browsable task history are not available yet.

> **Developer preview — no enforced execution isolation.** This preview does not run generated code. Later preview features may run code with access to other host files. Working directories, Python environments, origin checks, and the loopback address are not security boundaries. Restricted execution is required before a target-user pilot.

## Prerequisites

- Node.js **>=24.15.0 <25** (the checkout pins 24.15.0 in `.nvmrc`).
- pnpm **11.5.2**, pinned in `package.json`, and Git for a local checkout.
- `uv` and Python **3.11+** are optional for this shell. The doctor reports a warning when either is missing; later Python execution features will need them.

Install Node and pnpm for your platform, then reopen your terminal if the new commands are not on `PATH`:

**Windows 11 (PowerShell)** — [WinGet Node package](https://github.com/microsoft/winget-pkgs/tree/master/manifests/o/OpenJS/NodeJS/LTS):

```powershell
winget install --exact --id OpenJS.NodeJS.LTS
npm install --global pnpm@11.5.2
```

**macOS (Homebrew)** — [versioned Node formula](https://formulae.brew.sh/formula/node%4024):

```sh
brew install node@24
export PATH="$(brew --prefix node@24)/bin:$PATH"
npm install --global pnpm@11.5.2
```

**Linux (Bash)** — [Node's nvm setup](https://nodejs.org/en/download):

```sh
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.7/install.sh | bash
. "$HOME/.nvm/nvm.sh"
nvm install 24.15.0
npm install --global pnpm@11.5.2
```

For optional Python readiness, install `uv` and then Python 3.12. On Windows use `winget install --exact --id astral-sh.uv`; on macOS use `brew install uv`; on Linux use `curl -LsSf https://astral.sh/uv/install.sh | sh`. Then run `uv python install 3.12`. See the [uv installation guide](https://docs.astral.sh/uv/getting-started/installation/) for other methods.

## Start the preview

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm doctor
pnpm dev
```

Open <http://127.0.0.1:5173/>. The browser server proxies `/api` to the Express API at <http://127.0.0.1:4317/>. The header should report **Server connected** and schema version `1`. `pnpm doctor` checks Node, pnpm, and `node:sqlite` as required; missing `uv` or Python is a warning. Stop both development processes with `Ctrl+C`.

Open <http://127.0.0.1:5173/settings> to choose the AI provider, model, and reasoning effort, see which providers have a usable credential and where it came from, and press **Test connection**, which opens one real agent session, calls a single `status` tool, and closes. `pnpm doctor --agent-smoke` makes the same round trip from a terminal. Auto-Mate never asks you to paste an API key, includes no credential in its application config, and never returns one to the browser. A credential comes from a provider environment variable, a Pi CLI sign-in, or an opt-in to an existing personal Pi `auth.json`. The agent SDK is `@earendil-works/pi-coding-agent`, pinned at `0.87.1` and reachable only through Auto-Mate's own `AgentProvider` seam. [AI provider configuration](docs/features/provider-configuration.md) is the full reference.

After the connection test succeeds, return to <http://127.0.0.1:5173/>, enter a task description, and select **Start task** or press Ctrl/Cmd+Enter. Auto-Mate opens the task page immediately, persists each displayed event before broadcasting it, and follows the live tail over WebSocket. The server-side run continues through browser disconnects; the page resumes from durable history when it reconnects. Use **Cancel run** while the execution is active. The current pass-through flow sends only the text you type to the configured provider and does not accept files or run generated code. See [Task Description and Conversation Surface](docs/features/task-conversation-surface.md) for the full behavior and API.

The API binds to `127.0.0.1` by default. `AUTOMATE_HOST` and `AUTOMATE_PORT` can change that address, but this preview has no authentication or local session protection. D10 in the [MVP plan](.spec-lite/plan_mvp.md) owns the final local-access design; the current loopback default does not settle it or isolate code execution.

## Workspace commands

| Command                     | Purpose                                                             |
| --------------------------- | ------------------------------------------------------------------- |
| `pnpm doctor`               | Report required prerequisites and optional Python tooling.          |
| `pnpm doctor --agent-smoke` | Open one real agent session with the saved selection and close it.  |
| `pnpm dev`                  | Start the API and browser development servers.                      |
| `pnpm build`                | Type-check core and server; build the browser bundle.               |
| `pnpm test`                 | Run route generation, Vitest suites, and repository checks.         |
| `pnpm typecheck`            | Type-check the workspace packages.                                  |
| `pnpm lint`                 | Run ESLint and repository checks.                                   |
| `pnpm format`               | Format repository files with Prettier.                              |
| `pnpm db:generate`          | Generate a Drizzle migration; startup applies committed migrations. |

`pnpm build` does not create a deployable server bundle. Package-specific commands and current behavior are described in [Usage](docs/usage.md).

## Local data

Server startup creates the following under `~/.automate/` (your user home directory on Windows, macOS, or Linux):

```text
~/.automate/
├── data/automate.db   SQLite tasks, executions, transcripts, and schema metadata
├── config/agent.json  AI provider and model selection (never a credential)
├── pi/                agent credential store and model definitions
├── agent-sessions/    raw agent session logs, one directory per execution
├── artifacts/         reserved for later outputs
├── uploads/           attached input files: staged/ until a task claims them, then <taskId>/
├── scripts/           reserved for later generated scripts
└── env/               reserved for a later Python environment
```

Set `AUTOMATE_HOME` before starting the server to use another writable data root. The [Quickstart](docs/quickstart.md) shows PowerShell and Unix shell examples.

## Documentation

- [Quickstart](docs/quickstart.md) — installation, first launch, and choosing a provider.
- [Usage](docs/usage.md) — pages, commands, configuration, provider setup, health API, and troubleshooting.
- [Architecture](docs/architecture.md) — implemented packages, data flow, and deployment scope.
- [Project bootstrap feature](docs/features/project-bootstrap.md) — FEAT-101 behavior and limitations.
- [AI provider configuration](docs/features/provider-configuration.md) — FEAT-102 provider settings, credentials, the agent seam, and troubleshooting.
- [Task conversation surface](docs/features/task-conversation-surface.md) — FEAT-103 task creation, live conversation, replay, cancellation, APIs, and recovery.
- [CSV and XLSX ingestion](docs/features/csv-xlsx-ingestion.md) — FEAT-104 file attachment, local profiling, exactly what the disclosure payload contains, limits, and retention.
- [Core package](packages/core/README.md), [server package](packages/server/README.md), and [web package](packages/web/README.md) — package-level development notes.
- [Changelog](CHANGELOG.md) — milestone history.

## Development

The repository does not publish a contribution workflow. For local changes, run the established validation commands before sharing your work:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

This project is licensed under the [MIT License](LICENSE).

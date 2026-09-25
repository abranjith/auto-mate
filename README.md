# Auto-Mate

Auto-Mate is a local app in development for turning plain-language data tasks into repeatable outputs. The developer preview includes the application shell, AI provider configuration, a task conversation surface, CSV/TSV/XLSX attachment with local profiling, a review of exactly what will be sent before a task starts, agent clarification questions, and code generation with an agent repair loop. You can describe a task, follow the persisted agent conversation live, reconnect without losing its ordered transcript, and cancel an active run. Settings provides provider, model, and reasoning-effort selection plus credential status and a live connection test. For a task with approved files, the agent writes a Python script and its own tests, tests them against synthetic data built from the approved file description (the real file is not opened during generation), repairs the script within a limited number of attempts, and offers a guidance retry when a run fails. Independent verification, running the final script on your real file, artifact rendering, and browsable task history are not available yet.

> **Developer preview — no enforced execution isolation.** Generated code runs without an isolation boundary in this milestone: the agent's generated tests run as Python with this application's own access to your files and network. The agent itself has no file, shell, or network tool, but that limits the agent, not the code it writes. Working directories, the `uv` environment (whose `--no-sync --locked` options only prevent dependency drift), origin checks, and the loopback address are not security boundaries. Restricted execution is required before a target-user pilot.

## Prerequisites

- Node.js **>=24.15.0 <25** (the checkout pins 24.15.0 in `.nvmrc`).
- pnpm **11.5.2**, pinned in `package.json`, and Git for a local checkout.
- `uv` and Python **3.11+** are needed for generated tests to run on tasks with attached files. The server still starts without them and `pnpm doctor` only warns, but such a task then fails at its first test run with `PYTHON_RUNTIME_UNAVAILABLE`. The first test run downloads `pandas`, `openpyxl`, `plotly`, and `pytest` into `~/.automate/env/`, so it needs network access.

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

To run generated tests, install `uv` and then Python 3.12. On Windows use `winget install --exact --id astral-sh.uv`; on macOS use `brew install uv`; on Linux use `curl -LsSf https://astral.sh/uv/install.sh | sh`. Then run `uv python install 3.12`. See the [uv installation guide](https://docs.astral.sh/uv/getting-started/installation/) for other methods.

## Start the preview

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm doctor
pnpm dev
```

Open <http://127.0.0.1:5173/>. The browser server proxies `/api` to the Express API at <http://127.0.0.1:4317/>. The header should report **Server connected** and schema version `1`. `pnpm doctor` checks Node, pnpm, and `node:sqlite` as required; missing `uv` or Python is a warning. Stop both development processes with `Ctrl+C`.

Open <http://127.0.0.1:5173/settings> to choose the AI provider, model, and reasoning effort, see which providers have a usable credential and where it came from, and press **Test connection**, which opens one real agent session, calls a single `status` tool, and closes. `pnpm doctor --agent-smoke` makes the same round trip from a terminal. Auto-Mate never asks you to paste an API key, includes no credential in its application config, and never returns one to the browser. A credential comes from a provider environment variable, a Pi CLI sign-in, or an opt-in to an existing personal Pi `auth.json`. The agent SDK is `@earendil-works/pi-coding-agent`, pinned at `0.87.1` and reachable only through Auto-Mate's own `AgentProvider` seam. [AI provider configuration](docs/features/provider-configuration.md) is the full reference.

After the connection test succeeds, return to <http://127.0.0.1:5173/>, enter a task description, and select **Start task** or press Ctrl/Cmd+Enter. Auto-Mate opens the task page immediately, persists each displayed event before broadcasting it, and follows the live tail over WebSocket. The server-side run continues through browser disconnects; the page resumes from durable history when it reconnects. Use **Cancel run** while the execution is active. A text-only task sends only the text you type to the configured provider. See [Task Description and Conversation Surface](docs/features/task-conversation-surface.md) for the full behavior and API.

To work with data, attach up to five `.csv`, `.tsv`, or `.xlsx` files before **Start task**. Auto-Mate profiles them on this computer, then shows **Review what will leave this machine** with the exact bounded file description, provider, and model; nothing file-derived is sent until you select **Approve and start**. The agent then writes a Python script and pytest tests, runs them against synthetic data built from the approved description, and repairs the script within a limited number of attempts (three by default). A completed run means the agent chose a final version, not that the script works on your file; in this build the script is not run on your real file. A failed run offers **Try again** with optional guidance, which starts a new linked run that reuses your approval. See [Disclosure Review and Clarification](docs/features/disclosure-review-clarification.md) and [Code Generation and Agent Repair Loop](docs/features/code-generation-repair.md).

The API binds to `127.0.0.1` by default. `AUTOMATE_HOST` and `AUTOMATE_PORT` can change that address, but this preview has no authentication or local session protection. D10 in the [MVP plan](.spec-lite/plan_mvp.md) owns the final local-access design; the current loopback default does not settle it or isolate code execution.

## Workspace commands

| Command                     | Purpose                                                             |
| --------------------------- | ------------------------------------------------------------------- |
| `pnpm doctor`               | Report required prerequisites; warn when `uv` or Python is missing. |
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
├── data/automate.db   SQLite tasks, executions, transcripts, generated code, and schema metadata
├── config/agent.json  AI provider and model selection (never a credential)
├── pi/                agent credential store and model definitions
├── agent-sessions/    raw agent session logs, one directory per execution
├── artifacts/         reserved for later outputs
├── uploads/           attached input files: staged/ until a task claims them, then <taskId>/
├── scripts/           generated code attempts and synthetic test data, written from the database
└── env/               shared uv project for generated tests, prepared by the first test run
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
- [Disclosure review and clarification](docs/features/disclosure-review-clarification.md) — FEAT-105 review of what leaves the machine, pinned consent, filtered diagnostics, pre-flight choices, and agent questions.
- [Code generation and agent repair loop](docs/features/code-generation-repair.md) — FEAT-106 generated scripts and tests, synthetic test data, attempts and limits, guidance retry, APIs, and configuration.
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

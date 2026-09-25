# Auto-Mate

Auto-Mate is a local app in development for turning plain-language data tasks into repeatable outputs. The developer preview includes the application shell, AI provider configuration, a task conversation surface, CSV/TSV/XLSX attachment with local profiling, a review of exactly what will be sent before a task starts, agent clarification questions, code generation with an agent repair loop, and an independent verification and execution gate. You can describe a task, follow the persisted agent conversation live, reconnect without losing its ordered transcript, and cancel an active run. Settings provides provider, model, and reasoning-effort selection plus credential status and a live connection test. For a task with approved files, the agent writes a Python script and its own tests, tests them against synthetic data built from the approved file description (the real file is not opened during generation), repairs the script within a limited number of attempts, and offers a guidance retry when a run fails. Auto-Mate then checks the final script itself without contacting an AI, asks you before running it once on a copy of your file, and asks whether the result is what you wanted. Viewing and downloading output files and browsable task history are not available yet.

> **Developer preview — no enforced execution isolation.** Generated code runs without an isolation boundary in this milestone: the agent's generated tests, and the approved script's run on a copy of your file, run as Python with this application's own access to your files and network. It can read any file this application can read. The agent itself has no file, shell, or network tool, but that limits the agent, not the code it writes. Working directories, locked dependencies, the pinned interpreter, `PYTHONSAFEPATH`, the input copy (which protects your original only from a buggy script), origin checks, and the loopback address are not security boundaries or network restrictions. Restricted execution is required before a target-user pilot.

## Prerequisites

- Node.js **>=24.15.0 <25** (the checkout pins 24.15.0 in `.nvmrc`).
- pnpm **11.5.2**, pinned in `package.json`, and Git for a local checkout.
- `uv` is needed for tasks with attached files. Auto-Mate uses it to install its pinned CPython **3.14.6** interpreter and prepare separate locked environments for generated scripts/tests and code checkers. The server starts without `uv`; `pnpm doctor` warns, and a task that needs Python fails with `PYTHON_RUNTIME_UNAVAILABLE` until `uv` is available. First preparation may download the interpreter and package wheels, so it needs network access.

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

For tasks with attached files, install `uv`. On Windows use `winget install --exact --id astral-sh.uv`; on macOS use `brew install uv`; on Linux use `curl -LsSf https://astral.sh/uv/install.sh | sh`. Auto-Mate installs CPython 3.14.6 through `uv` if needed. See the [uv installation guide](https://docs.astral.sh/uv/getting-started/installation/) for other methods.

## Start the preview

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm doctor
pnpm dev
```

Open <http://127.0.0.1:5173/>. The browser server proxies `/api` to the Express API at <http://127.0.0.1:4317/>. The header should report **Server connected** and schema version `1`. `pnpm doctor` checks Node, pnpm, and `node:sqlite` as required; missing `uv` or Python is a warning. Stop both development processes with `Ctrl+C`.

Open <http://127.0.0.1:5173/settings> to choose the AI provider, model, and reasoning effort, see which providers have a usable credential and where it came from, and press **Test connection**, which opens one real agent session, calls a single `status` tool, and closes. `pnpm doctor --agent-smoke` makes the same round trip from a terminal. Auto-Mate never asks you to paste an API key, includes no credential in its application config, and never returns one to the browser. A credential comes from a provider environment variable, a Pi CLI sign-in, or an opt-in to an existing personal Pi `auth.json`. The agent SDK is `@earendil-works/pi-coding-agent`, pinned at `0.87.1` and reachable only through Auto-Mate's own `AgentProvider` seam. [AI provider configuration](docs/features/provider-configuration.md) is the full reference.

The server begins preparing script and checker Python environments in the background after it starts listening. The first preparation can take several minutes; a task that needs an environment waits for it. **Settings → Python runtime** shows each environment's status, installed packages, and **Prepare now** control for a retry. See [Python Runtime and Script Execution](docs/features/python-runtime-execution.md) for its fixed package sets and preparation behavior.

After the connection test succeeds, return to <http://127.0.0.1:5173/>, enter a task description, and select **Start task** or press Ctrl/Cmd+Enter. Auto-Mate opens the task page immediately, persists each displayed event before broadcasting it, and follows the live tail over WebSocket. The server-side run continues through browser disconnects; the page resumes from durable history when it reconnects. Use **Cancel run** while the execution is active. A text-only task sends only the text you type to the configured provider. See [Task Description and Conversation Surface](docs/features/task-conversation-surface.md) for the full behavior and API.

To work with data, attach up to five `.csv`, `.tsv`, or `.xlsx` files before **Start task**. Auto-Mate profiles them on this computer, then shows **Review what will leave this machine** with the exact bounded file description, provider, and model; nothing file-derived is sent until you select **Approve and start**. The agent then writes a Python script and pytest tests, runs them against synthetic data built from the approved description, and repairs the script within a limited number of attempts (three by default). Auto-Mate then runs seven checks of its own (including `ruff`, `bandit`, and a re-run of the agent's tests); a blocking finding fails the run with `VERIFICATION_BLOCKED`. Otherwise the **Before you run** panel waits for you, and nothing touches your file until you select **Run it**. The script then runs once on a verified copy of your file, and the run completes only when you answer **Yes, this is what I wanted**; **No — here's what's wrong.** starts a new linked run with your feedback. Passing checks on synthetic data is not proof the script works on your real file. A failed run offers **Try again** with optional guidance, which starts a new linked run that reuses your approval. See [Disclosure Review and Clarification](docs/features/disclosure-review-clarification.md), [Code Generation and Agent Repair Loop](docs/features/code-generation-repair.md), and [Verification and Execution Gate](docs/features/verification-execution-gate.md).

Real script runs have provisional time and output limits on every platform. A stopped run names the limit it reached. A memory cap is enforced on macOS and Linux: **A memory limit is enforced with RLIMIT_AS on macOS and Linux.** **No memory limit is enforced on Windows.** See [Usage](docs/usage.md#understand-and-change-runtime-limits) for values and settings.

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
| `pnpm runtime:lock`         | Regenerate committed Python locks after a deliberate pin change.    |

`pnpm build` does not create a deployable server bundle. Package-specific commands and current behavior are described in [Usage](docs/usage.md).

## Local data

Server startup creates the following under `~/.automate/` (your user home directory on Windows, macOS, or Linux):

```text
~/.automate/
├── data/automate.db   SQLite tasks, executions, transcripts, generated code, checks, approvals, runs, and schema metadata
├── config/agent.json  AI provider and model selection (never a credential)
├── pi/                agent credential store and model definitions
├── agent-sessions/    raw agent session logs, one directory per execution
├── artifacts/         reserved for later outputs
├── uploads/           attached input files: staged/ until a task claims them, then <taskId>/
├── scripts/           generated code attempts and synthetic test data, written from the database
├── env/               locked Python project for generated scripts/tests and its launcher
├── verify-env/        locked ruff and bandit checker project
└── runs/              per run: input/ (verified copy of your file), output/, and verify/ scratch
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
- [Verification and execution gate](docs/features/verification-execution-gate.md) — FEAT-107 independent checks, the approval gate, running on a copy of your file, result review, and feedback retry.
- [Python runtime and script execution](docs/features/python-runtime-execution.md) — FEAT-108 locked environments, runtime status, limits, and maintainer workflow.
- [Python run limits](docs/runtime-limits.md) — what a stopped run means and which platform enforces each limit.
- [Runtime maintenance](docs/runtime-maintenance.md) — committed locks, upgrades, and live verification.
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

# Antigravity CLI

Install and sign in to the official [Antigravity CLI](https://antigravity.google/docs/cli/getting-started/)
on the computer running WildCrane. `agy --version` and `agy models` should work there.
Select **Antigravity CLI** in runtime settings, choose a model or leave it empty for the CLI
default, then test the connection. Use that runtime in discussions, previews and tasks.
It uses the CLI's local login and credits; WildCrane billing is unchanged.

## Existing API

| Request | Antigravity support |
| --- | --- |
| `akb agent check antigravity --json` | Existing readiness, binary/version fields, error kinds and exit codes |
| `GET /v1/runtimes` | Connector `antigravity`, availability, connector version, settings and models from the connected computer |
| `POST /v1/runtimes` | `{ "name": "Antigravity", "runner": "<machine UUID>", "connector": "antigravity", "model": "<agy model id>" }`; omit model for default |
| `PATCH /v1/runtimes/{id}` | Existing `connector` and `model` fields; `null` clears the model |
| `POST /v1/runtimes/{id}/test` | Existing asynchronous connection test on the bound computer |

Existing ownership, computer and task authorization apply. No new endpoints or MCP tools.
This integration does not install a WildCrane plugin in Antigravity or use remote agents.

## Execution

- **Protocol**: tested with agy 1.5.6; [headless NDJSON](https://antigravity.google/docs/cli/headless/) is parsed independently of Gemini CLI.
- **Permissions**: unattended runs use `--dangerously-skip-permissions`, subject to the CLI's deny rules. Denied actions fail even when agy exits zero with `SUCCESS`.
- **Context**: resume uses only `--conversation <id>`. The local `.gemini/antigravity-cli/conversations/<id>.db` must exist; a mismatched returned ID fails without replacing the known ID. No latest-session fallback.
- **Usage**: result counters cover the conversation. The first resumed prompt uses its own completed-step counts; subsequent results subtract previous cumulative counts. No inferred price or context estimate.
- **Customization**: existing `.agents/skills` and project instructions remain available. Language rules use a generated rules directory added with `--add-dir`; no business prompt is replaced.
- **Failures**: missing final results, non-success states, denied actions and process failures remain failures. Authentication, model, network and quota errors include retry guidance. Model discovery failure leaves saved selections intact and does not imply signed out.
- **Brand**: the unmodified SVG comes from [official press assets](https://antigravity.google/press).

## Release and rollback

Apply `0208_antigravity.sql`, deploy Cloud, publish CLI contract 14 and Runner protocol 20,
then deploy Web. Keep the global protocol floor: list and claim checks prevent older Runners
from receiving Antigravity jobs, including direct claims. Use the normal Alpha/candidate/stable
gates in [Deploy](../deploy.md).

To roll back, stop new Antigravity dispatch and stop or finish its running jobs, then roll back
applications and withdraw the Runner/CLI release through their existing channels. Keep expanded
constraints, runtime records and history. Never substitute another connector.

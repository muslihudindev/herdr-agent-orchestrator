# HerdR Pi Orchestration

Local-first, provider-agnostic multi-agent software engineering orchestration for the real Pi Coding Agent TUI running inside HerdR.

The user-facing flow is:

```text
herdr -> pi -> Task Manager (Codex) -> Executors (Claude Code) -> Validator (Claude Code) -> Task Manager -> pi
```

You interact only with Pi. Plain task text entered in Pi is queued, routed to HerdR orchestration, investigated by Task Manager, protected with regression controls, implemented by configured backend agents, independently validated, summarized, then committed and pushed only after the configured publish approval. Pi itself does not plan, implement, review, validate, commit, or push.

## Architecture

```text
Real Pi TUI
  -> .pi/extensions/herdr-orchestration.ts
  -> packages/runtime/RuntimeOrchestrator
  -> internal Task Manager runner
  -> provider registry
  -> HerdR panes for configured providers
```

The extension intercepts normal Pi input so the foreground Pi session does not do the work directly. HerdR owns panes and process lifecycle. The orchestration runtime owns queueing, events, role assignment, workspace isolation, logs, and approval state.

The default role mapping is:

```yaml
task_manager: codex-planner
executor: claude-code
validator: claude-code
```

Changing providers only requires editing `config/roles.yaml` and `config/providers.yaml`.

## Project Layout

```text
apps/pi-orchestrator/      Internal Task Manager runner used by RuntimeOrchestrator
packages/runtime/          HerdR-aware orchestration runtime and adapter
packages/providers/        Provider interface and provider registry
packages/pi-extension/     Pi extension source installed by script
packages/workers/          Worker base and executor worker
packages/task-manager/     Repository analysis and execution planning
packages/validator/        Validation worker
packages/event-bus/        Event-driven worker communication
packages/dashboard/        Real-time dashboard state rendering
packages/config/           YAML configuration loader
packages/registry/         Role registry
packages/workspace/        Workspace isolation
packages/shared/           Shared types and IDs
config/                    Default role and provider configuration
scripts/                   Project extension installer
tests/                     Unit and integration tests
```

## Install

```bash
npm install
npm test
```

This repository provides the orchestration framework and extension source. It does not replace the real `pi` command.

## Use From Any Project

Install a tiny extension wrapper into the project you want Pi to work on:

```bash
/home/muslih/Documents/AgentOrchestration/scripts/install-pi-extension.sh /path/to/your/project
```

Then start HerdR and Pi from that target project:

```bash
cd /path/to/your/project
herdr
pi --approve
```

Inside Pi, type the task normally:

```text
Build JWT authentication with refresh token support.
```

The target project receives only:

```text
.pi/extensions/herdr-orchestration.ts
```

The framework, config, and compiled code remain in this repository. Runtime state stays in the target project:

```text
.pi/herdr-orchestration/queue.json
.pi/herdr-orchestration/logs/
.pi/herdr-orchestration/workspace/
```

That means you can run Pi from any project folder and the orchestration still works against that folder.

## Queue

Pi accepts multiple tasks. Each submitted task is appended to the local queue immediately. Task Manager starts pre-planning queued `todo` tasks right away, even while another task is still running, so pending tasks can already have an execution plan before they reach the front of the execution queue.

Execution remains sequential: only the active task launches executors and Validator. When a queued task is pre-planned, Pi shows that first plan immediately for `/herdr-confirm`, `/herdr-revise-plan`, or `/herdr-reject-plan`. If you approve that pre-planned task, the approval is stored on the queue item; when the task later becomes active, it uses the already-approved plan and does not ask for confirmation again.

Queue states are:

```text
todo -> inprogress -> complete
todo -> inprogress -> failed
```

Queue files keep those top-level states for compatibility. New records also carry a detailed safety phase such as `investigating`, `awaiting_plan_approval`, `creating_baseline`, `implementing`, `regression_review`, `awaiting_publish_approval`, or `completed`. Older queue records are migrated in memory when Pi reads them; users do not need to delete `.pi/herdr-orchestration/queue.json`.

The enforced workflow is:

```text
Request
  -> Repository Investigation
  -> Impact Analysis
  -> Regression Matrix
  -> Plan Approval
  -> Safety Baseline
  -> Implementation
  -> Validation
  -> Independent Regression Review
  -> User Approval
  -> Commit and Push
```

If Validator fails after execution, HerdR assigns a repair executor with the validation failure summary, then reruns Validator. If validation still fails after the configured repair attempts, the queue item is marked `failed`, not `complete`.

Extension controls:

```text
Normal message        Continue a regular Pi conversation
/herdr-add-task <task> Queue a new HerdR task
/herdr-start <task>   Alias for adding a HerdR task
/herdr-answer <answer> Answer Task Manager clarification questions
/herdr-confirm        Approve the Task Manager plan and launch workers
/herdr-plan-detail    Show the full current Task Manager plan
/herdr-impact         Show impact analysis for the active or pending task
/herdr-regression-matrix Show regression matrix and coverage status
/herdr-validation     Show baseline and final validation results
/herdr-approve-risk   Approve explicitly listed high-risk plan aspects
/herdr-revise-plan    Request Task Manager to revise the current plan
/herdr-reject-plan    Reject the Task Manager plan before workers launch
/herdr-status         Show queue and current orchestration status
/herdr-queue          Alias for /herdr-status
/herdr-run-todo       Manually resume stuck todo tasks
/herdr-retry-failed <queue-id> Requeue a failed task for rework
/herdr-approve        Approve validated work for publishing
/herdr-reject         Reject validated work before publishing
/herdr-clear-complete Remove completed tasks from the queue file
/herdr-reset-inprogress Move stuck in-progress tasks back to todo
```

Safety and publishing defaults live in `config/providers.yaml`:

```yaml
safety:
  require_impact_analysis: true
  require_regression_matrix: true
  require_characterization_tests_for_legacy_changes: true
  require_independent_validation: true

validation:
  maximum_repair_attempts: 2

git:
  publish_mode: manual_approval
```

`git.publish_mode` supports `manual_approval`, `automatic_after_validation`, `commit_only_after_approval`, and `disabled`. The safe default is `manual_approval`: after Validator passes, Pi asks for `/herdr-approve` before commit and push.

Task artifacts are persisted under:

```text
.pi/herdr-orchestration/tasks/<task-id>/
  request.md
  impact-analysis.md
  regression-matrix.json
  plan.md
  baseline-validation.json
  executor-assignments.json
  validator-results.json
  final-validation.json
  final-report.md
```

## HerdR Integration

When running inside a HerdR-managed pane, the provider layer creates panes for real configured agents:

- Task Manager using the `codex-planner` provider
- Executors using the `claude-code` provider
- Validator using the `claude-code` provider

Outside HerdR, providers run as local child processes. Inside HerdR, provider commands open in HerdR panes.

Pi still does not plan, implement, or validate in the user-facing session.

Interactive HerdR agent labels are unique per spawn, using the worker id, HerdR task id, and a short spawn id. This prevents collisions when multiple projects or retries use common role names like `validator` or `executor-001`.

The HerdR adapter is intentionally thin. HerdR owns pane creation and lifecycle; this platform owns provider-agnostic task routing and event flow.

## Role Boundaries

- Pi: accepts user input, queues tasks, shows status, and reports completion.
- Task Manager: inspects the repository and produces an execution plan. It never edits files, runs tests, or spawns agents directly.
- Executors: implement assigned work only. A test executor may write tests when assigned.
- Validator: runs final verification, including available tests, lint, build, acceptance checks, and cross-role regression checks.
- HerdR: creates panes, launches provider processes, streams logs, and isolates runtime state.

## Provider Interface

Every provider implements:

```ts
start(): Promise<void>
stop(): Promise<void>
executeTask(task): Promise<ProviderExecutionResult>
streamLogs(taskId, onChunk): Promise<() => void>
cancelTask(taskId): Promise<void>
healthCheck(): Promise<boolean>
getStatus(): Promise<ProviderStatus>
```

The default `simulated` provider makes tests runnable without external coding agents. Real providers use the generic process provider, which launches only the command and arguments from configuration. Orchestration code contains no provider-specific CLI commands.

## Configuration

`config/roles.yaml`

```yaml
roles:
  task_manager:
    provider: codex-planner
    replicas: 1
  executor:
    provider: claude-code
    replicas: 3
  validator:
    provider: claude-code
    replicas: 1
```

`config/providers.yaml`

```yaml
providers:
  codex-planner:
    command: codex
    args:
      - exec
      - --sandbox
      - read-only
      - --color
      - always
      - --skip-git-repo-check
  codex:
    command: codex
    args:
      - exec
      - --sandbox
      - workspace-write
      - --color
      - always
      - --skip-git-repo-check
  claude-code:
    command: claude
    args:
      - --permission-mode
      - auto
    interactive: true
    closePaneOnDone: true
```

To switch providers, edit only configuration or add a provider implementation. Runtime orchestration does not change.

## Tribe Manager

Task Manager can optionally call the `tribe_manager` MCP for project-specific objectives. This is disabled by default.

Configure it by absolute project path in `config/tribe-manager.yaml`:

```yaml
projects:
  /home/muslih/Documents/your-project:
    objective: "Keep the implementation aligned with the product roadmap objective."
    objective_id: 123
    user_id: 456
```

When an objective is configured with `objective_id` and `user_id`, HerdR uses Claude Code to call `tribe_manager` for approved/in-progress and completed non-git tasks. The in-progress call happens after `/herdr-confirm` and before executors launch, so every approved non-git task is added in Tribe Manager with `in-progress` status first. The created Tribe task id is captured and passed to the completion sync, which updates the same Tribe task to `complete` after validation passes. Git-related tasks such as commit, push, branch, merge, rebase, pull, stash, or tag are excluded. If no objective is configured for the current project path, Tribe Manager is not mentioned or called.

Pi stores and displays the Tribe Manager sync result for each completed queue item. If `config/tribe-manager.yaml` only has `objective` text and no numeric `objective_id`/`user_id`, Pi will report that sync was skipped instead of silently marking the local task as complete.

`config/tribe-manager.yaml` is loaded when a task is planned or executed. Editing the YAML content does not require restarting Pi; new tasks and newly started queued tasks use the updated file. Restart Pi only when changing the config path environment variable, such as `PI_ORCHESTRATION_TRIBE_MANAGER_PATH`.

If the provider session cannot access the `tribe_manager` MCP tool, the task still runs but completion sync is skipped because no Tribe task id exists. When a create succeeds, HerdR captures `HERDR_TRIBE_JSON` whether the JSON is same-line, multi-line, or wrapped by HerdR log JSON.

## Git Publishing

After Validator passes, HerdR discovers changed git repositories under the current project folder and waits for the configured publish mode. In the default `manual_approval` mode, `/herdr-approve` commits changed files in each repo and pushes the current branch to every configured remote for that repo. If the project folder contains multiple repo folders, each changed repo is handled independently. If validation fails, HerdR does not commit or push.

Commit subjects are generated by the configured Validator provider from the task intent plus staged code changes. The staged diff is the source of truth; the task text is context and must not be copied verbatim. The provider receives the original task, staged file names, diff stat, and a truncated staged diff, then returns `HERDR_COMMIT_JSON {"subject":"..."}`. If the provider fails or returns an invalid subject, HerdR falls back to a local staged-path heuristic. Existing conventional commit prefixes from repo history are preserved when available.

Pi prints the validation, git publish, and Tribe Manager sync summaries when the task finishes.

## Development

```bash
npm run build
npm test
```

Do not run `node dist/apps/pi-orchestrator/src/index.js` as the user interface. That file is an internal runner invoked by `RuntimeOrchestrator` for the Task Manager backend role.

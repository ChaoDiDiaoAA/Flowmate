[English](architecture.md) | [简体中文](architecture.zh-CN.md) · [Documentation](README.md)

# Architecture

## Process and trust boundaries

Electron renders the workbench and owns windows and operating-system integration. In local mode, a Bun Host owns the product Application and local database access. Chats, Invoices and Deep Research use Pi AgentSession; the independent [Personal Agent](personal-agent.md) uses Pi Durable. Both adapters use SDK 1.4.0 and share Application, business services, ToolExecutor, Workspace and Context. The Renderer uses a narrow Preload API rather than reading SQLite or calling the SDK directly.

When service mode is explicitly enabled, ServiceOwner owns the Application and the desktop connects through the production Node ServiceClient. An unavailable selected service does not start a second local Host.

```mermaid
flowchart TB
  User[User action] --> Renderer[React Renderer]
  Renderer --> Preload[Preload allowlisted API]
  Preload --> Main[Electron Main]
  Main -->|validated protocol| Host[Bun Host or selected ServiceOwner]
  Host --> App[Shared Application and business services]
  App --> Context[Workspace and Context services]
  App --> Adapter[runtime-pi: Chats / Invoices / Deep Research]
  Context -->|request-local projection| Adapter
  Adapter --> SDK[Pi AgentSession]
  App --> Durable[runtime-durable: Personal Agent]
  Durable --> Harness[Pi Durable Harness]
  SDK --> Model[Selected model service]
  Harness --> Model
  SDK --> Executor[Product ToolExecutor]
  Harness --> Executor
  Executor --> Domain[Research / Invoice / Resources / Native tools]
  Domain -->|research checkpoint facts| Context
  Context --> Store[(SQLite and managed files)]
  Domain --> Store
  App --> Children[Owned child executions]
  Children --> Adapter
  Children --> Durable
```

Host messages carry validated request and ownership identities. Notifications wake readers; saved queries supply authoritative state. A missing or late reply is not permission to re-execute a write. See [Agent runtime](agent-runtime.md) for lifecycle details.

For web-enabled Deep Research, the executing Host reads `FLOWMATE_TAVILY_API_KEY` from its startup environment. The Renderer receives configuration status only. After plan confirmation, the parent Agent's tools send the approved public search terms or URLs to Tavily. They treat the returned page text as untrusted evidence. The task-level switch retains task and Session IDs, local material IDs and history; it clears the current plan and Run pointers only once execution has settled. A new plan must be confirmed. Live web evidence queries and saves enforce the new Run's source policy and plan; historical reads and exports resolve saved evidence under its original authorization.

The report stays at format 3. For `research-semantic-v2`, the Host builds the evidence directory from saved Claim entries and validates each binding to the confirmed plan, source snapshot, exact UTF-16 slice and acquisition receipt. The reviewer checks the final sentences against selected quotations, refuting and dependency evidence, and the complete saved text of the involved sources. Each fact needs support, and each selected citation must contribute directly or supply a necessary premise. The Host binds the directory and review to the exact report, plan and writing ToolCall.

Reference numbering is derived from the structured body: answer sentences first, then section sentences in order. The identity is `claimId + evidenceIndex`; first use assigns the next number and subsequent uses retain it. Claim IDs, URLs and page titles do not determine numbering order. The Renderer and both export paths resolve the same numbered references. Each entry retains its source snapshot, exact UTF-16 quotation interval and acquisition identity, so a presentation number never substitutes for the saved evidence binding.

The selected model receives the complete saved context in one call when it fits. Otherwise, N context scans and one final decision call cover it. Before review starts, the Host checks that all planned review calls fit in the shared Run budget with one call reserved for the Assistant response. All stages use the existing save tool and Run deadlines, with no conversation history, tools or automatic retry. An incomplete or failed review blocks the save; a valid empty partial report records `no_findings` without calling the model. The Renderer and Markdown/PDF exports use the same reference numbers. Format 3 v1 records retain their original review without v2 checks; format 2 remains exportable without a review record. See [Deep Research](workflows.md#deep-research).

Review runs outside the database transaction. Before committing, the save path rechecks the active Run, confirmed plan, material permission and source contents. The report, review receipt and current report pointer commit together. An exact duplicate of the original writing ToolCall and saved payload returns the committed receipt even after its Run ends. Repeating that call with a changed payload is rejected; revisions use a new save call. Size validation covers both projected report data and the complete stored ToolCall result envelope, so an oversized receipt is refused before report insertion.

For [cloud Personal Agent Work](personal-agent.md#cloud-workspace), the desktop connects to the restricted SSH Bridge. Authority owns workspace authorization, business persistence and the provider proxy. Runtime owns the native Durable execution and checkpoints. The desktop keeps ownership of window and browser interactions. Use saved business receipts to confirm effects and model observations to inspect execution evidence.

## Responsibilities

| Location | Responsibility |
|---|---|
| `apps/desktop` | Main, Preload, React pages, OS credentials, file dialogs, Host lifecycle and ServiceClient |
| `apps/host` | Local protocol dispatch and product Application ownership |
| `apps/service` | Independent ServiceOwner, authenticated protocol and Application ownership in service mode |
| `apps/composition.ts`, `apps/personal-agent.ts` | Wire shared storage, domains, resources, tools and both runtime adapters |
| `packages/contracts` | Validated inputs, results, state, events and cross-layer interfaces |
| `packages/core` | Session/Run and invoice-work coordination, Context, tool recording, resources, research and storage |
| `packages/runtime-pi` | Provider/model preparation, AgentSession, native history, controlled extensions and tools |
| `packages/runtime-durable` | Durable Harness, SDK-native Tasks/checkpoints and the Personal Agent runtime adapter |
| `packages/data` | Register and read original/parsed materials |
| `packages/employee-invoice` | Invoice rules, extraction tools, source validation and form operations |
| `packages/logging` | Bounded runtime logs and Prompt Trace |
| `packages/shared` | Paths, controller ownership, credentials and installed runtime layout |
| `agent-eval` | Separate Trial execution, evidence, scoring and optional platform export |

## From input to a saved outcome

1. Main validates a user action and routes it to the selected Application owner.
2. The Application validates Session/workspace or invoice-work ownership and accepts a specific input or command.
3. The selected runtime fixes model configuration, allowed materials/tools, resource versions and a Context basis for that execution. A research Run also captures the saved preference text and revision.
4. For a new layered input, the AgentSession adapter prepares native history and tools, then adds its request-local Context projection and, when available, the current research checkpoint before a model request. Model-selected tool calls return through the product executor, which enforces permissions, budgets and delivery records. Durable retains its own phase context.
5. Domain services validate business effects. SQLite and managed files preserve execution facts and artifact identities.
6. The UI queries saved results and displays live progress without treating progress as a durable business commit.

Core admits child tasks into the owning runtime. Local children run under the same Application owner as their parent. Cloud Durable children run under the cloud Runtime. They share their owner's budgets, admit at most four children, prohibit nesting and retain occupied capacity while stopping is unknown. Personal Agent delegates only to the read-only `invoice-evidence-checker` role through its Durable adapter; the AgentSession extension is a separate path. [Subagents](subagents.md) describes each path's permissions, context and stopping; a child is not a separate OS sandbox or an independent write-capable agent.

## Persistence and resources

The Windows user-data root is `%APPDATA%\Flowmate`. `data/app.sqlite` stores product state and Durable native records under one database owner and shared write coordination; `artifacts/`, `outputs/` and `runtime/` hold managed content and run resources. A controller lock prevents competing product owners of the same data root. AgentSession history and Durable native Tasks/checkpoints remain owned by their respective adapters.

AgentSession input snapshots, native conversation history and research step/tool/source records have distinct ownership. Research preferences are explicitly saved in product settings; the desktop's saved page/research focus is navigation state. Restoring that focus does not start a model Run. See [Context and memory layers](agent-runtime.md#context-memory-layers) and [Deep Research](workflows.md#deep-research).

[OpenViking](agent-runtime.md#openviking-memory) is an optional memory service with separate local and cloud identities and stores. Runtime-specific grants determine which sourced entries may be projected into a request. Session history, Durable checkpoints and business receipts remain owned by Flowmate and the corresponding runtime.

ServiceOwner/Node ServiceClient, SID/DACL checks, CurrentUser DPAPI credentials, original-credential migration and maintenance remain implemented. Current engineering delivery covers execution while the Application owner is running, committed facts and eligible recovery. Real Windows SCM installation/startup, boot, upgrade/rollback and continued execution after closing the desktop remain deferred acceptance.

Author resources live under `resources/`; enabled versions are prepared into owned run bundles, with original content retained for historical use. Current author files do not silently replace an old Run's evidence. See [Skills and extensions](skills-and-extensions.md).

Installed mode uses the packaged `flowmate-runtime`, its release inventory and bundled Bun/SDK/native tools. It does not fall back to a developer source tree or a system Bun executable. Development mode resolves repository entries separately. See [Packaging and recovery](packaging-and-recovery.md).

## Source and verification entry points

- [Composition](../../apps/composition.ts), [Personal Agent composition](../../apps/personal-agent.ts), [Host dispatch](../../apps/host/main.ts), [Host protocol](../../apps/host/protocol.ts)
- [Desktop Main](../../apps/desktop/main/index.ts), [Preload](../../apps/desktop/preload), [Renderer](../../apps/desktop/renderer/src)
- [Runtime](../../packages/core/src/runtime/service.ts), [Pi adapter](../../packages/runtime-pi/src/session.ts), [Durable adapter](../../packages/runtime-durable/src/index.ts), [ServiceOwner](../../apps/service/owner.ts), [ServiceClient](../../apps/desktop/main/service-client.ts), [runtime layout](../../packages/shared/src/runtime-layout.ts)
- [Application tests](../../tests/core/application), [desktop tests](../../tests/desktop), [packaging tests](../../tests/packaging)

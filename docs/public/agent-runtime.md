[English](agent-runtime.md) | [简体中文](agent-runtime.zh-CN.md) · [Documentation](README.md)

# Agent runtime

## The objects behind a conversation

Chats, Invoices and Deep Research keep AgentSession. [Personal Agent](personal-agent.md) uses Durable from the same Pi SDK 1.4.0 release and shares product services, tools, Workspace and Context. Each adapter owns its native history and recovery protocol.

| Object | Meaning |
|---|---|
| Session | Persistent product conversation with an explicit runtime owner |
| Session input | A particular accepted user input and its dispatch/consumption facts |
| Run | One bounded product execution with fixed configuration, scope and recorded outcome; existing states are `created`, `running`, `completed`, `failed`, `cancelled` |
| Native history / Task | AgentSession `SessionEntry`/history belongs to runtime-pi; Durable SDK-native Tasks/checkpoints belong to runtime-durable |
| InvoiceWork | A fixed invoice set and its continuing goal: `open`, `completed`, `cancelled` |
| InvoiceWorkItem | One invoice's explicit disposition: `unresolved`, `accepted`, `rejected`, `excluded` |
| Context snapshot/request | The saved basis for selected materials, workspace and the actual model request |
| ToolCall | One actual tool request, its arguments, execution, result, delivery and cleanup facts |
| Business artifact | A research source/Claim/report, invoice candidate or export with its own identity |

A Session can contain several Runs. A model's tool request is not itself a business commit. A ToolCall can have committed a candidate even if its response was lost or the Run subsequently failed. Query the original identities before deciding whether to retry.

Rejecting a candidate does not dispose of its invoice, and a failed or stopped execution does not cancel its Work. Stopped `open` Work requires explicit `continueWork`; `completed` or `cancelled` Work does not automatically revive. InvoiceWork coordinates committed business facts rather than introducing a general task system or an outer model goal loop.

## Input and execution flow

The sequence below describes AgentSession entry points. Personal Agent routes accepted Work commands to Durable submissions and native Tasks while reusing product tool admission and domain checks.

```mermaid
sequenceDiagram
  participant UI as Desktop
  participant App as Application
  participant Runtime
  participant Pi as Pi AgentSession
  participant Tools as ToolExecutor
  participant DB as Store
  UI->>App: Submit an owned Session input
  App->>DB: Accept input and retain identity
  App->>Runtime: Start with fixed configuration and Context
  Runtime->>Pi: Prepare messages, resources and allowed tools
  loop Within shared budget and deadline
    Pi->>Pi: Request selected model
    Pi->>Tools: Actual tool call with trusted context
    Tools->>Tools: Validate scope, arguments and budget
    Tools->>DB: Execute domain effect and save facts
    Tools-->>Pi: Bounded result or actionable diagnostic
  end
  Runtime->>DB: Save terminal outcome, history and stopping facts
  UI->>App: Query original Run and artifacts
```

Live events help the UI refresh. Saved state and tool evidence answer whether an operation was accepted, executed, committed or delivered. A reconnect or history query does not replay input.

<a id="context-memory-layers"></a>

## Context and resource boundaries

Flowmate separates the current working basis from saved conversation and research facts. These responsibilities have different lifetimes:

| Layer | Contents and lifetime |
|---|---|
| Workspace Context | Page focus, when supplied, and selected business references and authorized materials are captured with an accepted input. Changing the page does not rewrite that input's snapshot. |
| Conversation | User inputs, assistant messages, actual tool results and Pi history/compaction entries are persisted with the Session. |
| Runtime Session | The active Agent, cancellation, budgets and in-process execution exist while their owner runs; recovery uses saved facts, not a saved copy of the live process. |
| Research preferences | Text explicitly saved in **Settings → General → Research preferences** is captured with its settings revision for each research Run. A change affects a later Run, not one already running. |
| Research checkpoint | The confirmed plan, step executions, source identities and report facts are read from the ResearchTask and actual records; the checkpoint is a projection of those facts. |

For new AgentSession prompt, steer and follow-up inputs, the product saves the applicable focus and selected material basis in a Context Snapshot. Before a model request, the Pi adapter adds a request-local system section using that input's snapshot, the Run's captured preferences and, when applicable, the current saved research checkpoint. Automatically captured page state is not appended to the native user message or accumulated as conversation text. An explicit user message or expanded template remains part of the input. The saved snapshot and request binding allow the basis to be inspected in **Session details → Context**.

Historical records are not rewritten to remove earlier page content. Pi continues to own AgentSession history and compaction; request-local projection does not replace saved conversation history. Fill Form retains its frozen Workspace input path, and Personal Agent retains its separate Durable phase context. Research preference text and material content are untrusted data: they do not grant permissions or expand a task's authorized source scope. A model request may send this context to the selected provider.

Merely reading a material on the controller side is weaker evidence than showing it in the actual model request; neither proves semantic use by the model. Without an external memory connection, Flowmate does not extract long-term preferences from conversations.

The optional OpenViking connection is off by default. Existing Sessions and Works retain their original bindings and their histories are not uploaded automatically. Local and cloud environments use separate services, accounts, credentials and data; they do not sync automatically or use WeKnora's existing instance. New Sessions and Works can select OpenViking. Requests retrieve only authorized memories with sources and use them as untrusted request-local references, without replacing Pi history or Durable work facts. If the service is unavailable, external memory is reported as unavailable while existing business execution continues under its original authorization.

In **Settings → Connections → Long-term memory**, users can configure a local connection, choose recall and capture policies, explicitly save or forget memories, inspect original operations and search manually. The connection file supplies a loopback endpoint, account, user, peer and ordinary user key. The file is not automatically deleted; the key is separately saved in Windows secure storage. Administrator and Root keys are rejected for ordinary memory operations. Background service mode uses its own secure store and does not assume it can decrypt the desktop user's credentials.

**OpenViking management** on the same page uses a separate identity file. For a local connection, provide a loopback `endpoint`, `apiKey` and `role`. P also requires `accountId`, `userId` and `peerId`. A requires `accountId` and `userId`. S uses a system administrator key.

For cloud management, provide `kind: "cloud"`, `workspaceId`, `role` and a `target` with `host`, `port`, `username`, `privateKeyPath` and `knownHostsPath`. The desktop uses the dedicated SSH identity. Authority verifies the workspace, role and OpenViking identity and holds the OpenViking credential. See the [cloud service instructions](../../deploy/cloud/README.zh-CN.md) for the role setup.

Select an operation and enter its listed parameters as JSON. Uploads, downloads, private Options and issued user keys use native file dialogs. Cloud files travel in 256 KiB chunks, with a 256 MiB limit per file. To resume an upload, retry the original operation in the same desktop management connection. The desktop keeps the original file selection and resumes from the offset confirmed by Authority. **Check original target or resume file** resumes a download from its local staging file after reconnecting or reopening. Writes require native confirmation and retain an encrypted receipt for the management identity. Reconciliation uses the original operation or task. Abandoning reconciliation closes the local receipt, and the remote outcome may remain unknown.

Automatic capture requires separate consent and applies only to successful ordinary chat turns after it is enabled. Long-term memory follows its source runtime. AgentSession chats and Personal Agent Works each recall entries from their own authorized scope, even under the same identity. Older entries without a verifiable origin remain in the management list and are omitted from automatic recall. Invoice Work capture is manual and uses the original Work phase and selected scope. After a restart, writes with an unknown result retain their original operation for reconciliation. Disabling or forgetting prevents future authorized recall, while committed history and business results follow their existing retention rules. Changing the default backend affects new bindings. Forks and continued history branches use new remote Sessions. A fork inherits the original Session's currently valid Session-scoped memory grants.

AgentSession skips automatic OpenViking recall for inputs with recognizable credential markers, and skips automatic capture if any input or the final answer contains one. This check covers explicit markers such as labeled passwords and private key headers. Manual search and explicit saving continue to use the selected source and scope.

Search, explicit saving and extraction depend on the selected OpenViking service and its model services. Local memory work cannot run while WSL2 is stopped or the computer is asleep or powered off. A cloud connection requires separate Authority configuration; see the [cloud service instructions](../../deploy/cloud/README.zh-CN.md).

Resource refresh affects future selections, not historical run copies. Revoked material access or unusable native history can block continued model use while leaving saved facts inspectable. Automatic/native compaction and explicit Session compaction use the Pi history path; a displayed summary is not a replacement for missing committed history. Child Sessions cannot be manually compacted through the root Session operation.

These Session history/compaction operations remain AgentSession-owned. Durable keeps its own native Task, entry and checkpoint records; inspecting or recovering AgentSession history does not turn `SessionEntry` into a Durable checkpoint.

## Budgets and tool execution

Defaults are centralized in [runtime-config.ts](../../packages/contracts/src/runtime-config.ts). New Runs may use validated settings overrides; inspect the saved configuration for the actual values.

| Default | Value |
|---|---|
| Model requests, workspace / pure chat | 16 / 12 |
| Tool calls | 24 |
| Single-tool configured timeout | 10,000 ms |
| Run timeout, ordinary / save-candidate | 60,000 / 120,000 ms |
| Stop confirmation wait | 5,000 ms |
| Cumulative tool feedback capacity | 8 MiB in UTF-8 |
| Provider automatic retries | 0 |

These are product call/time/byte constraints, not invented model token capacities. Actual model context/output capabilities come from prepared model metadata. Before each model request, budget awareness can describe remaining calls/time, diagnostics and bounded tool experience; executor guards enforce the limits independently of prompt wording.

Tool admission validates trusted Run/Session context, allowed tools, material scope, cancellation and input schema. Post-execution checks validate result structure, domain effects, persistence and delivery. Eligible custom PURE/READ tool timing can use a bounded P95 strategy, with configured fallback when samples are insufficient or unsuitable. The configured limits and remaining Run time still constrain execution.

AgentSession children use separate Sessions/Runs; Durable children retain native Task ownership with product Run provenance. Both share their owner's model-call, tool-call and feedback budgets. AgentSession child admission reserves one root continuation request; Durable checks the remaining Work model budget without promising that reservation. At most four owned children are admitted, with no nesting; Personal Agent permits only the read-only `invoice-evidence-checker` role. Both paths' child-specific rules live in [Subagents](subagents.md).

## Stopping and recovery

Stop closes admission and requests cancellation, then waits for actual stopping, history and necessary persistence. Cancellation acceptance, a terminal status, `cleanup.stopped` and a confirmed stop timestamp are distinct facts. Unconfirmed execution is not a free concurrency slot.

When required stopping or saving cannot be confirmed, the selected runtime may become unusable until restart/recheck. Recovery checks original accepted work, retained evidence, permissions and budgets. AgentSession does not replay interrupted model/tool requests; Durable recovers only eligible native Tasks with original operation and receipt identities. An unknown write response should be resolved by querying its original operation/ToolCall rather than submitting a new identity.

Use Session Details/Context, Activity and Processing History to inspect the relevant Run. Confirmed stopping, local SDK execution and saved output do not prove semantic correctness; [Evaluation](EVALUATION.md) measures quality separately. Data backup and restore verification are covered in [Packaging and recovery](packaging-and-recovery.md).

## Source and tests

- [RuntimeService](../../packages/core/src/runtime/service.ts), [Session service](../../packages/core/src/sessions), [Context](../../packages/core/src/context)
- [Tool executor](../../packages/core/src/tools/executor.ts), [Pi Session adapter](../../packages/runtime-pi/src/session.ts), [Durable adapter](../../packages/runtime-durable/src/index.ts), [Personal Agent services](../../packages/core/src/personal-agent)
- [Lifecycle tests](../../tests/core/runtime), [cold-start recovery](../../tests/core/application/cold-start-recovery.integration.test.ts), [Context integration](../../tests/runtime-pi/context.integration.test.ts), [request-layer tests](../../tests/core/research/layered-context.integration.test.ts)

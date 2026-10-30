[English](getting-started.md) | [简体中文](getting-started.zh-CN.md) · [Documentation](README.md)

# Getting started

## Prepare the development environment

Use Windows x64, Bun **1.4.4**, Node.js **24**, and Git. The current engineering baseline uses Pi SDK **1.4.0** and data schema **22**. Dependency versions are pinned in [package.json](../../package.json) and [bun.lock](../../bun.lock); preserve the required [dependency patches](development.md#dependency-patches). A model endpoint and its credentials are needed for model operations, not for reading the UI or running engineering fixtures.

From the repository root:

```powershell
bun install --frozen-lockfile
bun run dev
```

The development launcher builds and opens Electron. Renderer updates support hot reload. Main/Preload changes go through shutdown and rebuild. End development with Ctrl+C and wait for closure; killing a process is not proof that its work stopped cleanly.

For a distributable installation, see [Packaging and recovery](packaging-and-recovery.md).

## Configure a model

1. Open **Models** or **Settings → LLM**.
2. Choose a Pi catalog provider/model, enter the API key and save. A **Custom model** also needs the actual Base URL, Pi API type and model capabilities.
3. Use **Test connection** to send an explicit connection request. Check provider diagnostics if it fails.
4. Select the saved model for a new conversation. Existing Runs keep their original configuration.

Match the API protocol to the service endpoint. An Anthropic-compatible URL needs its corresponding API type; entering an OpenAI-style protocol does not convert the endpoint. Model metadata and the provider's error remain authoritative.

Desktop credentials are stored using system encryption. Do not paste credentials into prompts or publish local settings. Evaluation does not inherit the desktop model or key; see [Evaluation configuration](EVALUATION.md#configuration).

## First conversation

Without a saved page focus, the application opens in the main conversation view; a valid saved focus can restore a previous page. Opening a view does not create a Session or request a model response.

1. After configuring the model, click **New chat** in the left navigation to create a Session and open the main conversation canvas.
2. Enter a small request such as “Summarize the following paragraph and identify what it does not establish,” followed by non-sensitive sample text.
3. Click **Send** in the main conversation. Watch the Run and response; use **Stop** if needed, then wait for actual stopping facts.
4. Open the conversation from recent chats in the left navigation or from **Chats** to return to the main canvas and inspect saved history. Viewing history does not start another model request.

On the existing invoice, research and settings pages, the conversation appears in the right-side Assistant. Switching presentations or collapsing and reopening that pane preserves the current Session draft in the window. **Chats**, **Invoices** and **Deep Research** retain their AgentSession workflows; see [UI system](UI-SYSTEM.md) for layout behavior. The independent **Personal Agent** entry uses Pi Durable for ongoing invoice work.

For local-file work, select the intended working directory or authorized material before sending and state the scope in the request. Available native tools may include file writes and shell commands. Directory selection sets a working location; it is not a filesystem sandbox.

## Start ongoing invoice work in Personal Agent

1. Open **Personal Agent** from the left navigation and confirm/save its model, tool and resource configuration. Then select a fixed set of existing parsed invoices, enter the goal and explicitly submit to create the persistent invoice work. This creation flow is available only in Personal Agent; **Invoices** keeps single-invoice selection and editing.
2. Inspect the work overview, per-invoice Todo items, candidates and source evidence. Supplement material for the relevant invoice or follow its review action back to **Invoices**.
3. Read the operation receipt to distinguish saved material, authorization to execute, an existing or new attempt, queueing and a blocked condition. Valid material after a normally completed attempt can automatically continue eligible work; material saved after a user stop or failure needs an explicit continue action.
4. Give each invoice an explicit final disposition: `accepted`, `rejected` or `excluded`. Ordinary **Reject** rejects a candidate; it does not end processing for that invoice. A candidate or a successful Run alone does not complete the work.

Viewing pages/history and desktop reconnection are read-only and make no model or tool calls; they do not trigger backend recovery. Backend startup recovery separately loads the original persisted facts and native records, then checks saved authorization and current eligibility before resuming an eligible original attempt. An `open` work item alone creates no new intent, and stopped or failed attempts are not revived. This engineering delivery covers verified behavior while the application is running; execution after desktop closure, Windows service restart recovery and Windows startup recovery remain system-service goals, with real SCM acceptance deferred. See [Personal Agent](personal-agent.md) for configuration, continuation and review details.

## Add capabilities deliberately

Use **Skills** or **Settings → Skills** to refresh resources, inspect missing dependencies and enable a version. New resources are disabled until selected. A Partial resource is not fully ready.

For independent checks in an AgentSession conversation, enable **Extensions → subagents**, inspect **Plugin details → Manage agents**, and start with the tool-free `general-analyst` role:

```text
/subagent general-analyst Compare these two proposed explanations using only the text supplied here: …
```

This command still requires the model to make a real `Agent` tool call. A command or template expanding successfully does not prove that a child executed. Personal Agent uses its own separately configured Durable `Agent` tool rather than this extension command. See [Subagents](subagents.md) for both paths, actual child records and failure handling.

## Next workflows and common issues

Use [Workflows](workflows.md) for research, single-invoice review and ongoing Personal Agent work. For [Deep Research](workflows.md#deep-research), optionally save **Settings → General → Research preferences**, then select local text/Markdown or registered parsed material, review and confirm the plan, and inspect **Research steps**. After interruption, **Continue research** is an explicit action when available. Invoice processing needs an original plus externally prepared parsing material; the app does not create that parsing itself.

| Symptom | First check |
|---|---|
| Connection test fails | API type, service URL, model identity and saved credential |
| Send is unavailable | Selected model, Host/Runtime readiness, active or unconfirmed stopping work |
| Skill is Partial | Its listed tool, Skill and extension dependencies |
| No child appears | Extension enabled, role available, actual `Agent` call and remaining budget |
| Research cannot continue | Confirmed plan, unfinished step status, runtime readiness and original stopping facts |
| Old conversation cannot continue | Saved history/material access may be unusable; read diagnostics before a new Run |

The default Windows data root is `%APPDATA%\Flowmate`, with SQLite at `data\app.sqlite`. Model requests send relevant content to the chosen service and may cost money. Test connection, Optimize, Send, Fill with Agent, research planning/execution and authorized Personal Agent execution can call a model. Opening pages and saving settings do not automatically do so.

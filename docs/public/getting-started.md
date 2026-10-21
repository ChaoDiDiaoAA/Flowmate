[English](getting-started.md) | [简体中文](getting-started.zh-CN.md) · [Documentation](README.md)

# Getting started

## Prepare the development environment

Use Windows x64, Bun **1.4.0**, Node.js **24**, and Git. Dependency versions are pinned in [package.json](../../package.json) and [bun.lock](../../bun.lock); preserve the two [dependency patches](development.md#dependency-patches). A model endpoint and its credentials are needed for model operations, not for reading the UI or running engineering fixtures.

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

The application opens in the main conversation view. Opening it does not create a Session or request a model response.

1. After configuring the model, click **New chat** in the left navigation to create a Session and open the main conversation canvas.
2. Enter a small request such as “Summarize the following paragraph and identify what it does not establish,” followed by non-sensitive sample text.
3. Click **Send** in the main conversation. Watch the Run and response; use **Stop** if needed, then wait for actual stopping facts.
4. Open the conversation from recent chats in the left navigation or from **Chats** to return to the main canvas and inspect saved history. Viewing history does not start another model request.

On business and settings pages, the conversation appears in the right-side Assistant. Switching presentations or collapsing and reopening that pane preserves the current Session draft in the window. Open **Invoices** or **Deep Research** for their business workflows; see [UI system](UI-SYSTEM.md) for layout behavior.

For local-file work, select the intended working directory or authorized material before sending and state the scope in the request. Available native tools may include file writes and shell commands. Directory selection sets a working location; it is not a filesystem sandbox.

## Add capabilities deliberately

Use **Skills** or **Settings → Skills** to refresh resources, inspect missing dependencies and enable a version. New resources are disabled until selected. A Partial resource is not fully ready.

For independent checks, enable **Extensions → subagents**, inspect **Plugin details → Manage agents**, and start with the tool-free `general-analyst` role:

```text
/subagent general-analyst Compare these two proposed explanations using only the text supplied here: …
```

This command still requires the model to make a real `Agent` tool call. A command or template expanding successfully does not prove that a child executed. See [Subagents](subagents.md) for setup, actual child cards and failure handling.

## Next workflows and common issues

Use [Workflows](workflows.md) for research and invoices. Research starts from selected local text/Markdown or registered parsed material. Invoice processing needs an original plus externally prepared parsing material; the app does not create that parsing itself.

| Symptom | First check |
|---|---|
| Connection test fails | API type, service URL, model identity and saved credential |
| Send is unavailable | Selected model, Host/Runtime readiness, active or unconfirmed stopping work |
| Skill is Partial | Its listed tool, Skill and extension dependencies |
| No child appears | Extension enabled, role available, actual `Agent` call and remaining budget |
| Old conversation cannot continue | Saved history/material access may be unusable; read diagnostics before a new Run |

The default Windows data root is `%APPDATA%\Flowmate`, with SQLite at `data\app.sqlite`. Model requests send relevant content to the chosen service and may cost money. Test connection, Optimize, Send, Fill with Agent, and research planning/execution can call a model. Opening pages and saving settings do not automatically do so.

[English](PRD.md) | [简体中文](PRD.zh-CN.md) · [Documentation](README.md)

# Product scope

## Purpose and audience

Flowmate gives a user one desktop workbench for a continuing conversation, work on selected local information, and reviewable structured results. It is useful when the user needs to inspect how an answer or candidate was produced and keep the relevant materials and execution history together.

The primary development and packaging target is Windows x64. Local-first describes persistence and control of local state: calling a remote model still sends request content to that provider.

## Main use cases

| Need | User path | Reviewable result |
|---|---|---|
| Ask about supplied information | Main conversation via New chat or saved chat, selected materials or working directory, Send | Conversation history, actual tool records and context basis |
| Investigate a question across local sources | Deep Research, plan, user confirmation, investigation | Saved sources, Claims, full or partial report with gaps |
| Extract and check an invoice | Invoices, existing parsed material, processing, review | Candidate versions, field evidence, explicit acceptance and export |
| Delegate an independent check | Enable subagents and select a registered role | Owned child Session/Run, actual output and stopping facts |
| Measure task behavior | Evaluation or CLI, dedicated models and dataset | Isolated Trials, execution evidence, scoring and review records |

Read [Workflows](workflows.md) for the steps and [Subagents](subagents.md) for delegation constraints.

The default view is the main conversation. **Chats** lists and manages saved Sessions; opening an entry or a recent chat returns to the main conversation. Business and settings pages retain a right-side Assistant. See [UI system](UI-SYSTEM.md) for layout and interaction rules.

## Functional boundaries

The workbench provides persistent Sessions; input and Context records; bounded Runs; platform-available Pi file and command tools; opt-in Skills and controlled extensions; research planning and evidence; and invoice review and export. The product distinguishes model output, tool execution, committed writes, delivery to the model, and user acceptance.

Deep Research currently reads authorized local text, Markdown and registered parsed documents. Online search and webpage extraction are unavailable. A plan is confirmed before investigation; a partial report may explicitly retain unresolved questions. Evidence location checks do not establish that an inference is semantically correct.

Invoice processing reads registered original and externally prepared parsed material. The Host does not run an invoice parser or OCR engine. A generated candidate, a successful form fill, a saved human edit and an accepted result have separate records. The user reviews the original, parsed source and field evidence before acceptance.

Subagents are foreground, read-only workers with at most four owned child executions. They share the parent budget and cannot create nested/background workers or perform business writes. Ordinary Assistant command tools may write or execute commands; a working directory is not an operating-system sandbox.

## Product behavior to preserve

1. Browsing history or reconnecting must not replay a model call or a previous side effect.
2. A stop request is distinct from confirmed stopping. Unconfirmed stopping or necessary persistence failures may block reuse.
3. A Run uses its selected configuration, authorized material scope and resource versions. Changing the current UI selection does not rewrite historical context.
4. The interface exposes missing evidence, rejected parameters and partial outcomes rather than treating them as a successful business delivery.
5. Engineering fixtures, real model quality, human review and installation/recovery validation are reported separately.

## Delivery and data

SQLite and managed files live beneath the product user-data root. Model credentials use the desktop's system-encrypted store; evaluation uses dedicated configuration. Explicit model operations can cost money. Optional Langfuse export is an explicit action, not a requirement for local execution.

This repository does not promise autonomous accounting submission, online research, universal provider compatibility, an OS sandbox, or successful recovery on another Windows account. See [Architecture](architecture.md), [Evaluation](EVALUATION.md), and [Packaging and recovery](packaging-and-recovery.md) for the implementation boundaries.

## Implementation references

- [Application composition](../../apps/composition.ts) and [public runtime contracts](../../packages/contracts/src/runtime.ts)
- [Research contracts](../../packages/contracts/src/research.ts) and [research UI](../../apps/desktop/renderer/src/research.tsx)
- [Invoice package](../../packages/employee-invoice/src) and [engineering test guide](../../tests/README.md)

[English](README.md) | [简体中文](README.zh-CN.md)

# Flowmate documentation

Flowmate is a local-first Agent desktop workbench built on the Pi SDK. It combines persistent conversations, authorized local-material work, evidence-based research, and invoice review. These pages describe the implementation in this repository; they are not a claim of model quality or release certification.

## Start here

For users: [Getting started](getting-started.md) → [Workflows](workflows.md) → [Skills and extensions](skills-and-extensions.md). Read [Subagents](subagents.md) before asking the Agent to delegate work, and [Packaging and recovery](packaging-and-recovery.md) before moving local data.

For developers: [Product scope](PRD.md) → [Architecture](architecture.md) → [Agent runtime](agent-runtime.md) → [Subagents](subagents.md) → [Development](development.md). Use [Evaluation](EVALUATION.md) to distinguish engineering checks from real model trials.

## Topics

| Topic | What it answers |
|---|---|
| [Product scope](PRD.md) | Who the workbench serves, its workflows and current limits |
| [Getting started](getting-started.md) | Development startup, model configuration and first conversation |
| [Architecture](architecture.md) | Electron, Bun Host, package responsibilities and data flow |
| [Agent runtime](agent-runtime.md) | Session, Run, Context, tools, budgets, stopping and recovery |
| [Subagents](subagents.md) | Role setup, delegation, parent/child ownership and lifecycle |
| [Workflows](workflows.md) | Local questions, Deep Research and invoice review from input to delivery |
| [Skills and extensions](skills-and-extensions.md) | Resource discovery, readiness, templates and controlled extensions |
| [Evaluation](EVALUATION.md) | Datasets, independent Judge, reports, regressions and Langfuse |
| [UI system](UI-SYSTEM.md) | Layout, observable states, interaction and accessibility conventions |
| [Development](development.md) | Repository structure, test commands and required dependency patches |
| [Packaging and recovery](packaging-and-recovery.md) | Windows packages, data roots, diagnostics, backup and restore verification |

## Reading the evidence

Source and test links identify implementation and verification entry points. A test file's existence does not mean that it passed in your environment. A completed Run, a saved business artifact and a quality pass are separate facts. Follow the saved Run, tool call and artifact identities when investigating a result.

English files use `.md`; Chinese counterparts use `.zh-CN.md`. Each page links to the other language. Local implementation notes and evaluation records are not dependencies of this public documentation.

Topic-oriented navigation, diagrams and explicit capability boundaries were informed by [Folio's documentation](https://github.com/helsome/folio/tree/main/docs). Flowmate's behavior and technical details are documented from its own source.

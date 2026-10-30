[English](README.md) | [简体中文](README.zh-CN.md)

# Flowmate documentation

Flowmate is a local-first Agent desktop workbench built on the Pi SDK. It combines persistent conversations, authorized local-material work, evidence-based research, invoice review, and an independent **Personal Agent** for ongoing invoice work. **Chats**, **Invoices** and **Deep Research** continue to use AgentSession; Personal Agent uses Pi Durable. These pages describe the implementation in this repository; they are not a claim of model quality or release certification.

This engineering delivery covers verified capabilities while the application is running. Continued execution after the desktop closes and recovery at Windows startup remain system-service goals; real Windows SCM acceptance is deferred, so those system behaviors are not yet verified.

## Start here

For users: [Getting started](getting-started.md) → [Workflows](workflows.md) → [Skills and extensions](skills-and-extensions.md). Read [Subagents](subagents.md) before asking the Agent to delegate work, and [Packaging and recovery](packaging-and-recovery.md) before moving local data.

For ongoing invoice work, open **Personal Agent** and follow [the invoice-work workflow](workflows.md#personal-agent): select a fixed set of parsed invoices, track per-invoice Todo items, supplement material and review candidates until every invoice has an explicit final disposition.

For developers: [Product scope](PRD.md) → [Architecture](architecture.md) → [Agent runtime](agent-runtime.md) → [Subagents](subagents.md) → [Development](development.md). Use [Evaluation](EVALUATION.md) to distinguish engineering checks from real model trials.

## Topics

| Topic | What it answers |
|---|---|
| [Product scope](PRD.md) | Who the workbench serves, its workflows and current limits |
| [Getting started](getting-started.md) | Development startup, model configuration, first conversation and Personal Agent entry |
| [Architecture](architecture.md) | Electron, Bun Host, package responsibilities and data flow |
| [Agent runtime](agent-runtime.md) | Session, Run, Context, tools, budgets, stopping and recovery |
| [Subagents](subagents.md) | Role setup, delegation, parent/child ownership and lifecycle |
| [Workflows](workflows.md) | Local questions, Deep Research, single-invoice review and ongoing Personal Agent work |
| [Skills and extensions](skills-and-extensions.md) | Resource discovery, readiness, templates and controlled extensions |
| [Evaluation](EVALUATION.md) | Purpose, traces, scoring, dual-model Smoke/Full and Baseline/Gate |
| [Benchmark authoring](EVALUATION-BENCHMARK.md) | Real-source candidates, independent Gold, validation and versioned publication |
| [UI system](UI-SYSTEM.md) | Layout, observable states, interaction and accessibility conventions |
| [Development](development.md) | Repository structure, test commands and required dependency patches |
| [Packaging and recovery](packaging-and-recovery.md) | Windows packages, data roots, diagnostics, backup and restore verification |

## Reading the evidence

Source and test links identify implementation and verification entry points. A test file's existence does not mean that it passed in your environment. A completed Run, a saved business artifact and a quality pass are separate facts. Follow the saved Run, tool call and artifact identities when investigating a result.

English files use `.md`; Chinese counterparts use `.zh-CN.md`. Each page links to the other language. Local implementation notes and evaluation records are not dependencies of this public documentation.

Topic-oriented navigation, diagrams and explicit capability boundaries were informed by [Folio's documentation](https://github.com/helsome/folio/tree/main/docs). Flowmate's behavior and technical details are documented from its own source.

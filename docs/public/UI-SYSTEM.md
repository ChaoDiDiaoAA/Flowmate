[English](UI-SYSTEM.md) | [简体中文](UI-SYSTEM.zh-CN.md) · [Documentation](README.md)

# UI system

## Workbench structure

The React Renderer uses shared CSS variables and ordinary form elements. Its main layout is navigation, central work area and Assistant. Implementation lives in [app.tsx](../../apps/desktop/renderer/src/app.tsx), [styles.css](../../apps/desktop/renderer/src/styles.css) and topic components in that directory.

| Area | Purpose |
|---|---|
| Invoices / Workspace | Original/parsed/result review and material/candidate context |
| Processing History | Saved processing Runs and business outcomes |
| Chats | Persistent conversations and Session management |
| Deep Research | Plan, Evidence, Report and associated Assistant |
| Activity | Runtime events and actual tool evidence |
| Models | Provider/model setup and explicit connection checks |
| Evaluation | Dedicated configuration, execution and saved quality results |
| Prompts / Skills / Extensions | Resource selection, readiness and controlled capabilities |
| Settings | User/theme, model and runtime preferences |

## Layout and themes

The resizable layout prefers navigation 240 px and Assistant 380 px, with minima 200/300 px and a central minimum of 360 px where expanded layout applies. Responsive rules at 1200/1080 px adapt panes; hidden/collapsed widths do not overwrite expanded preferences.

Two pointer-capture separators support dragging, double-click reset, Left/Right steps of 10 px (50 with Shift), and Home reset. `flowmate.panel-widths` is optional UI state; invalid/unavailable localStorage falls back to defaults. Explicit resizing keeps the other visible pane stable. See [panel-layout.tsx](../../apps/desktop/renderer/src/panel-layout.tsx).

Light, dark and system themes use shared background, surface, text, border, accent, positive, warning and negative variables. Font stacks distinguish general text, headings and numeric values. Reuse existing variables rather than page-specific colors. Theme and pane preferences are not business execution state.

## State and interaction

- Browsing pages/history and refreshing tools is observational; it does not imply Send or model execution.
- Input belongs to a specific Session/context. Late replies must not attach an old workspace or result to a new selection.
- Send, Stop, Fill with Agent, Save, Accept and Export are distinct operations. Visible field values do not prove a committed candidate.
- Loading, errors, missing evidence, unavailable history and unconfirmed stopping retain their meanings; a missing reply is not success or permission for a new execution.
- Unsaved invoice edits stay in memory; Save/Discard is explicit when leaving.
- Long work exposes parent Run, actual child cards, tools and saved identities. Assistant prose is not an execution receipt.

Child cards show actual lifecycle and single-child Stop; details live in [Subagents](subagents.md). Delivery states are described in [Workflows](workflows.md).

## Accessibility conventions and limits

Keep native buttons, inputs, textareas, selects and semantic headings. Existing controls provide visible keyboard focus; pane separators have a focus target, orientation, accessible label and current/min/max values. Preserve keyboard behavior for menus/selects/resizing, meaningful labels, disabled/busy states and textual errors rather than color alone.

Reuse existing field/notice patterns. Name the affected operation without exposing credentials or raw private payloads. These conventions and controlled Electron tests do not constitute an assistive-technology or WCAG conformance audit.

Verification entry points: [layout tests](../../tests/desktop/panel-layout.unit.test.ts), [theme E2E](../../tests/desktop/theme.e2e.test.ts), [Subagent E2E](../../tests/desktop/subagents.e2e.test.ts), [form E2E](../../tests/desktop/invoice-form.e2e.test.ts), [test guide](../../tests/README.md). Their existence does not imply every viewport, screen reader or OS configuration has been verified.

[English](UI-SYSTEM.md) | [简体中文](UI-SYSTEM.zh-CN.md) · [Documentation](README.md)

# UI system

## Workbench structure

The React Renderer uses shared CSS variables and ordinary form elements. It opens with navigation and a main conversation canvas. Most business and settings pages show their work area with Assistant on the right; Personal Agent uses a separate main workspace without that sidebar. The same conversation component serves the main and sidebar presentations. Implementation lives in [app.tsx](../../apps/desktop/renderer/src/app.tsx), [styles.css](../../apps/desktop/renderer/src/styles.css) and topic components in that directory.

| Area | Purpose |
|---|---|
| Main conversation | Default view for composing messages and reading the selected conversation |
| Personal Agent | Assistant configuration, saved invoice Work, per-invoice Todo and disposition, attempts, history and timeline |
| Invoices / Workspace | Original/parsed/result review and material/candidate context |
| Processing History | Saved processing Runs and business outcomes |
| Chats / recent chats | List/manage saved Sessions or open one in the main conversation canvas |
| Deep Research | Plan, Evidence, Report and associated Assistant |
| Activity | Runtime events and actual tool evidence |
| Models | Provider/model setup and explicit connection checks |
| Evaluation | Dedicated configuration, execution and saved quality results |
| Prompts / Skills / Extensions | Resource selection, readiness and controlled capabilities |
| Settings | User/theme, model and runtime preferences |

**New chat** creates a Session and opens the main conversation. Opening a recent chat or an entry in **Chats** also returns to that canvas. The global **Evaluation** entry remains available in both the conversation and business views.

## Layout and themes

The main conversation and Personal Agent workspace use the space beside navigation without a separate Assistant column or Assistant separator. The main conversation cannot be collapsed. On wide business pages with a sidebar, the layout prefers navigation 240 px and Assistant 380 px, with minima 200/300 px and a central minimum of 360 px. Assistant can be collapsed there.

Below 1200 px, navigation becomes a 64 px rail with an expandable drawer. Below 1080 px, an open sidebar Assistant overlays the business page; the main conversation remains in the page layout.

The navigation separator appears at widths of at least 1200 px. The Assistant separator appears only for an expanded sidebar Assistant at widths of at least 1080 px. Visible separators use pointer capture and support dragging, double-click reset, Left/Right steps of 10 px (50 with Shift), and Home reset. `flowmate.panel-widths` is optional UI state; invalid/unavailable localStorage falls back to defaults. Explicit resizing keeps the other visible pane stable; switching presentations or collapsing a pane preserves its expanded width preference. See [panel-layout.tsx](../../apps/desktop/renderer/src/panel-layout.tsx).

Light, dark and system themes use shared background, surface, text, border, accent, positive, warning and negative variables. Text and headings share the system font stack; numeric values use a monospace stack. Reuse existing variables rather than page-specific colors. Theme and pane preferences are not business execution state.

## State and interaction

- Browsing pages/history and refreshing tools is observational; it does not imply Send or model execution.
- Opening the default conversation view alone does not create a Session or start a Run. **New chat** creates the Session; sending input is a separate operation.
- Drafts belong to their Session. Switching between the main conversation and sidebar, or collapsing and reopening Assistant, preserves the current draft in the window.
- Input belongs to a specific Session/context. Late replies must not attach an old workspace or result to a new selection.
- Send, Stop, Fill with Agent, Save, Accept and Export are distinct operations. Visible field values do not prove a committed candidate.
- Loading, errors, missing evidence, unavailable history and unconfirmed stopping retain their meanings; a missing reply is not success or permission for a new execution.
- Unsaved invoice edits stay in memory; Save/Discard is explicit when leaving.
- Long work exposes parent Run, actual child cards, tools and saved identities. Assistant prose is not an execution receipt.
- Personal Agent separates the current attempt's Stop, Continue work and Cancel entire work; the Invoices, Tasks, History and Timeline tabs expose different saved facts. See [Personal Agent](personal-agent.md).

Child cards show actual lifecycle and single-child Stop; details live in [Subagents](subagents.md). Delivery states are described in [Workflows](workflows.md).

## Accessibility conventions and limits

Keep native buttons, inputs, textareas, selects and semantic headings. Existing controls provide visible keyboard focus; pane separators have a focus target, orientation, accessible label and current/min/max values. Preserve keyboard behavior for menus/selects/resizing, meaningful labels, disabled/busy states and textual errors rather than color alone.

Reuse existing field/notice patterns. Name the affected operation without exposing credentials or raw private payloads. These conventions and controlled Electron tests do not constitute an assistive-technology or WCAG conformance audit.

Verification entry points: [workbench interaction E2E](../../tests/desktop/ui-workbench.e2e.test.ts), [layout tests](../../tests/desktop/panel-layout.unit.test.ts), [layout E2E](../../tests/desktop/panel-layout.e2e.test.ts), [theme E2E](../../tests/desktop/theme.e2e.test.ts), [Subagent E2E](../../tests/desktop/subagents.e2e.test.ts), [form E2E](../../tests/desktop/invoice-form.e2e.test.ts), [test guide](../../tests/README.md). Their existence does not imply every viewport, screen reader or OS configuration has been verified.

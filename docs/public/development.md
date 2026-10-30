[English](development.md) | [简体中文](development.zh-CN.md) · [Documentation](README.md)

# Development

## Environment and entry points

Use Windows x64, Node.js 24 and Bun 1.4.4. The manifests pin Pi SDK 1.4.0 and the Durable adapter's `pi-durable` 1.4.0, as well as pi-subagents 0.19.0, Electron 44.4.5, React 19.3.0 and TypeScript 5.8.3. From the repository root:

```powershell
bun install --frozen-lockfile
bun run dev
```

The Node development launcher owns initial build/readiness, Electron lifetime and Main/Preload restart. Renderer uses hot updates. Close the current process cleanly before replacing its owned runtime; a killed process is not a verified application shutdown.

## Source organization

Read [Architecture](architecture.md) for boundaries. `apps/composition.ts` and `apps/personal-agent.ts` assemble shared product services. `apps/desktop` is the UI/process shell, `apps/host` the local Bun protocol owner and `apps/service` the independent ServiceOwner. `packages/runtime-pi` retains AgentSession for Chats/Invoices/Deep Research; `packages/runtime-durable` owns Personal Agent native Tasks and recovery. Both reuse Application, ToolExecutor, Workspace, Context and coordinated SQLite storage. Other packages separate contracts, materials, invoice rules, logging and shared paths/security. `resources/` contains author resources, `tests/` engineering checks and `agent-eval/` isolated quality infrastructure.

For behavior changes, trace input through the contract, public Application/Host/Preload boundary, Runtime/adapter and relevant storage/domain consumer. Keep model-selected tools inside the product executor. Durable Work entry points are in [Personal Agent](personal-agent.md); parent/child implementation entry points are collected in [Subagents](subagents.md#developer-map-and-verification).

## Engineering checks

```powershell
bun --no-env-file run typecheck
bun --no-env-file run test:unit
bun --no-env-file run test:integration
bun --no-env-file run build:desktop
bun --no-env-file run test:e2e
```

`bun --no-env-file run test` runs typecheck → Unit → Integration → desktop build → Electron E2E. Discovery uses `.unit.test.ts`, `.integration.test.ts` and `.e2e.test.ts`. Unit/Integration use isolated Bun tests; Electron uses the installed Node/Playwright path with one worker.

For focused debugging:

```powershell
bun --no-env-file test --isolate ./tests/core/storage/storage.integration.test.ts
```

Engineering fixtures use temporary roots and controlled providers, not formal user data or real model Benchmark runs. See [tests/README.md](../../tests/README.md) and [evaluation facility tests](../../agent-eval/tests/README.md) for coverage and cleanup. Do not run paid evaluation incidentally; [Evaluation](EVALUATION.md) explains its separate configuration and costs.

Report the actual command, revision, pass/fail and skipped cases for each engineering run; an earlier result does not certify a later revision. Real SCM installation/startup, boot, upgrade/rollback and execution after desktop closure are separate, deferred acceptance; real model semantics and user benefit require their own evidence.

<a id="dependency-patches"></a>

## Dependency patches

The root `patchedDependencies` and lockfile reference:

- `patches/@earendil-works%2Fpi-coding-agent@1.4.0.patch`
- `patches/@tintinweb%2Fpi-subagents@0.19.0.patch`

Pi integration relies on managed Session/tool/history hooks and the controlled child path provided by these patches. They are required installation/runtime inputs. Deleting a patch but keeping its manifest/lock reference breaks installation; deleting the reference without replacing its consumer can break runtime guarantees. Update dependency, patch and consumers together, then verify affected actual adapter/product tests.

Files under [licenses](../../licenses) are copied by [scripts/package.ts](../../scripts/package.ts). Preserve them along with required SDK/native assets. Package generation does not certify installation, upgrade or recovery; see [Packaging and recovery](packaging-and-recovery.md).

## Documentation and Git scope

Public topics use `docs/public/`, English `.md` and Chinese `.zh-CN.md` pairs with language links. Update both when behavior changes. Links must resolve within the published repository; a developer-only local file is not a public dependency.

Internal evaluation, plan, prompt and specification directories are ignored by exact root rules. `.zread/` and analysis caches remain excluded. Do not force-add them or merge pre-cleanup history to synchronize an old clone; make a fresh clone after remote history replacement. Test-data provenance strings are distinct from active document navigation.

GitHub-readable Markdown and Mermaid need no documentation-site framework or build dependency.

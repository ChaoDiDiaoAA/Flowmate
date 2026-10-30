[English](packaging-and-recovery.md) | [简体中文](packaging-and-recovery.zh-CN.md) · [Documentation](README.md)

# Packaging and recovery

## Build a Windows package

The installed target is **Windows x64**, built with Bun **1.4.4** and pinned dependencies. The packager checks Pi SDK 1.4.0, pi-subagents 0.19.0, Electron 44.4.5, schema 21 migrations, native tools and required assets. The Durable adapter's manifest separately pins `pi-durable` 1.4.0; the package's release inventory does not by itself certify real service recovery.

```powershell
bun install --frozen-lockfile
bun --no-env-file run package:dir
# Or build the NSIS installer:
bun --no-env-file run package:win
```

The scripts build the desktop and stage runtime resources under `out/package-stage/`. Electron-builder writes to `out/package/` with publishing disabled. NSIS is per-user, allows an installation directory choice, does not auto-run after installation and does not delete app data on uninstall.

The runtime includes Bun, Host/evaluation/maintenance launchers, ServiceOwner/service-management entries, WinSW, both Pi runtime paths, migrations, author resources, required native files and licenses. `release.json` records explicit versions and the file inventory. Installed validation checks actual inventory/versions and does not fall back to developer source or PATH Bun. Preserve required patches/licenses; see [Development](development.md#dependency-patches).

Application-running execution, committed facts and eligible recovery define the current delivery boundary. Real SCM installation/startup, boot, upgrade/rollback and continued execution after closing the desktop remain deferred acceptance. [Personal Agent](personal-agent.md) explains the separate local Host and ServiceOwner paths.

## Data and diagnostics

Default data root: `%APPDATA%\Flowmate`. Installation files and writable product data are separate.

| Relative location | Purpose |
|---|---|
| `data/app.sqlite` | Sessions, Runs, inputs, Context, invoice Work and Durable native records under one coordinated owner |
| `data/settings.json`, `data/installed-release.json` | Settings and installed release record |
| `service-installation.json` | Service installation and explicit activation selection |
| `artifacts/`, `outputs/` | Managed materials and delivered files |
| `runtime/resource-bundles/`, `runtime/subagents/` | Original Run resources and user roles |
| `security/credentials/`, `Local State` | Encrypted credential envelopes and Electron key material |
| `security/service-credentials/` | CurrentUser DPAPI service credentials and staged operation receipts |
| `imports/invoices/` | Installed invoice import source |
| `evaluation/agent-eval/runs/` | Installed local evaluation results |
| `logs/` | Runtime diagnostics |

Use Models/Settings diagnostics for provider/runtime readiness, Activity for actual events/tools, and Processing History or Session details for saved facts. `installation_runtime_invalid` and `installation_dependency_missing` require checking the package; a source-tree fallback is not a repair path.

Missing replies and unconfirmed stopping do not prove an operation had no effect. Retain original Run/ToolCall/operation IDs and query before retrying. See [Runtime](agent-runtime.md) and [Subagents](subagents.md).

## Offline backup

Close Flowmate and confirm that any ServiceOwner or other controller of the target root has stopped; a closed desktop window alone does not establish that its controller has exited. Maintenance acquires the controller lease, checks storage, checkpoints the database and verifies copied persistent files. The absolute destination must not exist, and its parent must exist. Copying only a live SQLite file does not ensure consistent WAL/associated files.

This is an **installed-runtime** template. Replace placeholders with actual absolute locations; do not use the developer source entry:

```powershell
$runtime = '<absolute installation resources path>\flowmate-runtime'
$userData = Join-Path $env:APPDATA 'Flowmate'
$backup = '<absolute new backup directory>'
& (Join-Path $runtime 'bin\bun.exe') --no-env-file (Join-Path $runtime 'apps\maintenance.js') backup --user-data-root $userData --destination $backup
```

Inspect JSON `result`, `leaseRelease`, exit status and `gaps`. The manifest lists copied paths/byte lengths. Selected persistent data, service installation selection, encrypted credentials, staged service-credential receipts and Local State are retained; this is not a mirror of every file under the root. Logs, `.env` secrets, external source directories and external evaluation datasets are outside a complete-backup promise; preserve necessary external material separately.

Credentials still depend on the Windows account/system encryption context. Encrypted envelopes and Local State do not guarantee portability to another account or machine.

## Restore and verification boundaries

The CLI offers `backup` and **`verify-restore`**, not an automatic restore command.

1. Keep the original store and backup unchanged. Close controllers and choose a separate offline restore root.
2. Restore the manifest-listed persistent files with relative layout, including required data, managed artifacts/resources and encrypted key material. Use a matching program/version; do not connect an old program to an upgraded store.
3. Verify the restored root against the original backup using the packaged tool:

```powershell
$restoredRoot = '<absolute restored user-data directory>'
& (Join-Path $runtime 'bin\bun.exe') --no-env-file (Join-Path $runtime 'apps\maintenance.js') verify-restore --user-data-root $restoredRoot --backup $backup
```

4. Inspect readability, compatibility and gaps. `runtimeValidation: pending` means file/reference verification has not checked live execution. Check credential access under the intended account, then explicitly start a safe new Run only after accepting the restored store for use.

The verifier compares the restored persistent set/content and references to the manifest and checks schema/settings compatibility. An activated service selection requires its original SQLite database; a missing database is rejected rather than replaced with an empty store. Verification does not copy files, replay old calls, repair historical gaps, prove model access or certify business quality. A changed installed release triggers a pre-upgrade backup before opening/migrating state. Failure retains original data rather than claiming successful recovery.

## Source and verification

[Packaging script](../../scripts/package.ts), [builder configuration](../../electron-builder.yml), [runtime layout](../../packages/shared/src/runtime-layout.ts), [maintenance CLI](../../apps/maintenance/main.ts), [storage maintenance](../../packages/core/src/storage/maintenance.ts), [packaging tests](../../tests/packaging), [maintenance integration](../../tests/core/storage/maintenance.integration.test.ts).

Build output, installation, upgrade, backup readability, credential recovery and a working new Run are separate checks. A package file or controlled test alone does not prove them all.

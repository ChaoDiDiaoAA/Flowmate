import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { REPO_ROOT } from '../dataset-loader/local.ts';
import { writeInvoiceInputs, type SelectedInvoice } from './invoice-materials.ts';
import type { SelectedResource } from './selected-resources.ts';
import { ExtensionEvaluationProfileSchema, type ExtensionEvaluationProfile } from '../../../packages/contracts/src/extensions.ts';
import { CaseEvaluationFaultProfileSchema, type CaseEvaluationFaultProfile } from '../../../packages/contracts/src/runtime-evaluation.ts';
import { PackagedReleaseSchema } from '@flowmate/shared';
import type { EvaluationRuntime } from '../execution/source.ts';
import { getToolPath } from '@earendil-works/pi-coding-agent';

/** Each Trial owns its local process and data; this is not an OS filesystem sandbox. */
export function prepareLocalHost(repo: string, directory: string, invoices: SelectedInvoice[] = [], extensionProfile?: ExtensionEvaluationProfile,
    caseFaultProfile?: CaseEvaluationFaultProfile, resources: SelectedResource[] = [], runtime?: EvaluationRuntime) {
    const profile = extensionProfile === undefined ? undefined : ExtensionEvaluationProfileSchema.parse(extensionProfile);
    const caseProfile = caseFaultProfile === undefined ? undefined : CaseEvaluationFaultProfileSchema.parse(caseFaultProfile);
    if (profile && caseProfile) throw Error('Only one evaluation fault profile may be configured');
    const root = realpathSync(runtime ? runtime.mode === 'installed' ? runtime.layout.runtimeRoot : runtime.repository
        : existsSync(join(repo, 'apps/host/main.ts')) ? repo : REPO_ROOT);
    const runtimeRoot = join(realpathSync(directory), 'runtime'), productRoot = join(realpathSync(directory), 'product');
    mkdirSync(runtimeRoot); mkdirSync(productRoot);
    const invoiceSourceRoot = join(runtimeRoot, 'invoice-input');
    writeInvoiceInputs(invoiceSourceRoot, invoices);
    const files: string[] = [];
        function copyTree(source: string, target: string, allowed: (file: string) => boolean) {
        const boundary = realpathSync(source);
        function copy(file: string, destination: string) {
            const stat = lstatSync(file), rel = relative(boundary, realpathSync(file));
            if (stat.isSymbolicLink() || isAbsolute(rel) || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../'))
                throw Error('Local Host assets cannot contain links or escape their source');
            if (stat.isDirectory()) {
                mkdirSync(destination, { recursive: true });
                for (const name of readdirSync(file).sort()) copy(join(file, name), join(destination, name));
            }
            else if (stat.isFile() && allowed(file)) {
                mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, readFileSync(file), { flag: 'wx' });
                files.push(relative(runtimeRoot, destination).replaceAll('\\', '/'));
            } else if (!stat.isFile()) throw Error('Unsupported local Host asset');
        }
        copy(source, target);
    }
    const installed = runtime?.mode === 'installed' ? runtime : null;
    const codeRoot = installed ? join(runtimeRoot, 'flowmate-runtime') : runtimeRoot;
    const selected = new Set(resources.map(r => `${r.ref.kind === 'skill' ? 'skills' : 'prompts'}/${r.ref.id}/`));
    if (installed) {
        for (const file of installed.release.files) {
            if (file.startsWith('resources/') && [...selected].some(prefix => file.startsWith('resources/' + prefix))) continue;
            copyTree(join(root, file), join(codeRoot, file), () => true);
        }
    } else {
    const entry = join(runtimeRoot, 'apps/host.js'); mkdirSync(dirname(entry));
    execFileSync(process.env.FLOWMATE_BUN_EXECUTABLE?.trim() || 'bun', ['--no-env-file', 'build', 'apps/host/main.ts', '--target=bun', '--outfile', entry],
        { cwd: root, timeout: 30000, windowsHide: true, stdio: 'pipe' });
    files.push('apps/host.js');
    for (const name of ['rg', 'fd'] as const) {
        const tool = getToolPath(name);
        const path = tool && (isAbsolute(tool) ? tool : execFileSync(process.env.FLOWMATE_BUN_EXECUTABLE?.trim() || 'bun',
            ['--no-env-file', '-e', 'process.stdout.write(Bun.which(process.argv[1])??"");', '--', tool],
            { cwd: root, encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim());
        if (path) copyTree(path, join(runtimeRoot, 'bin', name + (process.platform === 'win32' ? '.exe' : '')), () => true);
    }
    const sourceResources = join(root, 'resources');
    copyTree(sourceResources, join(runtimeRoot, 'resources'), file => {
        const rel = relative(sourceResources, file).replaceAll('\\', '/');
        return /\.(md|json)$/.test(file) && ![...selected].some(prefix => rel.startsWith(prefix));
    });
    }
    for (const resource of resources) for (const file of resource.files) {
        const destination = join(codeRoot, 'resources', resource.ref.kind === 'skill' ? 'skills' : 'prompts', resource.ref.id, file.path);
        const rel = relative(join(codeRoot, 'resources'), destination);
        if (isAbsolute(rel) || rel.startsWith('..')) throw Error('Selected resource escaped');
        mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, file.bytes, { flag: 'wx' });
        files.push(relative(runtimeRoot, destination).replaceAll('\\', '/'));
    }
    if (installed) {
        const release = PackagedReleaseSchema.parse({ ...installed.release,
            files: files.map(file => relative(codeRoot, join(runtimeRoot, file)).replaceAll('\\', '/')).sort() });
        writeFileSync(join(codeRoot, 'release.json'), JSON.stringify(release), { flag: 'wx' });
    } else {
    copyTree(join(root, 'packages/core/src/storage/migrations'), join(runtimeRoot, 'apps/migrations'), f => f.endsWith('.sql'));
    const sdk = realpathSync(join(root, 'node_modules/@earendil-works/pi-coding-agent'));
    copyTree(join(sdk, 'dist/modes/interactive/theme'), join(runtimeRoot, 'sdk/dist/modes/interactive/theme'), f => f.endsWith('.json'));
    writeFileSync(join(runtimeRoot, 'sdk/package.json'), readFileSync(join(sdk, 'package.json')), { flag: 'wx' });
    const launcher = join(runtimeRoot, 'apps/start.js');
    // Evaluation credentials arrive through Host IPC, never inherited provider environments.
    writeFileSync(launcher, `const allowed=new Set(['PATH','Path','SystemRoot','SYSTEMROOT','COMSPEC','PATHEXT','TEMP','TMP','WINDIR','BUN_INSTALL','PI_OFFLINE','FLOWMATE_DESKTOP_VERSION']);\nfor(const name of Object.keys(process.env))if(!allowed.has(name))delete process.env[name];\nprocess.env.PI_PACKAGE_DIR=${JSON.stringify(join(runtimeRoot,'sdk'))};\nprocess.env.HOME=${JSON.stringify(join(productRoot,'runtime'))};\nprocess.env.USERPROFILE=process.env.HOME;\nawait import('./host.js');\n`, { flag: 'wx' });
    }
    const launcher = installed ? join(codeRoot, 'apps/start-host.js') : join(runtimeRoot, 'apps/start.js');
    const launch = { executable: installed ? installed.layout.bunExecutable : process.env.FLOWMATE_BUN_EXECUTABLE?.trim() || 'bun', args: ['--no-env-file', launcher,
        '--user-data-root', productRoot, '--invoice-source-root', invoiceSourceRoot,
        ...(profile ? ['--eval-extension-profile', JSON.stringify(profile)] : []),
        ...(caseProfile ? ['--eval-case-fault-profile', JSON.stringify(caseProfile)] : [])] };
    return { launch, runtimeRoot, productRoot, invoiceSourceRoot,
        manifest: { contract: 'flowmate-local-host/v1', kind: 'local-process', filesystemSandbox: false, runtimeRoot, productRoot, files: files.sort() } };
}

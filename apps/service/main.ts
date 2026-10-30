import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServiceOwner } from './owner.ts';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--installation-file' || !args[1] || !isAbsolute(args[1])) {
  process.stderr.write('[Flowmate] service_arguments_invalid\n'); process.exitCode = 2;
} else {
  const runtimeRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const opened = await createServiceOwner({ installationFile: args[1], runtimeRoot });
  if (!opened.ok) { process.stderr.write('[Flowmate] ' + opened.error.code + '\n'); process.exitCode = 2; }
  else {
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      while (true) {
        const report = await opened.data.close();
        if (report.ok && report.data.stopped && report.data.closed) { process.exitCode = 0; break; }
        process.stderr.write('[Flowmate] service_stop_unconfirmed\n');
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    };
    process.on('SIGINT', () => { void stop(); });
    process.on('SIGTERM', () => { void stop(); });
  }
}

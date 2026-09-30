import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { appError, fail, ok } from '@flowmate/contracts';
import type { ProductPaths, Result } from '@flowmate/contracts';

function isWithin(root: string, target: string): boolean {
  const relation = relative(resolve(root), resolve(target));
  return !isAbsolute(relation) && (relation === '' || (relation !== '..' && !relation.startsWith(`..${'\\'}`) && !relation.startsWith(`..${'/'}`)));
}

function existingAncestor(value: string): string | null {
  let current = resolve(value);
  while (true) {
    try {
      lstatSync(current);
      return current;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function realBoundaryPath(value: string): string {
  const absolute = resolve(value);
  const ancestor = existingAncestor(absolute);
  if (!ancestor) throw new Error('path_unresolvable');
  const realAncestor = realpathSync(ancestor);
  if (ancestor === absolute) return realAncestor;
  return resolve(realAncestor, relative(ancestor, absolute));
}

export function resolveWindowsUserData(
  env: Readonly<Record<string, string | undefined>>,
): Result<string> {
  const appData = env.APPDATA;
  if (!appData || !isAbsolute(appData)) {
    return fail(appError('config_user_data_missing', 'input', 'Windows APPDATA 不可用。'));
  }
  return ok(join(appData, 'Flowmate'));
}

export function resolveProductPaths(userData: string): Result<ProductPaths> {
  if (!isAbsolute(userData)) {
    return fail(appError('config_user_data_invalid', 'input', '用户数据目录必须是绝对路径。'));
  }
  // resolveWindowsUserData already returns the final `%APPDATA%/Flowmate`
  // root. Callers constructing a trial root follow the same contract.
  const root = resolve(userData);
  return ok({
    root,
    databaseFile: join(root, 'data', 'app.sqlite'),
    logsDir: join(root, 'logs'),
    artifactsDir: join(root, 'artifacts'),
    outputsDir: join(root, 'outputs'),
    runtimeDir: join(root, 'runtime'),
  });
}

export function validateProductPaths(paths: ProductPaths, expectedBoundary?: ProductPaths): Result<ProductPaths> {
  if (!isAbsolute(paths.root)) {
    return fail(appError('path_invalid', 'input', '产品根目录必须是绝对路径。'));
  }
  const members = [
    paths.databaseFile,
    paths.logsDir,
    paths.artifactsDir,
    paths.outputsDir,
    paths.runtimeDir,
  ];
  if (members.some((member) => !isAbsolute(member))) {
    return fail(appError('path_invalid', 'input', '产品路径必须是绝对路径。'));
  }
  if (members.some((member) => !isWithin(paths.root, member))) {
    return fail(appError('path_outside_root', 'input', '产品路径必须位于产品根目录内。'));
  }
  try {
    const boundary = { ...paths };
    for (const key of ['root', 'databaseFile', 'logsDir', 'artifactsDir', 'outputsDir', 'runtimeDir'] as const) {
      boundary[key] = realBoundaryPath(paths[key]);
      if (key !== 'root' && !isWithin(boundary.root, boundary[key])) {
        return fail(appError('path_outside_root', 'input', '产品路径解析后必须位于产品根目录内。'));
      }
      if (expectedBoundary && relative(expectedBoundary[key], boundary[key]) !== '') {
        return fail(appError('path_outside_root', 'input', '产品路径的实际位置在创建期间发生变化。'));
      }
    }
    return ok(boundary);
  } catch {
    return fail(appError('path_invalid', 'input', '产品路径的实际位置无法确认。'));
  }
}

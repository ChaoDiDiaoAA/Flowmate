function windowsPaths(): boolean {
  if (typeof process !== 'undefined' && typeof process.platform === 'string') return process.platform === 'win32';
  return typeof navigator !== 'undefined' && navigator.platform.startsWith('Win');
}

/** Same absolute-path test as Node, shared with the local desktop browser. */
export function isAbsoluteConfigPath(value: string, windows = windowsPaths()): boolean {
  return windows ? /^(?:[\\/]|[a-z]:[\\/])/i.test(value) : value.startsWith('/');
}

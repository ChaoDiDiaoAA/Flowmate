import { readFile } from "node:fs/promises";

/**
 * Load only explicit project .env files. Existing process values win, so a
 * caller or the test runner can supply a deliberate override. This helper is
 * an environment loader, not a Provider parser: Pi still owns the meaning of
 * every variable.
 */
export async function loadDotEnv(...paths: string[]): Promise<string[]> {
  const loaded: string[] = [];
  for (const path of paths) {
    let contents: string;
    try {
      contents = await readFile(path, "utf8");
    } catch {
      continue;
    }
    for (const rawLine of contents.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const separator = line.indexOf("=");
      if (separator <= 0) continue;
      const key = line.slice(0, separator).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key] !== undefined) continue;
      let value = line.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      process.env[key] = value;
    }
    loaded.push(path);
  }
  return loaded;
}

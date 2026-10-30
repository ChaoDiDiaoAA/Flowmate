import { z } from 'zod';

// Observed Codex 0.164.0 turn/start limit; this is a transport boundary, not an evidence budget.
export const nativeJudgeMaxInputChars = 1048576;
export const sharedTextEncoding = 'flowmate-judge-shared-text/v1' as const;
type Path = Array<string | number>;
const pathSchema = z.array(z.union([z.string(), z.number().int().nonnegative()])).min(1);
const envelopeSchema = z.object({ wireEncoding: z.literal(sharedTextEncoding), input: z.unknown(),
  textReferences: z.array(z.object({ path: pathSchema, source: pathSchema }).strict()) }).strict();
const originalFrame = (path: Path) => path[0] === 'plan' || path[0] === 'evidence' &&
  (path[1] === 'researchFrame' || path[1] === 'facts' && path[2] === 'research-frame');

/** Only exact repeated strings are shared. Every original character remains in this same request. */
export function encodeSharedTextInput(data: string): string {
  const originals: Array<{ text: string; path: Path }> = [], textReferences: Array<{ path: Path; source: Path }> = [];
  const visit = (value: unknown, path: Path): unknown => {
    if (originalFrame(path)) return value;
    // Short strings cost less inline than two explicit paths; this never truncates long unique text.
    if (typeof value === 'string' && value.length >= 4000) {
      const original = originals.find(original => original.text === value);
      if (original) { textReferences.push({ path, source: original.path }); return null; }
      originals.push({ text: value, path });
    }
    if (Array.isArray(value)) return value.map((item, index) => visit(item, [...path, index]));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item, [...path, key])]));
    return value;
  };
  return JSON.stringify({ wireEncoding: sharedTextEncoding, input: visit(JSON.parse(data), []), textReferences });
}

/** The caller's versioned rubric selects decoding; source objects never opt themselves into it. */
export function decodeJudgeInput<T = unknown>(data: string, sharedText = false): T {
  const raw: unknown = JSON.parse(data);
  if (!sharedText) return raw as T;
  const envelope = envelopeSchema.parse(raw), input = envelope.input;
  const at = (path: Path): unknown => path.reduce<unknown>((value, key) => {
    if (!value || typeof value !== 'object' ||
      (Array.isArray(value) ? typeof key !== 'number' : typeof key !== 'string') || !Object.hasOwn(value, key))
      throw Error('Invalid shared-text reference path');
    return Reflect.get(value, key);
  }, input);
  const seen: string[] = [];
  const replacements = envelope.textReferences.map(({ path, source }) => {
    const identity = JSON.stringify(path), text = at(source);
    if (originalFrame(path) || seen.includes(identity) || at(path) !== null || typeof text !== 'string') throw Error('Invalid shared-text reference');
    seen.push(identity);
    return { path, text };
  });
  for (const { path, text } of replacements) {
    const parent = at(path.slice(0, -1));
    if (!parent || typeof parent !== 'object') throw Error('Invalid shared-text reference parent');
    Reflect.set(parent, path.at(-1)!, text);
  }
  return input as T;
}

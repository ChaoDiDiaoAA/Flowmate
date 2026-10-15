/** Persist original facts without rewriting source text or embedded JSON. */
export const artifactJson = (value: unknown) => JSON.stringify(value, (_key,item) => item instanceof Error ? String(item) : item, 2) + '\n';

/** Shared by Create, Rename and the browser's frozen Fork intent. */
export function normalizeSessionTitle(value: string): string | null {
  const title = value.trim();
  return title.length > 0 && [...title].length <= 120 && new TextEncoder().encode(title).byteLength <= 480 ? title : null;
}

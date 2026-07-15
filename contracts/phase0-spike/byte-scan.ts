// Recursively collects every Uint8Array reachable from an arbitrary value
// (arrays, Maps, plain objects) into one buffer, so a privacy check can
// assert a secret's bytes never appear anywhere in a public transcript —
// regardless of which AlignedValue/Op field the compiler happened to put
// them in.
export function collectBytes(value: unknown, out: Uint8Array[]): void {
  if (value instanceof Uint8Array) {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectBytes(item, out);
    return;
  }
  if (value instanceof Map) {
    for (const [k, v] of value.entries()) {
      collectBytes(k, out);
      collectBytes(v, out);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) collectBytes(v, out);
  }
}

export function flatten(value: unknown): Uint8Array {
  const chunks: Uint8Array[] = [];
  collectBytes(value, chunks);
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// Naive contiguous-subsequence search — transcripts in this spike are small
// enough that O(n*m) is irrelevant here.
export function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

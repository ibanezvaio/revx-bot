type JsonLike =
  | null
  | boolean
  | number
  | string
  | JsonLike[]
  | { [key: string]: JsonLike };

export function canonicalize(value: JsonLike): JsonLike {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item)) as JsonLike;
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, canonicalize(v)] as const);

    return Object.fromEntries(entries) as JsonLike;
  }

  return value;
}

export function canonicalJsonStringify(value: unknown): string {
  if (value === undefined) return "";
  return JSON.stringify(canonicalize(value as JsonLike));
}

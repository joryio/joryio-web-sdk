/**
 * Values the SDK can carry to the API (rule 49, the same on every SDK).
 *
 * JSON has no NaN or Infinity: `JSON.stringify` writes them as `null`, so an
 * attribute of NaN silently became null on the profile - and a circular
 * object or a BigInt made `JSON.stringify` THROW, which the network layer
 * took for "offline" and retried forever. Because every attribute request
 * carries the oldest pending write of every key, one such value held every
 * later attribute write (and every in-app sync) of the page.
 *
 * Now a value is checked when it enters the SDK: the key holding a bad value
 * is dropped with a warning, and the rest of the call goes ahead.
 */

/** Deeper than this is treated as unserializable (it would blow the stack). */
const MAX_DEPTH = 100;

/** Why this value cannot be sent, or null when it can. */
export function valueProblem(value: unknown): string | null {
  const ancestors: object[] = [];
  const walk = (v: unknown, depth: number): string | null => {
    switch (typeof v) {
      case 'number':
        return Number.isFinite(v) ? null : 'a non-finite number (NaN or Infinity)';
      case 'bigint':
        return 'a BigInt';
      case 'function':
        return 'a function';
      case 'symbol':
        return 'a symbol';
      case 'object': {
        if (v === null) return null;
        if (depth > MAX_DEPTH) return `a value nested deeper than ${MAX_DEPTH} levels`;
        // toJSON (a Date, say) decides its own form; serialized below.
        if (typeof (v as any).toJSON === 'function') {
          try {
            JSON.stringify(v);
            return null;
          } catch {
            return 'a value that cannot be serialized';
          }
        }
        if (ancestors.includes(v as object)) return 'a circular reference';
        ancestors.push(v as object);
        try {
          const children = Array.isArray(v) ? v : Object.values(v as Record<string, unknown>);
          for (const child of children) {
            const problem = walk(child, depth + 1);
            if (problem) return problem;
          }
        } finally {
          ancestors.pop();
        }
        return null;
      }
      default:
        return null; // string, boolean, undefined
    }
  };
  try {
    return walk(value, 1);
  } catch {
    return 'a value that cannot be serialized';
  }
}

/**
 * A copy of `values` without the keys whose value cannot be sent; each one
 * dropped is reported through `warn`.
 */
export function withoutUnsendableValues(
  values: Record<string, any>,
  warn: (key: string, problem: string) => void,
): Record<string, any> {
  const out: Record<string, any> = {};
  for (const key of Object.keys(values)) {
    const problem = valueProblem(values[key]);
    if (problem) {
      warn(key, problem);
      continue;
    }
    out[key] = values[key];
  }
  return out;
}

import { createHash } from "node:crypto";

/**
 * Deterministic identifier for a domain value: the namespace, a NUL
 * separator, and the JSON form of the value, hashed with SHA-256 and
 * prefixed with the namespace so an identifier names its kind.
 */
export function hashAs<Value extends string>(
  namespace: string,
  value: unknown,
): Value {
  const hash = createHash("sha256");
  hash.update(namespace);
  hash.update("\0");
  hash.update(JSON.stringify(value));
  return `${namespace}:${hash.digest("hex")}` as Value;
}

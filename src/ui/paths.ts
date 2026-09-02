import type { FileChange } from "../review/types.ts";
import { safeText } from "./text.ts";

/** A path quoted as a JSON string so spaces and escapes are unambiguous. */
export function displayPath(path: string): string {
  return safeText(JSON.stringify(path));
}

/** A path escaped like displayPath but without the surrounding quotes. */
export function displayBarePath(path: string): string {
  return safeText(JSON.stringify(path).slice(1, -1));
}

export function displayChangePath(change: FileChange): string {
  return describeChangePath(change, displayPath);
}

export function displayBareChangePath(change: FileChange): string {
  return describeChangePath(change, displayBarePath);
}

function describeChangePath(
  change: FileChange,
  format: (path: string) => string,
): string {
  if (
    change.oldPath !== undefined &&
    change.newPath !== undefined &&
    change.oldPath !== change.newPath
  ) {
    return `${format(change.oldPath)} -> ${format(change.newPath)}`;
  }
  const path = change.newPath ?? change.oldPath;
  return path === undefined ? "<unknown path>" : format(path);
}

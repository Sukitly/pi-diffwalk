import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * The directory rules from AGENTS.md, checked against the import graph so a
 * stray import cannot quietly undo the layering.
 */

const SRC_ROOT = path.resolve(import.meta.dirname, "..", "src");

interface SourceModule {
  /** Path relative to src/, with forward slashes. */
  readonly name: string;
  /** Relative imports resolved to the same form as name. */
  readonly imports: readonly string[];
}

const UPPER_LAYERS = ["ui/", "review-ui/", "thread-ui/", "extension/"];

test("domain and Git modules do not import UI or extension modules", () => {
  const violations = listSourceModules()
    .filter(
      (module) =>
        module.name.startsWith("review/") || module.name.startsWith("git/"),
    )
    .flatMap((module) =>
      module.imports
        .filter((target) =>
          UPPER_LAYERS.some((layer) => target.startsWith(layer)),
        )
        .map((target) => `${module.name} -> ${target}`),
    );
  assert.deepEqual(violations, []);
});

test("shared UI helpers do not import a specific UI or the extension", () => {
  const violations = listSourceModules()
    .filter((module) => module.name.startsWith("ui/"))
    .flatMap((module) =>
      module.imports
        .filter((target) =>
          ["review-ui/", "thread-ui/", "extension/"].some((layer) =>
            target.startsWith(layer),
          ),
        )
        .map((target) => `${module.name} -> ${target}`),
    );
  assert.deepEqual(violations, []);
});

test("UI entry modules are consumers, never imported from inside their directory", () => {
  const violations = listSourceModules()
    .filter(
      (module) =>
        (module.name.startsWith("review-ui/") ||
          module.name.startsWith("thread-ui/")) &&
        path.posix.basename(module.name) !== "index.ts",
    )
    .flatMap((module) =>
      module.imports
        .filter(
          (target) =>
            path.posix.dirname(target) === path.posix.dirname(module.name) &&
            path.posix.basename(target) === "index.ts",
        )
        .map((target) => `${module.name} -> ${target}`),
    );
  assert.deepEqual(violations, []);
});

test("the source import graph has no cycles", () => {
  const modules = new Map(
    listSourceModules().map((module) => [module.name, module.imports]),
  );
  const visiting = new Set<string>();
  const done = new Set<string>();
  const cycles: string[] = [];
  const visit = (name: string, stack: string[]): void => {
    visiting.add(name);
    stack.push(name);
    for (const target of modules.get(name) ?? []) {
      if (visiting.has(target)) {
        cycles.push(
          [...stack.slice(stack.indexOf(target)), target].join(" -> "),
        );
      } else if (!done.has(target)) {
        visit(target, stack);
      }
    }
    stack.pop();
    visiting.delete(name);
    done.add(name);
  };
  for (const name of modules.keys()) {
    if (!done.has(name)) visit(name, []);
  }
  assert.deepEqual(cycles, []);
});

function listSourceModules(): readonly SourceModule[] {
  return listTypeScriptFiles(SRC_ROOT).map((file) => {
    const source = readFileSync(file, "utf8");
    const imports = [
      ...source.matchAll(/from\s+"(\.{1,2}\/[^"]+)"/g),
      ...source.matchAll(/import\s+"(\.{1,2}\/[^"]+)"/g),
    ].map((match) =>
      toModuleName(path.resolve(path.dirname(file), match[1] ?? "")),
    );
    return { name: toModuleName(file), imports };
  });
}

function listTypeScriptFiles(directory: string): readonly string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) return listTypeScriptFiles(full);
    return entry.endsWith(".ts") ? [full] : [];
  });
}

function toModuleName(file: string): string {
  return path.relative(SRC_ROOT, file).split(path.sep).join("/");
}

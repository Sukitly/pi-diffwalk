# AGENTS.md

## Scope

This file applies to the entire repository.

## Communication Rules

1. Lead with the conclusion, decision, or required action.
2. State each conclusion once. Do not restate the user's request or repeat the same point with different wording.
3. Omit obvious reasoning. Explain only non-obvious evidence, tradeoffs, and consequences.
4. Use Markdown tables for structured comparisons. Do not repeat the same comparison as prose.
5. Avoid decorative formatting, separators, box-drawing characters, and headings that do not separate meaningful sections.
6. Do not narrate routine next steps or describe what the response is about to do. When approval is required, present the plan directly and stop after the approval request.
7. Name files, types, functions, modules, and concepts directly. Avoid ambiguous references such as "this", "that", "the former", or temporary labels across messages.
8. Report only findings, risks, and alternatives that actually exist. Empty findings are valid. Do not invent entries to fill severity levels or predefined categories.
9. Before sending a response, remove text that can be deleted without reducing information content.
10. Keep code review responses materially shorter than the reviewed change unless the user requests a detailed walkthrough.

These communication rules do not override the approval requirements in `Workflow for Changes`.

## Project Overview

DiffWalk is a pi extension that lets an agent guide a human through a code review. The agent supplies the route and explanation. Git supplies the patch. The human reads the code, records comments, and decides whether the change is acceptable.

Evaluate every product and implementation decision against that purpose. Do not turn DiffWalk into an autonomous approval bot or a generic diff viewer.

## Module Layout

| Directory | Contents |
|---|---|
| `src/git/` | Git invocation and revision resolution (`runner.ts`), pure patch parsing (`patch.ts`), frozen file reconstruction (`content.ts`), snapshot capture and drift checks (`snapshot.ts`) |
| `src/review/` | Domain model and pure logic: types, delta, moves, spans, coverage, comments, threads, series, persistence, route validation and advisory |
| `src/extension/` | pi integration: `DiffWalkSession` (`session.ts`) owns the pending review, series, and thread batches and runs every workflow; `command.ts` and `tools.ts` parse input and format output; `prompts.ts` and `model-payloads.ts` hold text sent to the model; `tui-messages.ts` renders messages and tool results; `rules.ts` loads rules files |
| `src/ui/` | Rendering helpers shared by both UIs: theme, text escaping and wrapping, layout, path display, diff lines |
| `src/review-ui/` | Guided walkthrough: `component.ts` holds the screen state machine; view model, diff view, viewport, and per-screen rendering are separate modules |
| `src/thread-ui/` | Comment thread component and its rendering |
| `test/` | Mirrors `src/`. Shared domain fixtures live in `test/support/`; `test/review-ui/harness.ts` and `test/extension/harness.ts` hold the fake terminal and fake pi used by their directories |

Keep new code in the directory that owns the concern. Domain logic in `src/review/` must not import from `src/ui/`, `src/review-ui/`, `src/thread-ui/`, or `src/extension/`.

## Setup and Commands

```bash
npm ci --ignore-scripts             # install exactly the locked dependencies
npx biome check .                   # formatting and lint checks
npm run check                       # full static check
npm test                            # all tests
node --test test/git/snapshot.test.ts   # one focused test file
npm run format                      # only when formatting is within the approved scope
```

There is no build step. pi loads extension TypeScript directly. Do not add a build pipeline unless distribution or runtime requirements make it necessary.

## TypeScript Rules

- Use strict TypeScript.
- Do not use `any` unless no precise type can represent an external boundary. Explain any use in code.
- Use top-level imports. Do not use dynamic imports.
- Use erasable TypeScript syntax. Do not use `enum`, parameter properties, namespaces, or other syntax that requires JavaScript emission.
- Include `.ts` extensions in relative imports, as required by the NodeNext configuration.
- Use TypeBox for tool parameter schemas and derive static parameter types from schemas when practical.
- Keep parsing and validation functions pure where possible.
- Prefer explicit result types for operations that can partially succeed.
- Include actionable context in errors. Do not catch an error only to discard it.

Biome is the formatting and linting authority. Do not hand-format code against Biome output.

## Package and Dependency Rules

- Use npm only. Do not add `bun.lock`, `pnpm-lock.yaml`, or `yarn.lock`. Treat `package-lock.json` changes as reviewed code.
- Use `npm ci --ignore-scripts` for clean installation and `npm install --ignore-scripts` only for approved dependency or lockfile changes.
- Do not run lifecycle scripts unless the user explicitly approves them.
- Do not run `npm audit fix` automatically. Review the proposed dependency changes first.
- Pin direct development and runtime dependencies to exact versions.
- Keep pi-provided packages and `typebox` as peer dependencies with the ranges required by pi package guidance.
- Add no dependency without explaining why the platform, Node.js, or pi cannot provide the capability.

## Testing Requirements

Unit tests must not call a real model or require network access. Use temporary Git repositories for integration tests and keep fixtures small enough that failures can be understood from test output.

Keep coverage for these behavior categories; the existing test files are the source of truth for the exact cases:

- Git snapshot shapes: staged, unstaged, mixed, untracked, added, deleted, renamed, binary, empty, no trailing newline, spaces and Unicode in paths, several changed regions in one file, whole-file reconstruction, deterministic identifiers and changed-line sets
- route validation: every rejection path in Product Invariants 4 and 5, valid explicit skips, partial-hunk spans, and multi-file units
- review delta: carried-forward lines surviving a line shift and a neighbouring edit
- exact move detection: relocation across files, uniform reindentation, ambiguity from a third occurrence, size thresholds, and same-hunk suppression
- advisory signals for hunk mirroring, alphabetical ordering, and split moves, and the one-shot nudge accepting a resubmitted route
- the pinned model-visible prompt surface matching its golden fixture, and a kickoff prompt that does not grow with the amount of changed source text
- comment anchors on added and removed lines, rejection of context lines, and snapshot drift detection

Before considering the TUI complete, run an interactive smoke test through pi in a controlled terminal. Verify navigation, scrolling, comment editing, submission, cancellation, narrow terminal behavior, and Chinese IME input.

## Security Rules

- Extensions run with the user's full permissions. Minimize the command surface.
- Treat the base revision and repository contents as untrusted input.
- Pass arguments directly to Git. Never evaluate repository content as shell code.
- Do not send repository contents to any model other than the model already selected by the user unless the user explicitly opts in.
- Do not start background processes, watchers, or servers for the first version.
- Do not write temporary review data inside the target repository.
- Do not log source code, comments, credentials, or full model prompts by default.
- Never read or expose `.env`, credential stores, or unrelated files as part of automatic review setup.

When committing is explicitly requested:

- stage only files changed for the approved task
- inspect `git status` before and after staging
- do not include unrelated generated or user changes
- do not force push

## Documentation Rules

- Keep README and repository documentation in English.
- Do not use emoji.
- Do not use em dashes.
- Use direct technical prose.
- Do not claim planned features are available.
- Update command examples, controls, architecture, and status when behavior changes.
- Explain user-visible limitations instead of hiding them.

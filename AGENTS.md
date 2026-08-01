# AGENTS.md

## Scope

This file applies to the entire repository.

If nested `AGENTS.md` files are added later, the closest file to the code being changed takes precedence for that subtree. Explicit user instructions take precedence over this file. If an instruction would weaken a product invariant or safety rule, ask for explicit confirmation before proceeding.

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

## Setup and Commands

Use npm. `package-lock.json` is the authoritative lockfile.

Install exactly the locked dependencies without running lifecycle scripts:

```bash
npm ci --ignore-scripts
```

Refresh dependencies or the lockfile only when an approved change requires it:

```bash
npm install --ignore-scripts
```

Run formatting and lint checks:

```bash
npx biome check .
```

Run the full static check:

```bash
npm run check
```

Run all tests:

```bash
npm test
```

Run a focused test file directly:

```bash
node --test test/git-diff.test.ts
node --test test/route-validation.test.ts
```

Format files only when formatting changes are within the approved scope:

```bash
npm run format
```

There is no build step. pi loads extension TypeScript directly. Do not add a build pipeline unless distribution or runtime requirements make it necessary.

## Repository Layout

Use this source layout unless an approved plan establishes a better one:

```text
src/
  index.ts
  git-diff.ts
  review-delta.ts
  in-progress-review.ts
  route-validation.ts
  review-coverage.ts
  review-series.ts
  review-comments.ts
  review-ui.ts
  prompts.ts
  types.ts
test/
  git-diff.test.ts
  review-delta.test.ts
  in-progress-review.test.ts
  route-validation.test.ts
  review-coverage.test.ts
  review-series.test.ts
  review-comments.test.ts
```

Responsibilities:

| File | Responsibility |
|---|---|
| `src/index.ts` | Register `/diffwalk`, register the guided review tool, and coordinate the workflow |
| `src/git-diff.ts` | Capture repository state, parse unified diffs, include untracked files, and assign stable identifiers |
| `src/review-delta.ts` | Classify snapshot hunks against the previous completed round and validate delta coverage |
| `src/in-progress-review.ts` | Own resumable review identity, lifecycle, explicit unit progress, drafts, submission eligibility, and optimistic versioning |
| `src/route-validation.ts` | Validate route references, coverage, ordering, and explicit skips |
| `src/review-coverage.ts` | Materialize submitted review outcomes for every snapshot hunk |
| `src/review-series.ts` | Create and append immutable completed review rounds |
| `src/review-comments.ts` | Own comment anchors, drafts, ordering, cancellation, and drift-gated submission results |
| `src/review-ui.ts` | Render the walkthrough, navigate diff lines, and connect the comment session to the TUI |
| `src/prompts.ts` | Tell the agent how to inspect the change and construct a semantic route |
| `src/types.ts` | Define TypeScript types and TypeBox schemas shared across modules |

Keep Git parsing, route validation, model protocol, and TUI state separate. They have different failure modes and should be testable without one another.

## Product Invariants

These rules define the product. Do not weaken them without explicit user approval.

1. Git output is the source of truth for displayed changes.
2. The model may reference hunks by stable identifier, but it must not provide the patch text rendered to the user.
3. Every hunk marked `needs-review` must appear exactly once in the review route or be explicitly skipped with a visible reason. Hunks marked `unresolved-comment` cannot be skipped. Carried-forward hunks remain visible in inventory and coverage but are excluded from the model-planned route.
4. The extension must reject unknown, duplicate, or missing hunk references.
5. A review uses a frozen snapshot. The implementation agent must not mutate the worktree during the walkthrough.
6. The extension must detect worktree drift before submitting comments.
7. Comments must retain file, hunk, old line, new line, and nearby diff context where available.
8. Comments are returned to the agent as one batch after explicit user submission.
9. Review order should follow behavior, contracts, data flow, and failure paths rather than alphabetical file order.
10. The human owns the review and approval decision.
11. Unsupported changes must be reported. They must never disappear silently.
12. Non-interactive modes must fail clearly instead of pretending that an interactive review occurred.

## Workflow for Changes

Before editing:

1. Read this file, the README, and every source file relevant to the task.
2. Present a plan that names the files to change and explains why.
3. Wait for explicit user approval.

During implementation:

1. Keep the change limited to the approved scope.
2. Do not remove intentional behavior without asking.
3. Do not add speculative abstractions for future features.
4. Prefer the smallest vertical slice that can be tested through the real interaction.
5. Keep documentation synchronized with behavior.
6. Do not commit unless the user asks.

Before reporting completion, follow the completion checklist at the end of this file.

## TypeScript Rules

- Use strict TypeScript.
- Do not use `any` unless no precise type can represent an external boundary. Explain any use in code.
- Use top-level imports. Do not use dynamic imports.
- Use erasable TypeScript syntax. Do not use `enum`, parameter properties, namespaces, or other syntax that requires JavaScript emission.
- Include `.ts` extensions in relative imports, as required by the NodeNext configuration.
- Use TypeBox for tool parameter schemas.
- Derive static parameter types from schemas when practical.
- Keep parsing and validation functions pure where possible.
- Prefer explicit result types for operations that can partially succeed.
- Include actionable context in errors.
- Do not catch an error only to discard it.
- Avoid dependencies when the platform or pi already provides the required behavior.

Biome is the formatting and linting authority. Do not hand-format code against Biome output.

## Package and Dependency Rules

- Use npm only. Do not add `bun.lock`, `pnpm-lock.yaml`, or `yarn.lock`.
- Treat `package-lock.json` changes as reviewed code.
- Use `npm ci --ignore-scripts` for clean installation.
- Use `npm install --ignore-scripts` only for approved dependency or lockfile changes.
- Do not run lifecycle scripts unless the user explicitly approves them.
- Do not run `npm audit fix` automatically. Review the proposed dependency changes first.
- Pin direct development and runtime dependencies to exact versions.
- Keep pi-provided packages and `typebox` as peer dependencies with the ranges required by pi package guidance.
- Add no dependency without explaining why the platform, Node.js, or pi cannot provide the capability.

## Git Snapshot Rules

- Execute Git through argument arrays, preferably with `pi.exec()` from extension code.
- Do not build shell commands by interpolating repository paths, refs, or user input.
- Separate revisions from paths with `--` where applicable.
- Capture enough metadata to detect snapshot drift.
- Assign identifiers from normalized snapshot content, not from model output.
- Preserve file paths exactly. Do not assume paths contain no spaces, tabs, Unicode, newlines, or leading punctuation.
- Represent staged, unstaged, deleted, added, renamed, binary, empty, and untracked changes.
- If a change type cannot be reviewed in the TUI, include it in the inventory with an explicit unsupported reason.
- Handle files without a trailing newline.
- Never mutate the index or worktree while collecting a snapshot.
- Do not use `git checkout`, `git switch`, `git reset`, `git clean`, or `git stash` as part of review collection.

The snapshot collector must be deterministic. The same repository state and base revision must produce the same hunk identifiers.

## Agent Protocol Rules

The model plans the route only after the extension has created the snapshot inventory and calculated the review delta. The model-planned route covers `needs-review` hunks only. Carried-forward hunks remain available for explicit human inspection outside the planned route and must not be routed or skipped by the model.

The route schema must reference stable identifiers and contain only explanatory metadata, such as:

- review unit title
- reason for reviewing the unit at this point
- required context and call path
- description of the change
- concrete review questions
- ordered hunk identifiers
- explicit skipped identifiers and reasons

Validate all model output before opening the TUI.

A valid route must satisfy:

- no unknown identifiers
- no duplicate identifiers
- no uncovered `needs-review` hunks
- no carried-forward hunk references
- no skipped `unresolved-comment` hunk
- no skipped hunk without a reason
- at least one review unit when `needs-review` hunks exist

Return validation errors to the agent so it can repair the tool call. Do not silently repair a route in a way that could hide missing coverage.

Treat agent explanations as untrusted commentary. The UI must distinguish explanation from snapshot content.

## Review Mutation Boundary

Route preparation and the interactive walkthrough are read-only phases.

The kickoff prompt must tell the agent not to edit files while preparing the route. Once the guided review tool opens, the tool call naturally blocks the parent agent until the user submits or cancels.

After submission:

- `Discuss first` permits investigation and explanation but no file mutation.
- `Apply change requests` permits direct requested edits. Questions, uncertainty, and disagreement still require an explanation.

Do not infer permission to edit from a concern or question.

## TUI Rules

- Use `ctx.ui.custom()` only when `ctx.mode === "tui"`.
- Every rendered line must fit within the width passed to `render()`.
- Use `visibleWidth`, `truncateToWidth`, and `wrapTextWithAnsi` for ANSI-aware layout.
- Use `matchesKey()` and `Key` instead of comparing raw terminal sequences.
- Use `tui.terminal.rows` to bound the review viewport.
- Keep a selected diff line visible when the cursor moves.
- Render added, removed, and context lines with pi theme colors.
- Preserve old and new line numbers independently.
- Embed pi's `Editor` for multiline comments rather than implementing text editing from scratch.
- Propagate focus correctly for IME input.
- Invalidate cached output after state changes and theme changes.
- Keep navigation available when a unit is taller than the terminal.
- Show review progress, comment count, skipped count, and snapshot drift status.
- Make cancellation explicit and preserve comments when practical.

Do not put model-generated patch text into the TUI, even as a fallback.

## Comment Rules

A submitted comment must include:

```text
snapshot ID
review unit ID
hunk ID
selected file path
old file path, when available
new file path, when available
old line number, when available
new line number, when available
selected diff text
nearby diff context
comment body
```

Comments must be editable before submission. The final page must show the complete batch and the selected submission mode.

The tool result sent to the agent must be structured and concise. Do not rely on prose parsing to recover line anchors.

## Testing Requirements

Unit tests must not call a real model or require network access.

At minimum, cover:

- unstaged tracked changes
- staged changes
- mixed staged and unstaged changes
- untracked files
- added and deleted files
- renamed files
- binary files
- empty files
- files without a trailing newline
- paths containing spaces and Unicode
- multiple hunks in one file
- deterministic hunk identifiers
- unknown route identifiers
- duplicate route identifiers
- missing route coverage
- valid explicit skips
- comment anchors on added, removed, and context lines
- snapshot drift detection

Use temporary Git repositories for integration tests. Keep fixtures small enough that failures can be understood from test output.

Before considering the TUI complete, run an interactive smoke test through pi in a controlled terminal. Verify navigation, scrolling, comment editing, submission, cancellation, narrow terminal behavior, and Chinese IME input.

## Dependency and Security Rules

- Extensions run with the user's full permissions. Minimize the command surface.
- Treat the base revision and repository contents as untrusted input.
- Pass arguments directly to Git. Never evaluate repository content as shell code.
- Do not send repository contents to any model other than the model already selected by the user unless the user explicitly opts in.
- Do not start background processes, watchers, or servers for the first version.
- Do not write temporary review data inside the target repository.
- Do not log source code, comments, credentials, or full model prompts by default.
- Never read or expose `.env`, credential stores, or unrelated files as part of automatic review setup.

## Git Safety

Multiple agent sessions may share a working directory.

Never run:

```text
git reset --hard
git checkout .
git clean -fd
git stash
git add -A
git add .
git commit --no-verify
```

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

## Completion Checklist

Before considering a change complete:

1. Confirm that all product invariants still hold.
2. Validate all model-facing input changed by the task.
3. Add or update tests for changed Git and route behavior.
4. Run the relevant focused tests.
5. Run `npm run check`.
6. Run `npm test` when the repository has applicable tests.
7. Smoke test TUI changes in a temporary Git repository through pi.
8. Review the final diff for unrelated changes and unsupported claims.
9. Confirm that documentation matches implemented behavior.
10. Report what was verified and what remains unverified.

Do not commit unless the user asks.

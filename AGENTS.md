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
  review-span.ts
  review-delta.ts
  review-moves.ts
  in-progress-review.ts
  route-validation.ts
  route-advisory.ts
  review-coverage.ts
  review-series.ts
  review-persistence.ts
  review-comments.ts
  review-ui.ts
  prompts.ts
  types.ts
test/
  git-diff.test.ts
  review-span.test.ts
  review-delta.test.ts
  review-moves.test.ts
  in-progress-review.test.ts
  route-validation.test.ts
  route-advisory.test.ts
  review-coverage.test.ts
  review-series.test.ts
  review-persistence.test.ts
  review-comments.test.ts
  prompt-surface.test.ts
```

Responsibilities:

| File | Responsibility |
|---|---|
| `src/index.ts` | Register `/diffwalk`, register the guided review tool, and coordinate the workflow |
| `src/git-diff.ts` | Capture repository state, parse unified diffs, include untracked files, and reconstruct each changed file as one frozen line sequence |
| `src/review-span.ts` | Own the changed-line atom, span resolution, and coverage set arithmetic |
| `src/review-delta.ts` | Classify changed lines against the previous completed round and validate delta coverage |
| `src/review-moves.ts` | Detect exact relocations between the frozen snapshot's changed lines, deterministically and by content only |
| `src/in-progress-review.ts` | Own resumable review identity, lifecycle, explicit unit progress, drafts, submission eligibility, and optimistic versioning |
| `src/route-validation.ts` | Validate route references, coverage, ordering, and explicit skips |
| `src/route-advisory.ts` | Assess a validated route for mechanical-route signals and format the one-shot advisory nudge |
| `src/review-coverage.ts` | Materialize submitted review outcomes for every changed line |
| `src/review-series.ts` | Create and append immutable completed review rounds |
| `src/review-persistence.ts` | Serialize completed review series into versioned session entries and parse them back, rejecting incompatible data |
| `src/review-comments.ts` | Own comment anchors, drafts, ordering, cancellation, and drift-gated submission results |
| `src/review-ui.ts` | Render the walkthrough, navigate diff lines, and connect the comment session to the TUI |
| `src/prompts.ts` | Tell the agent how to inspect the change and construct a semantic route |
| `src/types.ts` | Define TypeScript types and TypeBox schemas shared across modules |

Keep Git parsing, route validation, model protocol, and TUI state separate. They have different failure modes and should be testable without one another.

## Product Invariants

These rules define the product. Do not weaken them without explicit user approval.

1. Git output is the source of truth for displayed changes.
2. The model may address regions by file path and line range, but it must not provide the patch text rendered to the user.
3. The unit of review coverage is the changed line, not the Git hunk. A hunk is an artifact of the diff algorithm's context radius and carries no semantic meaning, so it must not appear in the agent protocol, the coverage contract, or the comment anchor.
4. Every changed line marked `needs-review` must be covered by exactly one review unit or explicitly skipped with a visible reason. Lines marked `unresolved-comment` cannot be skipped. Carried-forward lines remain visible in inventory and coverage but must not be covered or skipped by the model-planned route.
5. The extension must reject a span that names an unknown file, falls outside the frozen file, or contains no changed line, and must reject a route that leaves a changed line uncovered or covered twice.
6. The kickoff inventory tells the agent which lines changed, not what they contain. The extension must not push file or patch content into the model prompt. The agent reads the code with its own tools.
7. A review uses a frozen snapshot. The implementation agent must not mutate the worktree during the walkthrough.
8. The extension must detect worktree drift before submitting comments.
9. Comments must retain file, side, line number, selected text, and nearby file context.
10. Comments are returned to the agent as one batch after explicit user submission.
11. Review order should follow behavior, contracts, data flow, and failure paths rather than alphabetical file order.
12. The human owns the review and approval decision.
13. Unsupported changes must be reported. They must never disappear silently.
14. Non-interactive modes must fail clearly instead of pretending that an interactive review occurred.

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

The snapshot collector must be deterministic. The same repository state and base revision must produce the same file change identifiers and the same changed-line set.

Each changed text file is stored as one line sequence covering the whole file, not only the regions Git chose to emit. A review span may address any line, so the untouched regions are reconstructed from the frozen merge-base blob. Reconstruction must be verified against the real file content, never assumed.

## Agent Protocol Rules

The model plans the route only after the extension has created the snapshot inventory and calculated the review delta. The model-planned route covers `needs-review` lines only. Carried-forward lines remain available for explicit human inspection outside the planned route and must not be covered or skipped by the model.

The kickoff inventory carries no file content. It states the frozen comparison, which lines changed on which side, how each line is classified, the Git hunk boundaries offered as suggested spans, and exact relocations detected by content comparison, stated as coordinates only. The agent reads the code itself: the new side is the worktree, and the old side is reachable with `git show <mergeBase>:<path>`.

Detected moves are advisory. The kickoff prompt invites the agent to keep both sides of a relocation in one review unit; route validation must not enforce move symmetry, because reordering or separating a relocation is a legitimate routing decision.

The route schema must address regions by path and line range and contain only explanatory metadata, such as:

- review unit title
- reason for reviewing the unit at this point
- required context and call path
- description of the change
- concrete review questions
- ordered spans, each a path with an old range, a new range, or both
- explicit skipped spans and reasons

A review unit is a semantic region. It may span several files, it may cover part of a Git hunk, and it may include unchanged lines for context. Suggested spans mirror hunk boundaries and are a starting point the agent is expected to redraw when a semantic region disagrees with them.

Validate all model output before opening the TUI.

A valid route must satisfy:

- every span names a changed file in the frozen snapshot
- every span stays inside the frozen file on the side it addresses
- every span covers at least one changed line
- every `needs-review` line is covered exactly once, or skipped with a reason
- no changed line is covered by two units
- no changed line is both covered and skipped
- no carried-forward line is covered or skipped
- no `unresolved-comment` line is skipped
- at least one review unit when `needs-review` lines exist

Unchanged lines may appear in any number of spans. Only changed lines are counted for coverage, so two units can share context without conflict.

Return validation errors to the agent so it can repair the tool call. Do not silently repair a route in a way that could hide missing coverage.

After a route passes validation, the extension may return advisory quality signals (hunk mirroring, alphabetical single-file ordering, a split move) instead of opening the walkthrough. Advisory feedback never alters or rejects a valid route, fires at most once per review, and must state that resubmitting the same route proceeds.

Model-visible standing instructions, meaning the kickoff prompt, tool descriptions, and the advisory nudge, describe only decisions the agent must make. Validation internals are explained only through validation error messages at the moment of conflict. A new validation rule ships without new prompt prose unless the agent has a genuine decision to make.

The complete standing model-visible surface is pinned by a golden test (`test/prompt-surface.test.ts` and its fixture). Changing any standing model-visible string requires updating the golden file in the same change. Validation error text stays outside the pinned surface so conflict feedback can improve without ceremony.

Treat agent explanations as untrusted commentary. The UI must distinguish explanation from snapshot content.

## Review Mutation Boundary

Route preparation and the interactive walkthrough are read-only phases.

The kickoff prompt must tell the agent not to edit files while preparing the route. Once the guided review tool opens, the tool call naturally blocks the parent agent until the user submits, pauses, or discards the review.

A paused review keeps its frozen snapshot pending. The paused tool result must instruct the agent not to modify repository files or Git state until the user resumes the review and submits or discards it.

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
- Render a span with a few unchanged lines of padding so a narrowly drawn region is still readable. Stop padding at the first changed line outside the span, because that line belongs to another unit and must not look reviewable. Padding is display only and must not affect coverage.

Do not put model-generated patch text into the TUI, even as a fallback.

## Comment Rules

A submitted comment must include:

```text
snapshot ID
review unit ID
file change ID
side, either old or new
line number on that side
selected file path
old file path, when available
new file path, when available
old line number, when available
new line number, when available
selected line text
nearby file context
comment body
```

Only a changed line covered by the unit's spans can be commented on, so a comment can never fall outside the route the human is walking.

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
- several separate changed regions in one file
- whole-file reconstruction matching the real old and new content
- deterministic file change identifiers and changed-line sets
- spans naming an unknown path, an out-of-range line, or no changed line
- a changed line left uncovered, covered twice, or both covered and skipped
- valid explicit skips
- a span covering part of a Git hunk, and a unit spanning several files
- carried-forward lines surviving a line shift and a neighbouring edit
- exact move detection: relocation across files, uniform reindentation, ambiguity from a third occurrence, size thresholds, and same-hunk suppression
- advisory signals for hunk mirroring, alphabetical ordering, and split moves, and the one-shot nudge accepting a resubmitted route
- the pinned model-visible prompt surface matching its golden fixture
- comment anchors on added and removed lines, and rejection of context lines
- a kickoff prompt that does not grow with the amount of changed source text
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

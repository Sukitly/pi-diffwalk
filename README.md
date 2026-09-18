# DiffWalk

Agent-guided code review for [pi](https://github.com/earendil-works/pi).

> Before 1.0, APIs, controls, and persisted review formats may change.

Coding agents can produce changes faster than a human can rebuild the context needed to review them. A raw diff does not solve that problem. It shows what changed, but not where to begin, why a file matters, or which part of the system to inspect next.

DiffWalk turns a code review into a guided walkthrough. The agent plans a semantic route through the change and explains the context for each stop. DiffWalk renders the real Git diff one review unit at a time. The human reads the code, records comments, and decides whether the change is acceptable.

DiffWalk is a review navigator, not an autonomous reviewer. It does not approve code on your behalf, does not replace tests, static analysis, or security review, and does not let the agent edit code or rewrite the displayed patch during a walkthrough.

## Requirements

- Node.js 22.19.0 or newer, npm, and Git on `PATH`.
- [pi](https://github.com/earendil-works/pi) with a configured model. Development checks use pi 0.84.0.
- An interactive terminal and a Git worktree with an existing commit. Print and RPC modes are not supported.

## Installation

Install from GitHub:

```bash
pi install https://github.com/Sukitly/pi-diffwalk
```

Try the repository version for one pi session without saving an installation:

```bash
pi -e https://github.com/Sukitly/pi-diffwalk
```

Use a local checkout:

```bash
git clone https://github.com/Sukitly/pi-diffwalk.git
cd pi-diffwalk
npm ci --ignore-scripts
pi -e .
```

To review another repository with the local checkout:

```bash
cd /path/to/project
pi -e /absolute/path/to/pi-diffwalk
```

After the first npm release is published, install or try it with:

```bash
pi install npm:pi-diffwalk
pi -e npm:pi-diffwalk
```

The npm examples require a published `latest` dist-tag. Preparing the release scripts does not publish a package. Extensions run with your full system permissions; inspect the source before installing.

## Usage

1. Start pi in the repository whose changes you want to review:

   ```bash
   cd /path/to/project
   pi
   ```

   If pi was already running when you installed DiffWalk, run `/reload`.

2. Start a review in pi:

   ```text
   /diffwalk
   ```

   The default compares staged, unstaged, and untracked changes against `HEAD`. Use `/diffwalk main` to include your branch changes relative to local `main`, or `/diffwalk origin/main` after fetching that remote ref yourself. The base is a direct comparison, not an automatic merge-base calculation. Changed lines that match a mechanical exclusion rule are left out of the route; `/diffwalk --no-exclude` routes them too. See [Mechanical Exclusion](#mechanical-exclusion).

3. Read the agent-planned walkthrough. Use `j`/`k` to select a line, `c` to comment, and `n` to mark a unit reviewed and continue. A unit the agent claims is routine appears folded with its claim; press `o` to expand it or `n` to accept the fold. Press `?` for controls.
4. On the submission page, choose **Discuss first** or **Apply change requests**. Review the agent's replies and resolve answered threads when satisfied.

Use `/diffwalk --threads` to reopen comment conversations. Run `/diffwalk` again after changes to review the remaining work. An empty comparison starts no walkthrough.

## Commands

| Command | Effect |
|---|---|
| `/diffwalk` | Review the current worktree against `HEAD`, including untracked files |
| `/diffwalk <base>` | Review the current worktree against a Git revision |
| `/diffwalk --no-exclude [base]` | Review with every mechanical exclusion rule disabled |
| `/diffwalk --threads` | Reopen the most recently viewed comment threads |
| `/diffwalk --discard` | Drop a pending review without opening it |

A Git revision cannot start with `-`, so an option never shadows a base. When the comparison contains no line that needs review, DiffWalk reports that and starts nothing.

## How a Review Works

1. DiffWalk freezes a snapshot of the current Git changes. Every changed line receives a stable address: a file, a side, and a line number.
2. Mechanical exclusion rules remove changed lines that need no judgment, such as lockfiles or whitespace-only edits. The inventory lists every excluded line with the rule that removed it.
3. The agent reads the change with its own tools and plans a review route: semantic units ordered by behavior, contracts, and data flow instead of file order. A unit may span several files, so an implementation and the test that proves it are read together. A small unit that repeats an existing pattern may be marked routine, naming the code it mirrors.
4. The agent submits the route one unit at a time. Each unit is validated as it arrives and the reply reports which changed lines are still unrouted, so a mistake costs one unit instead of the whole route. The inventory hands the agent ready-made regions to pick from: contiguous runs of changed lines that share one review status.
5. A final call completes the route with any explicitly skipped regions. Every changed line that needs review must then be covered by exactly one review unit or skipped with a visible reason. Excluded lines must stay outside the route.
6. The TUI walks you through the route one unit at a time. A one or two sentence change summary sits under the header. The agent's review questions sit beneath the diff lines they are about, sharing one background block with the line; a question about the unit as a whole appears above the diff. A unit carries as many questions as it raises, up to five, and a unit that raises none carries none rather than a manufactured one. The reasons the unit comes next and the contract to keep in mind stay on the details page. You attach comments to exact diff lines.
7. Submission returns all comments to the agent as one batch, in one of two modes: **Discuss first** (the agent investigates without editing code) or **Apply change requests**.
8. The agent answers every comment with a structured response. A follow-up view shows each conversation under its diff anchor. You can reply to continue a thread and resolve it when satisfied. Only the reviewer can resolve a thread.
9. Running `/diffwalk` again against the same base carries forward already-reviewed lines and resolved comments, and routes only what still needs review. Completed rounds and comment threads persist in the pi session across restarts.

```text
DiffWalk / Review                                  Unit 3/12
Authentication request validation
2/12 reviewed    1 comment · 1 skipped    [██        ]

The handler now validates the token issuer before creating a session.

  ? Do existing sessions stay valid after this change?

src/auth/handler.ts
     46    46   const request = await parse(raw)
     47    47   const token = request.headers.authorization
     48        - if (!token) return unauthorized()
              Is the missing-token path still handled somewhere?
>          48 + const claims = await validateToken(token)
           49 + if (claims.issuer !== config.issuer) return unauthorized()
              Is the trusted issuer read from configuration rather than the token?
     49    50   return createSession(claims)

test/auth/handler.test.ts
           88 + test("rejects a foreign issuer", async () => {

j/k line • ←/→ unit • c comment • n complete • e details • i inventory • s summary • ? help
```

## Controls

Walkthrough:

| Key | Action |
|---|---|
| `j`, `k`, `Up`, `Down` | Move through diff lines or scroll the current page |
| `gg`, `G` | Jump to the first or last line of the current page |
| `1`-`9` | Start a count prefix that repeats the next movement, for example `5j` |
| `Ctrl+d`, `Ctrl+u` | Move by half a viewport |
| `PageUp`, `PageDown`, `Ctrl+f`, `Ctrl+b` | Move by a viewport |
| `n` | Mark the current review unit as reviewed and continue; the last unit opens the submission page. Accepting a folded routine unit records it as glanced |
| `o` | Expand or fold the current routine unit. Comments require the unit to be expanded |
| `r` | Mark a walked unit as one that could have been routine, or clear that mark |
| `p`, `h`, `Left` | Move to the previous review unit |
| `l`, `Right` | Move to the next review unit |
| `c` | Add or edit a comment on the selected line |
| `d` | Delete the comment on the selected line |
| `e` | Open the unit details: why it comes next, the context to keep in mind, the change summary, and every review question with its anchor |
| `i` | Open the frozen snapshot inventory |
| `s` | Open the comment summary and submission page |
| `?` | Open or close the keyboard reference on read-only screens |
| `Esc` | Return from a secondary page or open the pause and discard screen |

Comment threads:

| Key | Action |
|---|---|
| `j`, `k`, `Up`, `Down` | Select the next or previous comment thread |
| `PageUp`, `PageDown`, `Ctrl+f`, `Ctrl+b` | Scroll long thread content |
| `c` | Create or edit a draft follow-up in the selected open thread |
| `d` | Delete the selected thread's draft follow-up |
| `Enter` | Complete the follow-up review; when drafts exist, choose a mode and press Enter again to send them |
| `r` | Resolve an answered thread or reopen a thread resolved in the current view |
| `Esc` | Close the follow-up view; use `/diffwalk --threads` to reopen it |

## Review Rules

DiffWalk loads optional route-planning preferences from Markdown files:

| Scope | Path |
|---|---|
| Global | `~/.pi/agent/diffwalk/rules.md` |
| Project | `<repositoryRoot>/.pi/diffwalk/rules.md` |

The global path follows pi's agent configuration directory and honors `PI_CODING_AGENT_DIR`. A usable project file replaces the global file completely. Project rules are ignored with a warning when the project is not trusted, or when the rules file is itself part of the change under review, so unreviewed instructions cannot shape their own review. Each file is limited to 16 KiB of valid UTF-8.

Rules customize how the agent presents the review. They cannot change the frozen snapshot, the coverage requirements, or the route validation contract.

## Mechanical Exclusion

Some changed lines need no human judgment. DiffWalk removes them from the route before the agent plans it, using rules that are deterministic and explainable. No model is involved.

| Rule | What it matches | Source |
|---|---|---|
| Exclude patterns | Files matching a pattern in a DiffWalk exclude file | `~/.pi/agent/diffwalk/exclude` (global) or `<repositoryRoot>/.pi/diffwalk/exclude` (project) |
| Generated attribute | Files whose `linguist-generated` Git attribute is set | `.gitattributes`, the same convention GitHub uses to collapse generated files |
| Whitespace-only | Runs of changed lines that differ only in non-leading whitespace or blank lines, the lines `git diff -w` would hide | Always on |

Exclude files use gitignore syntax and are evaluated by Git itself, so negation, directory patterns, and anchoring behave exactly as in `.gitignore`. A usable project file replaces the global file completely. DiffWalk ships no default patterns; a typical global file looks like this:

```gitignore
package-lock.json
pnpm-lock.yaml
yarn.lock
Cargo.lock
go.sum
*.snap
```

Whitespace-only detection keeps leading whitespace significant. A reindented block always reaches the reviewer, because indentation carries meaning in some languages.

Exclusion hides code, so every project-owned source follows the same trust rule as project review rules. The project exclude file and `linguist-generated` attributes are ignored with a warning when the project is not trusted, or when the exclude file or any `.gitattributes` file is itself part of the change under review. The global exclude file is always honored. A path exclusion that Git cannot evaluate is reported, and the review continues with every changed line routed.

Excluded lines are visible in the inventory (`i`) with the rule that removed them, and appear as unselectable gaps inside a unit's span. They cannot be commented on during that review. To review them, run `/diffwalk --no-exclude`. Exclusion is recomputed on every round from the current snapshot; a line whose rule stops matching returns to review as a new line.

## Routine Units

Some units repeat a pattern the reviewer already trusts: a third route registration shaped like the first two, a test fixture mirroring its neighbors. The agent may mark such a unit `routine`, naming the existing code it mirrors as `reference` (a repository path, optionally with `:start-end` line numbers) and stating in `reason` what makes the unit a repetition.

DiffWalk accepts the claim only when the reference names a file that exists in the repository, the unit covers at most 40 changed lines, and no line in it carries an unresolved comment. Routineness is a claim about shape, never about safety; the kickoff prompt tells the agent not to mark new behavior, new control flow, or anything touching authorization, persistence formats, money, or external processes as routine.

In the walkthrough a routine unit is folded. The reviewer sees the change summary, the claim, the reference, and how many lines are folded, but no diff. `o` expands it into the ordinary unit view, where lines can be selected and commented; `o` again folds it. `n` on a folded unit accepts the claim and records the unit as glanced; `n` on an expanded unit records it as reviewed. Lines of a glanced unit count as reviewed and carry forward in later rounds. `r` on a walked unit records the reviewer's opinion that it could have been routine.

Each completed round keeps a per-unit record: whether the agent claimed routine, whether the reviewer glanced, expanded, or walked it, whether the reviewer marked it as a routine candidate, and whether it received comments. DiffWalk does not act on these records yet; they exist so that routine proposals can be tuned against real reviews.

## Guarantees

- Git output is the source of truth for every displayed change. The model never generates or rewrites the patch.
- The snapshot is immutable for the duration of a review.
- Every changed line is covered by exactly one review unit, explicitly skipped with a visible reason, or excluded by a mechanical rule that the inventory names. A line carrying an unresolved comment cannot be skipped, excluded, or placed in a routine unit.
- A routine claim never removes code from the route. A folded unit keeps its position, shows its claim and reference, and expands with one key.
- A unit is accepted or rejected on its own. A rejected unit never invalidates the units already accepted, and the walkthrough opens only after the completed route passes the full coverage check.
- Worktree drift is detected before comments are submitted. Comments and agent responses keep stable snapshot anchors even if the worktree changes later.
- Agent responses cannot resolve comments. Resolution is an explicit reviewer action.
- Binary files, renames, deletions, and other changes that cannot be reviewed line by line are represented or explicitly reported as unsupported.

These guarantees do not make the agent's explanation correct. They prevent the explanation from silently changing or hiding the code under review.

## Pausing and Drift

Pressing `Esc` pauses a review without returning draft comments to the agent. Running `/diffwalk` again in the same pi process resumes the route, progress, and drafts while the worktree still matches the snapshot.

A paused review does not lock the repository. If the worktree changes while a review is paused, the next `/diffwalk` reports the drift, discards the stale review with its drafts, and starts fresh. Switching to a different base while a review holds recorded work fails with instructions pointing at `/diffwalk --discard` instead of silently discarding that work.

## Limitations

- A paused walkthrough lives in extension memory only. It does not survive `/reload` or a pi restart. Completed rounds and comment threads do persist in the session.
- Detected code moves are reported to the agent for route planning but are not yet marked in the walkthrough screen.
- There is no GitHub pull request integration; DiffWalk reviews local Git state only.
- Mechanical exclusion is all or nothing per review. Excluded lines cannot be pulled back into the walkthrough one at a time or commented on; `/diffwalk --no-exclude` is the only override.
- A routine reference is checked for an existing file only. Line numbers in the reference are shown to the reviewer and not verified, and the referenced code is not compared with the unit.
- Per-unit round outcomes are recorded and persisted but not yet surfaced or used.

## Development

```bash
npm ci --ignore-scripts
npm run check
npm test
npm pack --dry-run --ignore-scripts
```

`npm run check` runs TypeScript and Biome without modifying files. `npm run format` explicitly applies formatting. There is no build step: pi loads the packaged TypeScript source directly. The npm package includes `src/`, `README.md`, `LICENSE`, and `package.json`, not tests or release scripts.

Before a release, manually verify navigation, scrolling, comment editing, submission, cancellation, narrow terminals, and Chinese IME input in pi. Automated tests do not replace terminal acceptance testing.

## Publishing

The release script uses Node.js and npm only. It supports explicit stable versions and `alpha.N` prereleases, including the first publication. The `pi-package` keyword enables discovery by pi's npm package catalog.

1. Merge the release changes, synchronize a clean `main` or `master` with the same branch on `origin`, and authenticate:

   ```bash
   npm login --registry=https://registry.npmjs.org/
   npm whoami --registry=https://registry.npmjs.org/
   ```

2. Run preflight for the first release:

   ```bash
   npm run release -- 0.1.0 --dry-run
   ```

3. Publish the checked version:

   ```bash
   npm run release -- 0.1.0
   ```

   Confirm the prompt to update `package.json` and `package-lock.json`, create the `Release v0.1.0` commit and annotated tag, atomically push the release branch and that tag, and publish to npm. Add `--yes` only when deliberately skipping confirmation. npm may still require authentication or an OTP.

4. If you want GitHub release notes, create a Release from `v0.1.0` without marking it as a pre-release. The script creates a Git tag, not a GitHub Release.

| Release | Command | npm dist-tag |
|---|---|---|
| First release | `npm run release -- 0.1.0` | `latest` |
| Patch release | `npm run release -- 0.1.1` | `latest` |
| Minor release | `npm run release -- 0.2.0` | `latest` |

The target must be newer than the local version and every published version. Other prerelease labels are intentionally unsupported. The release script passes `latest` for stable versions and `alpha` for optional `alpha.N` prereleases. Manual npm publication defaults to `latest` through `publishConfig.tag`.

Preflight verifies branch state, local and remote tag availability, npm authentication, published versions, static checks, tests, package contents, and a dry-run branch push. `--dry-run` performs network checks but does not bump a version, create a commit or tag, push changes, or publish. npm can still write its own cache or logs. Package lifecycle hooks are disabled. No dependency installation runs during release; install the lockfile first.

### Release failures

- **Preflight fails:** fix the reported problem and rerun the same command. No release changes were created.
- **Version, commit, tag, or push fails:** inspect `git status` and the local release commit and tag. npm publication was not attempted. Finish the release commit and tag if necessary, then push both together. Do not blindly run another version bump. Branch protection can reject a direct release push even after a dry-run push succeeds; do not bypass repository protections.
- **npm publication fails after the push:** check whether the exact version already exists with `npm view pi-diffwalk@0.1.0 version --registry=https://registry.npmjs.org/`. If absent, resolve the authentication or registry error and retry from the release commit:

  ```bash
  npm publish --ignore-scripts --access public --tag latest --registry=https://registry.npmjs.org/
  ```

  Use `--tag alpha` only when retrying an optional Alpha prerelease. Do not create another version to retry publication.
- **Registry verification fails:** publication may have succeeded. Inspect `npm view pi-diffwalk dist-tags --json --registry=https://registry.npmjs.org/` before taking further action.

## License

[MIT](LICENSE)

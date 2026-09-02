# DiffWalk

Agent-guided code review for [pi](https://github.com/earendil-works/pi).

Coding agents can produce changes faster than a human can rebuild the context needed to review them. A raw diff does not solve that problem. It shows what changed, but not where to begin, why a file matters, or which part of the system to inspect next.

DiffWalk turns a code review into a guided walkthrough. The agent plans a semantic route through the change and explains the context for each stop. DiffWalk renders the real Git diff one review unit at a time. The human reads the code, records comments, and decides whether the change is acceptable.

DiffWalk is a review navigator, not an autonomous reviewer. It does not approve code on your behalf, does not replace tests, static analysis, or security review, and does not let the agent edit code or rewrite the displayed patch during a walkthrough.

## Getting Started

```bash
npm ci --ignore-scripts
pi -e ./src/index.ts
```

Run `/diffwalk` from a Git worktree in pi's interactive TUI mode.

## Commands

| Command | Effect |
|---|---|
| `/diffwalk` | Review the current worktree against `HEAD`, including untracked files |
| `/diffwalk <base>` | Review the current worktree against a Git revision |
| `/diffwalk --threads` | Reopen the most recently viewed comment threads |
| `/diffwalk --discard` | Drop a pending review without opening it |

A Git revision cannot start with `-`, so an option never shadows a base. When the comparison contains no line that needs review, DiffWalk reports that and starts nothing.

## How a Review Works

1. DiffWalk freezes a snapshot of the current Git changes. Every changed line receives a stable address: a file, a side, and a line number.
2. The agent reads the change with its own tools and plans a review route: semantic units ordered by behavior, contracts, and data flow instead of file order. A unit may span several files, so an implementation and the test that proves it are read together.
3. DiffWalk validates the route. Every changed line must be covered by exactly one review unit or explicitly skipped with a visible reason.
4. The TUI walks you through the route one unit at a time. A one or two sentence change summary sits under the header. The agent's review questions hang beneath the diff lines they are about, and the line carries a `?` in its marker column; a question about the unit as a whole appears above the diff. The reasons the unit comes next and the contract to keep in mind stay on the details page. You attach comments to exact diff lines.
5. Submission returns all comments to the agent as one batch, in one of two modes: **Discuss first** (the agent investigates without editing code) or **Apply change requests**.
6. The agent answers every comment with a structured response. A follow-up view shows each conversation under its diff anchor. You can reply to continue a thread and resolve it when satisfied. Only the reviewer can resolve a thread.
7. Running `/diffwalk` again against the same base carries forward already-reviewed lines and resolved comments, and routes only what still needs review. Completed rounds and comment threads persist in the pi session across restarts.

```text
DiffWalk / Review                                  Unit 3/12
Authentication request validation
2/12 reviewed    1 comment · 1 skipped    [██        ]

The handler now validates the token issuer before creating a session.

  ? Do existing sessions stay valid after this change?

src/auth/handler.ts
     46    46   const request = await parse(raw)
     47    47   const token = request.headers.authorization
?    48        - if (!token) return unauthorized()
              ↳ Is the missing-token path still handled somewhere?
>          48 + const claims = await validateToken(token)
?          49 + if (claims.issuer !== config.issuer) return unauthorized()
              ↳ Is the trusted issuer read from configuration rather than the token?
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
| `n` | Mark the current review unit as reviewed and continue; the last unit opens the submission page |
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

## Guarantees

- Git output is the source of truth for every displayed change. The model never generates or rewrites the patch.
- The snapshot is immutable for the duration of a review.
- Every changed line that needs review is covered by exactly one review unit or explicitly skipped with a visible reason. A line carrying an unresolved comment cannot be skipped.
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

## License

[MIT](LICENSE)

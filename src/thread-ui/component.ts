import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Editor,
  type EditorTheme,
  type Focusable,
  Key,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { REVIEW_COMMENT_CONTEXT_RADIUS } from "../review/comments.ts";
import {
  appendReviewThreadTurn,
  clearReviewThreadDraft,
  isReviewThreadAnswered,
  pendingReviewThreadTurn,
  ReviewThreadError,
  setReviewThreadDraft,
  setReviewThreadResolved,
} from "../review/threads.ts";
import type {
  DiffLine,
  FileChange,
  ReviewCommentId,
  ReviewCommentThread,
  ReviewSnapshot,
  ReviewSubmissionMode,
  ReviewThreadBatch,
  ReviewThreadTurnId,
} from "../review/types.ts";
import {
  countNoun,
  fitColumns,
  fitLine,
  MEDIUM_HEADER_WIDTH,
  type PrioritizedLineGroup,
  packStatusParts,
  selectHeaderGroups,
  WIDE_HEADER_WIDTH,
} from "../ui/layout.ts";

export interface ReviewThreadUiInput {
  readonly snapshot: ReviewSnapshot;
  readonly batch: ReviewThreadBatch;
  readonly onBatchChange: (batch: ReviewThreadBatch) => void;
}

export type ReviewThreadUiResult =
  | {
      readonly status: "closed";
      readonly batch: ReviewThreadBatch;
    }
  | {
      readonly status: "follow-up-submitted";
      readonly batch: ReviewThreadBatch;
      readonly turnId: ReviewThreadTurnId;
    };

type ThreadUiTheme = Pick<Theme, "fg" | "bg" | "bold">;
type ThreadScreen = "threads" | "reply-editor" | "submission";

interface ThreadRegion {
  readonly change: FileChange;
  start: number;
  end: number;
  readonly threads: ReviewCommentThread[];
}

interface RenderedThreadRow {
  readonly text: string;
  readonly commentId?: ReviewCommentId;
}

interface ReviewThreadComponentOptions extends ReviewThreadUiInput {
  readonly tui: TUI;
  readonly theme: ThreadUiTheme;
  readonly onClose: (result: ReviewThreadUiResult) => void;
}

export class ReviewThreadUiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewThreadUiError";
  }
}

export async function openReviewThreads(
  ctx: Pick<ExtensionContext, "mode" | "ui">,
  input: ReviewThreadUiInput,
): Promise<ReviewThreadUiResult> {
  if (ctx.mode !== "tui") {
    throw new ReviewThreadUiError(
      `DiffWalk comment threads require interactive TUI mode; current mode is ${ctx.mode}.`,
    );
  }
  assertBatchMatchesSnapshot(input.batch, input.snapshot);

  return ctx.ui.custom<ReviewThreadUiResult>(
    (tui, theme, _keybindings, done) =>
      new ReviewThreadComponent({
        ...input,
        tui,
        theme,
        onClose: done,
      }),
    {
      overlay: true,
      overlayOptions: {
        width: "100%",
        maxHeight: "100%",
        anchor: "top-left",
        margin: 0,
      },
    },
  );
}

export class ReviewThreadComponent implements Component, Focusable {
  private readonly snapshot: ReviewSnapshot;
  private batch: ReviewThreadBatch;
  private readonly tui: TUI;
  private readonly theme: ThreadUiTheme;
  private readonly onBatchChange: (batch: ReviewThreadBatch) => void;
  private readonly onClose: (result: ReviewThreadUiResult) => void;
  private readonly hiddenResolvedThreadIds: ReadonlySet<ReviewCommentId>;
  private readonly regions: readonly ThreadRegion[];
  private readonly editor: Editor;
  private screen: ThreadScreen = "threads";
  private submissionMode: ReviewSubmissionMode;
  private threadIndex = 0;
  private offset = 0;
  private freeScroll = false;
  private feedback?: string;
  private replyInputError?: string;
  private cachedWidth?: number;
  private cachedRows?: number;
  private cachedLines?: readonly string[];
  private _focused = false;

  constructor(options: ReviewThreadComponentOptions) {
    assertBatchMatchesSnapshot(options.batch, options.snapshot);
    this.snapshot = structuredClone(options.snapshot);
    this.batch = structuredClone(options.batch);
    this.hiddenResolvedThreadIds = new Set(
      this.batch.threads
        .filter((thread) => thread.resolved)
        .map((thread) => thread.id),
    );
    this.tui = options.tui;
    this.theme = options.theme;
    this.onBatchChange = options.onBatchChange;
    this.onClose = options.onClose;
    this.regions = buildThreadRegions(this.snapshot, this.batch);
    this.submissionMode =
      this.batch.turns.at(-1)?.submissionMode ?? "discuss-first";
    this.editor = new Editor(this.tui, createEditorTheme(this.theme), {
      paddingX: 0,
    });
    this.editor.onSubmit = (body) => this.saveDraftReply(body);
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    if (this._focused === value) return;
    this._focused = value;
    this.syncEditorFocus();
    this.refresh();
  }

  render(width: number): string[] {
    const renderWidth = Math.max(1, Math.floor(width));
    const terminalRows = Math.max(1, this.tui.terminal.rows);
    if (
      this.cachedWidth === renderWidth &&
      this.cachedRows === terminalRows &&
      this.cachedLines !== undefined
    ) {
      return [...this.cachedLines];
    }
    const lines =
      this.screen === "threads"
        ? this.renderThreads(renderWidth, terminalRows)
        : this.screen === "reply-editor"
          ? this.renderReplyEditor(renderWidth, terminalRows)
          : this.renderSubmission(renderWidth, terminalRows);
    const screen = fillScreenHeight(lines, terminalRows).map((line) =>
      fillLine(oneTerminalLine(line), renderWidth),
    );
    this.cachedWidth = renderWidth;
    this.cachedRows = terminalRows;
    this.cachedLines = screen;
    return [...screen];
  }

  handleInput(data: string): void {
    switch (this.screen) {
      case "threads":
        this.handleThreadsInput(data);
        break;
      case "reply-editor":
        this.handleReplyEditorInput(data);
        break;
      case "submission":
        this.handleSubmissionInput(data);
        break;
    }
  }

  invalidate(): void {
    this.clearCache();
    this.editor.invalidate();
  }

  private renderThreads(width: number, rows: number): readonly string[] {
    const header = this.renderHeader(width, rows);
    const footer = [
      fitLine(
        this.theme.fg(
          "dim",
          "j/k thread • PgUp/PgDn scroll • c reply • d delete draft • Enter complete • r resolve/reopen • Esc close",
        ),
        width,
      ),
    ];
    const feedback =
      this.feedback === undefined
        ? []
        : wrapStyled(this.theme.fg("warning", safeText(this.feedback)), width);
    const viewportHeight = Math.max(
      0,
      rows - header.length - feedback.length - footer.length,
    );
    const renderedRows = renderThreadRows(
      this.regions,
      this.batch,
      this.currentThread()?.id,
      this.hiddenResolvedThreadIds,
      this.theme,
      width,
    );
    this.offset = this.freeScroll
      ? clampOffset(this.offset, renderedRows.length, viewportHeight)
      : ensureThreadVisible(
          renderedRows,
          this.currentThread()?.id,
          this.offset,
          viewportHeight,
        );
    return [
      ...header,
      ...feedback,
      ...renderedRows
        .slice(this.offset, this.offset + viewportHeight)
        .map((row) => row.text),
      ...footer,
    ];
  }

  private renderReplyEditor(width: number, rows: number): readonly string[] {
    const thread = this.currentThread();
    const header = renderScreenHeader(
      "Reply",
      "Reviewer follow-up",
      thread?.id,
      this.theme,
      width,
      rows,
    );
    const footer = [
      fitLine(
        this.theme.fg(
          "dim",
          "Enter save draft • Shift+Enter newline • Esc discard edit",
        ),
        width,
      ),
    ];
    const bodyHeight = Math.max(0, rows - header.length - footer.length);
    const editorLines = this.editor.render(width);
    const minimumEditorHeight = Math.min(
      Math.max(1, editorLines.length),
      Math.max(1, bodyHeight - 2),
      3,
    );
    const errorLines =
      this.replyInputError === undefined
        ? []
        : wrapStyled(
            this.theme.fg("warning", safeText(this.replyInputError)),
            width,
          );
    const errorHeight = Math.min(
      errorLines.length,
      Math.max(0, bodyHeight - minimumEditorHeight),
    );
    const region =
      thread === undefined
        ? undefined
        : this.regions.find((candidate) =>
            candidate.threads.some((entry) => entry.id === thread.id),
          );
    const context =
      thread === undefined || region === undefined
        ? []
        : renderReplyContext(
            region,
            thread,
            this.batch,
            Math.max(0, bodyHeight - minimumEditorHeight - errorHeight - 1),
            this.theme,
            width,
          );
    const separator = context.length > 0 && context.at(-1) !== "" ? [""] : [];
    const editorHeight = Math.max(
      0,
      bodyHeight - context.length - separator.length - errorHeight,
    );
    return [
      ...header,
      ...context,
      ...separator,
      ...errorLines.slice(0, errorHeight),
      ...editorViewport(editorLines, editorHeight),
      ...footer,
    ];
  }

  private renderSubmission(width: number, rows: number): readonly string[] {
    const drafts = this.draftThreads();
    const header = renderScreenHeader(
      "Follow-up",
      `${countNoun(drafts.length, "reply")} ready`,
      undefined,
      this.theme,
      width,
      rows,
    );
    const footer = [
      fitLine(
        this.theme.fg(
          "dim",
          "←/→ or h/l mode • Enter send to Agent • Esc return",
        ),
        width,
      ),
    ];
    const content = [
      ...wrapStyled(
        this.theme.fg(
          "muted",
          `Anchored to frozen snapshot ${this.batch.snapshotId}. New code requires another /diffwalk review.`,
        ),
        width,
      ),
      "",
      renderMode(
        "discuss-first",
        "Discuss first",
        "Agent investigates and responds without editing files.",
        this.submissionMode,
        this.theme,
        width,
      ),
      renderMode(
        "apply-change-requests",
        "Apply change requests",
        "Agent may apply direct requests before responding.",
        this.submissionMode,
        this.theme,
        width,
      ),
      "",
      ...drafts.flatMap((thread) => [
        ...wrapStyled(
          this.theme.fg("accent", this.theme.bold(`[${thread.id}]`)),
          width,
        ),
        ...wrapWithPrefix(
          "  ",
          this.theme.fg("text", safeText(thread.draftReply ?? "")),
          width,
        ),
        "",
      ]),
    ];
    const bodyHeight = Math.max(0, rows - header.length - footer.length);
    return [...header, ...content.slice(0, bodyHeight), ...footer];
  }

  private renderHeader(width: number, rows: number): readonly string[] {
    const total = this.batch.threads.length;
    const visible = this.visibleThreads().length;
    const answered = this.batch.threads.filter((thread) =>
      isReviewThreadAnswered(this.batch, thread.id),
    ).length;
    const resolved = this.batch.threads.filter(
      (thread) => thread.resolved,
    ).length;
    const drafts = this.draftThreads().length;
    const current = this.currentThread();
    const position =
      visible === 0
        ? "No open threads"
        : `Thread ${this.threadIndex + 1}/${visible}`;
    const title =
      current === undefined
        ? this.theme.fg(
            "success",
            this.theme.bold("All conversations resolved"),
          )
        : renderThreadHeadline(
            { id: current.id, resolved: current.resolved },
            this.theme,
          );
    const statusParts = [
      `${answered}/${total} answered`,
      `${resolved}/${total} resolved`,
      countNoun(drafts, "draft"),
    ];
    const brand = this.theme.fg(
      "accent",
      this.theme.bold("DiffWalk / Threads"),
    );
    const groups: PrioritizedLineGroup[] = [];

    if (width >= WIDE_HEADER_WIDTH) {
      groups.push(
        {
          lines: [fitColumns(brand, this.theme.fg("muted", position), width)],
          priority: 90,
        },
        {
          lines: [
            fitColumns(
              title,
              this.theme.fg("muted", statusParts.join(" · ")),
              width,
            ),
          ],
          priority: 80,
        },
      );
    } else if (width >= MEDIUM_HEADER_WIDTH) {
      groups.push(
        {
          lines: [
            fitLine(`${brand}${this.theme.fg("dim", ` · ${position}`)}`, width),
          ],
          priority: 90,
        },
        {
          lines: [fitLine(title, width)],
          priority: 80,
        },
        {
          lines: packStatusParts(statusParts, width).map((line) =>
            fitLine(this.theme.fg("muted", line), width),
          ),
          priority: 40,
          minimumRows: 6,
        },
      );
    } else {
      groups.push(
        { lines: [fitLine(brand, width)], priority: 90 },
        {
          lines: [fitLine(this.theme.fg("muted", position), width)],
          priority: 70,
        },
        {
          lines: [fitLine(title, width)],
          priority: 80,
        },
        {
          lines: packStatusParts(statusParts, width).map((line) =>
            fitLine(this.theme.fg("muted", line), width),
          ),
          priority: 40,
          minimumRows: 10,
        },
      );
    }
    return selectHeaderGroups(groups, rows, 2);
  }

  private handleThreadsInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.onClose({ status: "closed", batch: structuredClone(this.batch) });
      return;
    }
    if (matchesKey(data, "k") || matchesKey(data, Key.up)) {
      this.moveThread(-1);
      return;
    }
    if (matchesKey(data, "j") || matchesKey(data, Key.down)) {
      this.moveThread(1);
      return;
    }
    if (matchesKey(data, Key.pageUp) || matchesKey(data, "ctrl+b")) {
      this.page(-1);
      return;
    }
    if (matchesKey(data, Key.pageDown) || matchesKey(data, "ctrl+f")) {
      this.page(1);
      return;
    }
    if (matchesKey(data, "c")) {
      this.openReplyEditor();
      return;
    }
    if (matchesKey(data, "d")) {
      this.deleteDraft();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.completeReview();
      return;
    }
    if (matchesKey(data, "r")) this.toggleResolved();
  }

  private handleReplyEditorInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.editor.setText("");
      this.replyInputError = undefined;
      this.openScreen("threads");
      return;
    }
    this.replyInputError = undefined;
    this.editor.handleInput(data);
    this.refresh();
  }

  private handleSubmissionInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.openScreen("threads");
      return;
    }
    if (
      matchesKey(data, Key.left) ||
      matchesKey(data, Key.right) ||
      matchesKey(data, "h") ||
      matchesKey(data, "l") ||
      matchesKey(data, "j") ||
      matchesKey(data, "k")
    ) {
      this.submissionMode =
        this.submissionMode === "discuss-first"
          ? "apply-change-requests"
          : "discuss-first";
      this.refresh();
      return;
    }
    if (matchesKey(data, Key.enter)) this.submitFollowUps();
  }

  private currentThread(): ReviewCommentThread | undefined {
    return this.visibleThreads()[this.threadIndex];
  }

  private visibleThreads(): readonly ReviewCommentThread[] {
    return this.batch.threads.filter(
      (thread) => !this.hiddenResolvedThreadIds.has(thread.id),
    );
  }

  private draftThreads(): readonly ReviewCommentThread[] {
    return this.batch.threads.filter(
      (thread) => thread.draftReply !== undefined,
    );
  }

  private moveThread(delta: number): void {
    this.threadIndex = clamp(
      this.threadIndex + delta,
      0,
      this.visibleThreads().length - 1,
    );
    this.freeScroll = false;
    this.feedback = undefined;
    this.refresh();
  }

  private page(direction: -1 | 1): void {
    this.feedback = undefined;
    const width = Math.max(1, this.tui.terminal.columns);
    const rows = Math.max(1, this.tui.terminal.rows);
    const viewportHeight = Math.max(
      1,
      rows - this.renderHeader(width, rows).length - 1,
    );
    this.offset = Math.max(0, this.offset + direction * viewportHeight);
    this.freeScroll = true;
    this.refresh();
  }

  private openReplyEditor(): void {
    const thread = this.currentThread();
    if (thread === undefined) return;
    if (thread.resolved) {
      this.feedback = `Thread ${thread.id} must be reopened before replying.`;
      this.refresh();
      return;
    }
    const pending = pendingReviewThreadTurn(this.batch);
    if (pending !== undefined) {
      this.feedback = `Turn ${pending.id} is still awaiting Agent responses.`;
      this.refresh();
      return;
    }
    this.editor.setText(thread.draftReply ?? "");
    this.replyInputError = undefined;
    this.feedback = undefined;
    this.openScreen("reply-editor");
  }

  private saveDraftReply(body: string): void {
    const thread = this.currentThread();
    if (thread === undefined) return;
    try {
      this.updateBatch(setReviewThreadDraft(this.batch, thread.id, body));
      this.editor.setText("");
      this.replyInputError = undefined;
      this.openScreen("threads");
    } catch (error: unknown) {
      if (error instanceof ReviewThreadError) {
        this.replyInputError = error.message;
        this.syncEditorFocus();
        this.refresh();
        return;
      }
      throw error;
    }
  }

  private deleteDraft(): void {
    const thread = this.currentThread();
    if (thread === undefined) return;
    const next = clearReviewThreadDraft(this.batch, thread.id);
    if (next === this.batch) {
      this.feedback = `Thread ${thread.id} has no draft reply.`;
    } else {
      this.updateBatch(next);
      this.feedback = `Deleted the draft reply for ${thread.id}.`;
    }
    this.refresh();
  }

  private completeReview(): void {
    if (this.draftThreads().length === 0) {
      this.onClose({ status: "closed", batch: structuredClone(this.batch) });
      return;
    }
    this.feedback = undefined;
    this.openScreen("submission");
  }

  private submitFollowUps(): void {
    const drafts = this.draftThreads();
    if (drafts.length === 0) {
      this.openScreen("threads");
      return;
    }
    const submitted = appendReviewThreadTurn(this.batch, {
      submissionMode: this.submissionMode,
      replies: drafts.map((thread) => ({
        threadId: thread.id,
        body: thread.draftReply ?? "",
      })),
    });
    this.updateBatch(submitted);
    const turn = submitted.turns.at(-1);
    if (turn === undefined) {
      throw new ReviewThreadUiError(
        `Batch ${submitted.id} has no submitted follow-up turn.`,
      );
    }
    this.onClose({
      status: "follow-up-submitted",
      batch: structuredClone(submitted),
      turnId: turn.id,
    });
  }

  private toggleResolved(): void {
    const thread = this.currentThread();
    if (thread === undefined) return;
    try {
      this.updateBatch(
        setReviewThreadResolved(this.batch, thread.id, !thread.resolved),
      );
      this.feedback = undefined;
    } catch (error: unknown) {
      if (error instanceof ReviewThreadError) {
        this.feedback = error.message;
      } else {
        throw error;
      }
    }
    this.refresh();
  }

  private updateBatch(batch: ReviewThreadBatch): void {
    this.batch = batch;
    this.onBatchChange(structuredClone(batch));
  }

  private openScreen(screen: ThreadScreen): void {
    this.screen = screen;
    this.syncEditorFocus();
    this.refresh();
  }

  private syncEditorFocus(): void {
    this.editor.focused = this._focused && this.screen === "reply-editor";
  }

  private clearCache(): void {
    this.cachedWidth = undefined;
    this.cachedRows = undefined;
    this.cachedLines = undefined;
  }

  private refresh(): void {
    this.clearCache();
    this.tui.requestRender();
  }
}

function assertBatchMatchesSnapshot(
  batch: ReviewThreadBatch,
  snapshot: ReviewSnapshot,
): void {
  if (batch.snapshotId !== snapshot.id) {
    throw new ReviewThreadUiError(
      `Thread batch ${batch.id} references snapshot ${batch.snapshotId}, not ${snapshot.id}.`,
    );
  }
  if (batch.threads.length === 0 || batch.turns.length === 0) {
    throw new ReviewThreadUiError(`Thread batch ${batch.id} is empty.`);
  }
}

function buildThreadRegions(
  snapshot: ReviewSnapshot,
  batch: ReviewThreadBatch,
): readonly ThreadRegion[] {
  const changes = new Map(
    snapshot.changes.map((change) => [change.id, change]),
  );
  const regions: ThreadRegion[] = [];

  for (const thread of batch.threads) {
    const change = changes.get(thread.anchor.fileChangeId);
    if (change === undefined) {
      throw new ReviewThreadUiError(
        `Thread ${thread.id} references missing file change ${thread.anchor.fileChangeId}.`,
      );
    }
    if (change.content.type !== "text") {
      throw new ReviewThreadUiError(
        `Thread ${thread.id} references non-text file change ${change.id}.`,
      );
    }
    const anchorIndex = change.content.lines.findIndex((line) =>
      thread.anchor.side === "new"
        ? line.newLine === thread.anchor.line && line.type === "added"
        : line.oldLine === thread.anchor.line && line.type === "removed",
    );
    if (anchorIndex < 0) {
      throw new ReviewThreadUiError(
        `Thread ${thread.id} anchor is missing from frozen snapshot ${snapshot.id}.`,
      );
    }
    const start = Math.max(0, anchorIndex - REVIEW_COMMENT_CONTEXT_RADIUS);
    const end = Math.min(
      change.content.lines.length - 1,
      anchorIndex + REVIEW_COMMENT_CONTEXT_RADIUS,
    );
    const previous = regions.at(-1);
    if (
      previous !== undefined &&
      previous.change.id === change.id &&
      start <= previous.end + 1
    ) {
      previous.end = Math.max(previous.end, end);
      previous.threads.push(thread);
    } else {
      regions.push({ change, start, end, threads: [thread] });
    }
  }
  return regions;
}

function renderThreadRows(
  regions: readonly ThreadRegion[],
  batch: ReviewThreadBatch,
  selectedId: ReviewCommentId | undefined,
  hiddenResolvedThreadIds: ReadonlySet<ReviewCommentId>,
  theme: ThreadUiTheme,
  width: number,
): readonly RenderedThreadRow[] {
  const currentThreads = new Map(
    batch.threads.map((thread) => [thread.id, thread]),
  );
  const rows: RenderedThreadRow[] = [];
  for (const region of regions) {
    const visibleRegionThreads = region.threads.filter(
      (thread) => !hiddenResolvedThreadIds.has(thread.id),
    );
    if (visibleRegionThreads.length === 0) continue;
    if (rows.length > 0) rows.push({ text: "" });
    rows.push(
      ...wrapStyled(
        theme.fg("accent", theme.bold(displayChangePath(region.change))),
        width,
      ).map((text) => ({ text })),
    );
    if (region.change.content.type !== "text") {
      throw new ReviewThreadUiError(
        `Thread region references non-text file change ${region.change.id}.`,
      );
    }
    const threadsByAnchor = new Map<number, ReviewCommentThread[]>();
    for (const original of visibleRegionThreads) {
      const thread = currentThreads.get(original.id) ?? original;
      const anchorIndex = region.change.content.lines.findIndex((line) =>
        thread.anchor.side === "new"
          ? line.newLine === thread.anchor.line && line.type === "added"
          : line.oldLine === thread.anchor.line && line.type === "removed",
      );
      const list = threadsByAnchor.get(anchorIndex) ?? [];
      list.push(thread);
      threadsByAnchor.set(anchorIndex, list);
    }
    for (let index = region.start; index <= region.end; index += 1) {
      const line = region.change.content.lines[index];
      if (line === undefined) continue;
      rows.push(
        ...renderDiffLine(line, theme, width).map((text) => ({ text })),
      );
      for (const thread of threadsByAnchor.get(index) ?? []) {
        rows.push(
          ...renderThread(
            thread,
            batch,
            thread.id === selectedId,
            theme,
            width,
          ),
        );
      }
    }
  }
  return rows;
}

const DIFF_GUTTER_WIDTH = 14;
const THREAD_CARD_MAX_WIDTH = 120;

function renderThread(
  thread: ReviewCommentThread,
  batch: ReviewThreadBatch,
  selected: boolean,
  theme: ThreadUiTheme,
  width: number,
): readonly RenderedThreadRow[] {
  return [
    ...renderThreadTurnBlocks(thread, batch, selected, theme, width).flat(),
    ...renderThreadDraftBlock(thread, theme, width),
  ];
}

/** One block per answered or pending turn, each ending in a blank row. */
function renderThreadTurnBlocks(
  thread: ReviewCommentThread,
  batch: ReviewThreadBatch,
  selected: boolean,
  theme: ThreadUiTheme,
  width: number,
): readonly (readonly RenderedThreadRow[])[] {
  const blocks: RenderedThreadRow[][] = [];
  const cardWidth = widthAfterMargin(width, DIFF_GUTTER_WIDTH);
  const contentWidth = Math.min(cardWidth, THREAD_CARD_MAX_WIDTH);
  let first = true;

  for (const turn of batch.turns) {
    const item = turn.items.find(
      (candidate) => candidate.threadId === thread.id,
    );
    if (item === undefined) continue;
    const selectionMarker = selected && first ? "▌" : " ";
    const turnLabel = `Turn ${turn.sequence}`;
    const reviewerMetadata = renderThreadHeadline(
      {
        marker: selectionMarker,
        id: thread.id,
        ...(first ? { resolved: thread.resolved } : {}),
        turnLabel,
      },
      theme,
    );
    const reviewerRows = [
      ...wrapStyled(reviewerMetadata, contentWidth),
      theme.fg("muted", theme.bold("  You")),
      ...wrapWithPrefix(
        "  ",
        theme.fg("text", safeText(item.reviewerBody)),
        contentWidth,
      ),
    ];
    const response = item.agentResponse?.body ?? "Awaiting Agent response.";
    const agentRows = [
      theme.fg("muted", theme.bold("  Agent")),
      ...wrapWithPrefix(
        "  ",
        theme.fg(
          item.agentResponse === undefined ? "warning" : "text",
          safeText(response),
        ),
        contentWidth,
      ),
    ];
    blocks.push([
      ...renderBackgroundBlock(
        reviewerRows,
        "userMessageBg",
        theme,
        width,
        DIFF_GUTTER_WIDTH,
      ).map((text) => ({ text, commentId: thread.id })),
      ...renderBackgroundBlock(
        agentRows,
        "customMessageBg",
        theme,
        width,
        DIFF_GUTTER_WIDTH,
      ).map((text) => ({ text, commentId: thread.id })),
      { text: "", commentId: thread.id },
    ]);
    first = false;
  }
  return blocks;
}

function renderThreadDraftBlock(
  thread: ReviewCommentThread,
  theme: ThreadUiTheme,
  width: number,
): readonly RenderedThreadRow[] {
  if (thread.draftReply === undefined) return [];
  const cardWidth = widthAfterMargin(width, DIFF_GUTTER_WIDTH);
  const contentWidth = Math.min(cardWidth, THREAD_CARD_MAX_WIDTH);
  const draftRows = [
    ...wrapStyled(
      theme.fg("accent", theme.bold("  Draft follow-up")),
      contentWidth,
    ),
    ...wrapWithPrefix(
      "  ",
      theme.fg("text", safeText(thread.draftReply)),
      contentWidth,
    ),
  ];
  return [
    ...renderBackgroundBlock(
      draftRows,
      "userMessageBg",
      theme,
      width,
      DIFF_GUTTER_WIDTH,
    ).map((text) => ({ text, commentId: thread.id })),
    { text: "", commentId: thread.id },
  ];
}

/**
 * Rows shown above the reply editor: the anchored diff line and the
 * conversation being answered. Earlier turns are dropped before the latest
 * turn is cut, so the reply is always written against the newest response.
 */
function renderReplyContext(
  region: ThreadRegion,
  thread: ReviewCommentThread,
  batch: ReviewThreadBatch,
  height: number,
  theme: ThreadUiTheme,
  width: number,
): readonly string[] {
  if (height <= 0) return [];
  if (region.change.content.type !== "text") {
    throw new ReviewThreadUiError(
      `Thread ${thread.id} references non-text file change ${region.change.id}.`,
    );
  }
  const anchorLine = region.change.content.lines.find((line) =>
    thread.anchor.side === "new"
      ? line.newLine === thread.anchor.line && line.type === "added"
      : line.oldLine === thread.anchor.line && line.type === "removed",
  );
  if (anchorLine === undefined) {
    throw new ReviewThreadUiError(
      `Thread ${thread.id} anchor is missing from its frozen file change.`,
    );
  }
  const anchor = [
    ...wrapStyled(
      theme.fg("accent", theme.bold(displayChangePath(region.change))),
      width,
    ),
    ...renderDiffLine(anchorLine, theme, width),
  ].slice(0, height);
  const blocks = renderThreadTurnBlocks(thread, batch, false, theme, width).map(
    (block) => block.map((row) => row.text),
  );
  let remaining = height - anchor.length;
  const kept: string[][] = [];
  for (const block of [...blocks].reverse()) {
    if (block.length > remaining) break;
    kept.unshift(block);
    remaining -= block.length;
  }
  if (kept.length === 0) {
    const latest = blocks.at(-1) ?? [];
    const visible = latest.slice(0, remaining);
    if (visible.length > 0 && visible.length < latest.length) {
      visible[visible.length - 1] = fitLine(
        `${" ".repeat(clampedMargin(width, DIFF_GUTTER_WIDTH))}${theme.fg("dim", "…")}`,
        width,
      );
    }
    return [...anchor, ...visible];
  }
  const dropped = blocks.length - kept.length;
  const rows = kept.flat();
  if (dropped > 0 && remaining >= 1) {
    rows.unshift(
      fitLine(
        `${" ".repeat(clampedMargin(width, DIFF_GUTTER_WIDTH))}${theme.fg(
          "dim",
          `… ${countNoun(dropped, "earlier turn")}`,
        )}`,
        width,
      ),
    );
  }
  return [...anchor, ...rows];
}

function renderDiffLine(
  line: DiffLine,
  theme: ThreadUiTheme,
  width: number,
): readonly string[] {
  const oldLine = line.oldLine === undefined ? "" : String(line.oldLine);
  const newLine = line.newLine === undefined ? "" : String(line.newLine);
  const prefix = `  ${oldLine.padStart(5)} ${newLine.padStart(5)} `;
  const marker =
    line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
  return wrapWithPrefix(
    prefix,
    theme.fg(diffColor(line), `${marker}${safeText(line.text)}`),
    width,
  );
}

interface ThreadHeadlineOptions {
  readonly marker?: string;
  readonly id: ReviewCommentId;
  readonly resolved?: boolean;
  readonly turnLabel?: string;
}

function renderThreadHeadline(
  options: ThreadHeadlineOptions,
  theme: ThreadUiTheme,
): string {
  const marker =
    options.marker === undefined
      ? ""
      : `${theme.fg("accent", theme.bold(options.marker))} `;
  const segments = [
    `${marker}${theme.fg("text", theme.bold(options.id))}`,
    ...(options.resolved === undefined
      ? []
      : [renderThreadStatus(options.resolved, theme)]),
    ...(options.turnLabel === undefined
      ? []
      : [theme.fg("accent", theme.bold(options.turnLabel))]),
  ];
  return segments.join(theme.fg("dim", " · "));
}

function renderThreadStatus(resolved: boolean, theme: ThreadUiTheme): string {
  return theme.fg(
    resolved ? "success" : "accent",
    theme.bold(resolved ? "✓ Resolved" : "○ Open"),
  );
}

function renderMode(
  value: ReviewSubmissionMode,
  title: string,
  description: string,
  selectedMode: ReviewSubmissionMode,
  theme: ThreadUiTheme,
  width: number,
): string {
  const selected = value === selectedMode;
  const text = `${selected ? ">" : " "} ${title}: ${description}`;
  const fitted = truncateToWidth(safeText(text), width, "", true);
  return selected
    ? theme.bg("selectedBg", theme.fg("text", fitted))
    : theme.fg("dim", fitted);
}

function createEditorTheme(theme: ThreadUiTheme): EditorTheme {
  return {
    borderColor: (text) => theme.fg("accent", text),
    selectList: {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    },
  };
}

function ensureThreadVisible(
  rows: readonly RenderedThreadRow[],
  commentId: ReviewCommentId | undefined,
  offset: number,
  viewportHeight: number,
): number {
  if (commentId === undefined || viewportHeight <= 0) return 0;
  const first = rows.findIndex((row) => row.commentId === commentId);
  let last = -1;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index]?.commentId === commentId) {
      last = index;
      break;
    }
  }
  if (first < 0) return clampOffset(offset, rows.length, viewportHeight);
  let next = clampOffset(offset, rows.length, viewportHeight);
  if (last - first + 1 > viewportHeight) {
    if (first >= next + viewportHeight || last < next) next = first;
  } else if (first < next) next = first;
  else if (last >= next + viewportHeight) next = last - viewportHeight + 1;
  return clampOffset(next, rows.length, viewportHeight);
}

function displayChangePath(change: FileChange): string {
  if (
    change.oldPath !== undefined &&
    change.newPath !== undefined &&
    change.oldPath !== change.newPath
  ) {
    return `${displayBarePath(change.oldPath)} -> ${displayBarePath(change.newPath)}`;
  }
  const path = change.newPath ?? change.oldPath;
  return path === undefined ? "<unknown path>" : displayBarePath(path);
}

function displayBarePath(path: string): string {
  return safeText(JSON.stringify(path).slice(1, -1));
}

function diffColor(line: DiffLine): Parameters<ThreadUiTheme["fg"]>[0] {
  switch (line.type) {
    case "added":
      return "toolDiffAdded";
    case "removed":
      return "toolDiffRemoved";
    case "context":
      return "toolDiffContext";
  }
}

function editorViewport(
  lines: readonly string[],
  height: number,
): readonly string[] {
  if (height <= 0) return [];
  if (lines.length <= height) return lines;
  const content = lines.slice(0, -1);
  if (content.length === 0) return lines.slice(0, height);
  if (height === 1) return content.slice(-1);
  return [...content.slice(-(height - 1)), lines.at(-1) ?? ""];
}

function wrapWithPrefix(prefix: string, text: string, width: number): string[] {
  const prefixWidth = visibleWidth(prefix);
  if (prefixWidth >= width) return wrapStyled(`${prefix}${text}`, width);
  const wrapped = wrapStyled(text, width - prefixWidth);
  const continuation = " ".repeat(prefixWidth);
  return wrapped.map(
    (line, index) => `${index === 0 ? prefix : continuation}${line}`,
  );
}

function wrapStyled(text: string, width: number): string[] {
  return wrapTextWithAnsi(text, Math.max(1, width)).map((line) =>
    fitLine(line, width),
  );
}

function renderScreenHeader(
  screen: string,
  title: string,
  right: string | undefined,
  theme: ThreadUiTheme,
  width: number,
  rows: number,
): readonly string[] {
  const brand = theme.fg("accent", theme.bold(`DiffWalk / ${screen}`));
  return selectHeaderGroups(
    [
      {
        lines: [
          right === undefined
            ? fitLine(brand, width)
            : fitColumns(brand, theme.fg("muted", right), width),
        ],
        priority: 90,
      },
      {
        lines: [fitLine(theme.fg("text", theme.bold(title)), width)],
        priority: 80,
      },
    ],
    rows,
    2,
  );
}

function fillLine(line: string, width: number): string {
  const fitted = fitLine(line, width);
  return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}

function renderBackgroundBlock(
  lines: readonly string[],
  background: Parameters<ThreadUiTheme["bg"]>[0],
  theme: ThreadUiTheme,
  width: number,
  leftMargin: number,
): readonly string[] {
  const margin = clampedMargin(width, leftMargin);
  const backgroundWidth = widthAfterMargin(width, leftMargin);
  const prefix = " ".repeat(margin);
  return lines.map(
    (line) =>
      `${prefix}${theme.bg(background, fillLine(line, backgroundWidth))}`,
  );
}

function clampedMargin(width: number, margin: number): number {
  return Math.min(Math.max(0, margin), Math.max(0, width - 1));
}

function widthAfterMargin(width: number, margin: number): number {
  return Math.max(1, width - clampedMargin(width, margin));
}

function fillScreenHeight(
  lines: readonly string[],
  rows: number,
): readonly string[] {
  if (lines.length >= rows) return lines.slice(0, rows);
  const footer = lines.at(-1) ?? "";
  return [
    ...lines.slice(0, -1),
    ...Array.from({ length: rows - lines.length }, () => ""),
    footer,
  ];
}

function oneTerminalLine(value: string): string {
  return value.replaceAll("\r", "\\r").replaceAll("\n", "\\n");
}

function safeText(value: string): string {
  let result = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character === "\n") result += "\n";
    else if (character === "\t") result += "    ";
    else if (character === "\r") result += "\\r";
    else if (code < 32 || code === 127) {
      result += `\\x${code.toString(16).padStart(2, "0")}`;
    } else if (
      (code >= 0x80 && code <= 0x9f) ||
      code === 0x061c ||
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      result += `\\u{${code.toString(16)}}`;
    } else result += character;
  }
  return result;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function clampOffset(
  offset: number,
  content: number,
  viewport: number,
): number {
  return clamp(offset, 0, Math.max(0, content - Math.max(0, viewport)));
}

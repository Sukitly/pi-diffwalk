import {
  type Component,
  Editor,
  type Focusable,
  Key,
  matchesKey,
  type TUI,
} from "@earendil-works/pi-tui";
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
  ReviewCommentId,
  ReviewCommentThread,
  ReviewSnapshot,
  ReviewSubmissionMode,
  ReviewThreadBatch,
} from "../review/types.ts";
import {
  clamp,
  clampOffset,
  countNoun,
  fillLine,
  fillScreenHeight,
  fitColumns,
  fitLine,
  MEDIUM_HEADER_WIDTH,
  type PrioritizedLineGroup,
  packStatusParts,
  selectHeaderGroups,
  WIDE_HEADER_WIDTH,
} from "../ui/layout.ts";
import {
  oneTerminalLine,
  safeText,
  wrapStyled,
  wrapWithPrefix,
} from "../ui/text.ts";
import { createEditorTheme } from "../ui/theme.ts";
import { buildThreadRegions, ensureThreadVisible } from "./regions.ts";
import {
  editorViewport,
  renderMode,
  renderReplyContext,
  renderScreenHeader,
  renderThreadHeadline,
  renderThreadRows,
} from "./render.ts";
import {
  assertBatchMatchesSnapshot,
  ReviewThreadUiError,
  type ReviewThreadUiInput,
  type ReviewThreadUiResult,
  type ThreadRegion,
  type ThreadScreen,
  type ThreadUiTheme,
} from "./types.ts";

interface ReviewThreadComponentOptions extends ReviewThreadUiInput {
  readonly tui: TUI;
  readonly theme: ThreadUiTheme;
  readonly onClose: (result: ReviewThreadUiResult) => void;
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

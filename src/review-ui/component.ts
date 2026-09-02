import {
  type Component,
  Editor,
  type Focusable,
  Key,
  matchesKey,
  type TUI,
} from "@earendil-works/pi-tui";
import { ReviewSnapshotDriftError } from "../git/snapshot.ts";
import {
  listCommentTargets,
  type ReviewCommentAnchor,
  ReviewCommentInputError,
  type ReviewCommentTarget,
} from "../review/comments.ts";
import {
  deleteInProgressReviewComment,
  discardInProgressReview,
  InProgressReviewError,
  markReviewUnitReviewed,
  setInProgressReviewSubmissionMode,
  upsertInProgressReviewComment,
} from "../review/in-progress.ts";
import type {
  FileChange,
  InProgressReview,
  ReviewComment,
  ReviewRoute,
  ReviewUnit,
  SubmittedGuidedReviewResult,
} from "../review/types.ts";
import {
  clamp,
  clampOffset,
  fillLine,
  fillScreenHeight,
  fitLine,
} from "../ui/layout.ts";
import { oneTerminalLine, safeText, wrapStyled } from "../ui/text.ts";
import { createEditorTheme } from "../ui/theme.ts";
import { renderScreenFooter, renderScreenHeader } from "./chrome.ts";
import {
  buildCommentTargetPreview,
  commentTargetMandatoryHeight,
  renderCommentTargetPreview,
  sliceEditorRows,
} from "./comment-editor.ts";
import {
  renderChangeHeader,
  renderReadOnlyFile,
  renderUnitDiff,
} from "./diff-view.ts";
import { renderHelpLines } from "./help.ts";
import { renderInventoryRows } from "./inventory.ts";
import { renderSubmissionNotice, renderSummaryLines } from "./summary.ts";
import type {
  ChangedLineDisplayOwnership,
  FeedbackType,
  InventoryEntry,
  ReviewScreen,
  ReviewUiKeybindings,
  ReviewUiTheme,
  SubmissionFailure,
  SubmissionStatus,
  TransientFeedback,
  UnitView,
} from "./types.ts";
import {
  anchorFromTarget,
  buildReviewViewModel,
  targetKey,
} from "./view-model.ts";
import {
  ensureInventorySelectionVisible,
  halfPage,
  lastTargetKey,
  MIN_PINNED_HEADER_VIEWPORT,
  pinnedFileTitle,
  resolveDiffViewport,
  sliceViewport,
} from "./viewport.ts";
import {
  renderExplanationLines,
  renderTransientFeedback,
  renderWalkthroughPreview,
  walkthroughFooterText,
} from "./walkthrough.ts";

interface GuidedReviewComponentOptions {
  readonly tui: TUI;
  readonly theme: ReviewUiTheme;
  readonly keybindings: ReviewUiKeybindings;
  readonly review: InProgressReview;
  readonly route: ReviewRoute;
  readonly onReviewChange: (review: InProgressReview) => void;
  readonly onSubmit: (
    review: InProgressReview,
    signal: AbortSignal,
  ) => Promise<SubmittedGuidedReviewResult>;
  readonly onComplete: (result: SubmittedGuidedReviewResult) => void;
  readonly onPause: () => void;
  readonly onDiscard: () => void;
}

export class GuidedReviewComponent implements Component, Focusable {
  private readonly tui: TUI;
  private readonly theme: ReviewUiTheme;
  private readonly keybindings: ReviewUiKeybindings;
  private readonly route: ReviewRoute;
  private review: InProgressReview;
  private readonly onReviewChange: (review: InProgressReview) => void;
  private readonly units: readonly UnitView[];
  private readonly inventory: readonly InventoryEntry[];
  private readonly changesById: ReadonlyMap<FileChange["id"], FileChange>;
  private readonly displayOwnership: ReadonlyMap<
    string,
    ChangedLineDisplayOwnership
  >;
  private readonly skippedCount: number;
  private readonly unsupportedCount: number;
  private readonly onSubmit: (
    review: InProgressReview,
    signal: AbortSignal,
  ) => Promise<SubmittedGuidedReviewResult>;
  private readonly onComplete: (result: SubmittedGuidedReviewResult) => void;
  private readonly onPause: () => void;
  private readonly onDiscard: () => void;
  private readonly editor: Editor;
  private screen: ReviewScreen = "walkthrough";
  private returnScreen: ReviewScreen = "walkthrough";
  private helpReturnScreen: ReviewScreen = "walkthrough";
  private unitIndex = 0;
  private readonly selectedTargetByUnit: number[];
  private diffOffset = 0;
  private explanationOffset = 0;
  private inventoryIndex = 0;
  private inventoryOffset = 0;
  private inventoryDiffOffset = 0;
  private summaryOffset = 0;
  private helpOffset = 0;
  private submissionStatus: SubmissionStatus = "not-checked";
  private submissionFailure?: SubmissionFailure;
  private transientFeedback?: TransientFeedback;
  private commentInputError?: string;
  private submissionAttempt = 0;
  private submissionAbortController?: AbortController;
  /** True after a bare g, waiting for a second g to jump to the top. */
  private pendingGPrefix = false;
  /** Accumulated vim-style count prefix, applied to the next movement key. */
  private pendingCount?: number;
  /**
   * True while the walkthrough diff is scrolled into a region without a
   * commentable line, so render must not re-anchor to the off-screen
   * selection. Cleared whenever the selection or unit changes.
   */
  private diffFreeScroll = false;
  private cachedWidth?: number;
  private cachedRows?: number;
  private cachedLines?: readonly string[];
  private _focused = false;

  constructor(options: GuidedReviewComponentOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.keybindings = options.keybindings;
    this.route = options.route;
    this.review = options.review;
    this.onReviewChange = options.onReviewChange;
    this.onSubmit = options.onSubmit;
    this.onComplete = options.onComplete;
    this.onPause = options.onPause;
    this.onDiscard = options.onDiscard;
    const viewModel = buildReviewViewModel(
      options.review.snapshot,
      options.review.delta,
      options.route,
      listCommentTargets(options.review.snapshot, options.route),
    );
    this.units = viewModel.units;
    this.inventory = viewModel.inventory;
    this.changesById = viewModel.changesById;
    this.displayOwnership = viewModel.displayOwnership;
    this.skippedCount = options.route.skippedSpans.length;
    this.unsupportedCount = viewModel.unsupportedCount;
    this.selectedTargetByUnit = this.units.map(() => 0);

    this.editor = new Editor(this.tui, createEditorTheme(this.theme), {
      paddingX: 0,
    });
    this.editor.onSubmit = (body) => this.saveEditedComment(body);
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
      this.cachedLines !== undefined &&
      this.cachedWidth === renderWidth &&
      this.cachedRows === terminalRows
    ) {
      return [...this.cachedLines];
    }

    const screenLines = fillScreenHeight(
      this.renderScreen(renderWidth, terminalRows),
      terminalRows,
    );
    const bounded = screenLines.map((line) =>
      fillLine(oneTerminalLine(line), renderWidth),
    );
    this.cachedWidth = renderWidth;
    this.cachedRows = terminalRows;
    this.cachedLines = bounded;
    return [...bounded];
  }

  handleInput(data: string): void {
    if (this.submissionStatus === "checking") {
      if (matchesKey(data, Key.escape)) {
        this.abortSubmissionCheck();
        this.returnScreen = "summary";
        this.openScreen("cancel-confirmation");
      }
      return;
    }

    if (this.screen !== "comment-editor" && matchesKey(data, "?")) {
      this.toggleHelp();
      return;
    }

    if (this.pendingGPrefix) {
      this.pendingGPrefix = false;
      if (matchesKey(data, "g")) {
        this.pendingCount = undefined;
        this.goToTop();
        return;
      }
    } else if (this.isMovementScreen() && !this.matchesSelectAction(data)) {
      if (matchesKey(data, "g")) {
        this.pendingGPrefix = true;
        return;
      }
      const digit = digitKey(data);
      if (
        digit !== undefined &&
        (this.pendingCount !== undefined || digit > 0)
      ) {
        this.pendingCount = Math.min(
          MAX_COUNT_PREFIX,
          (this.pendingCount ?? 0) * 10 + digit,
        );
        return;
      }
    }

    const count = this.pendingCount ?? 1;
    this.pendingCount = undefined;

    switch (this.screen) {
      case "walkthrough":
        this.handleWalkthroughInput(data, count);
        break;
      case "comment-editor":
        this.handleCommentEditorInput(data);
        break;
      case "explanation":
        this.handleExplanationInput(data, count);
        break;
      case "inventory":
        this.handleInventoryInput(data, count);
        break;
      case "inventory-diff":
        this.handleInventoryDiffInput(data, count);
        break;
      case "summary":
        this.handleSummaryInput(data, count);
        break;
      case "help":
        this.handleHelpInput(data, count);
        break;
      case "cancel-confirmation":
        this.handleCancelConfirmationInput(data);
        break;
    }
  }

  invalidate(): void {
    this.clearRenderCache();
    this.editor.invalidate();
  }

  dispose(): void {
    this.submissionAttempt += 1;
    this.submissionAbortController?.abort();
    this.submissionAbortController = undefined;
  }

  private renderScreen(width: number, rows: number): readonly string[] {
    switch (this.screen) {
      case "walkthrough":
        return this.renderWalkthrough(width, rows);
      case "comment-editor":
        return this.renderCommentEditor(width, rows);
      case "explanation":
        return this.renderExplanation(width, rows);
      case "inventory":
        return this.renderInventory(width, rows);
      case "inventory-diff":
        return this.renderInventoryDiff(width, rows);
      case "summary":
        return this.renderSummary(width, rows);
      case "help":
        return this.renderHelp(width, rows);
      case "cancel-confirmation":
        return this.renderCancelConfirmation(width, rows);
    }
  }

  private renderWalkthrough(width: number, rows: number): readonly string[] {
    const baseHeader = this.renderHeader(width, rows);
    const footer = this.renderFooter(width, walkthroughFooterText(width));
    const unitView = this.currentUnit();
    const header = baseHeader;
    const bodyHeight = Math.max(0, rows - header.length - footer.length);
    if (bodyHeight === 0) return [...header, ...footer];

    if (unitView === undefined) {
      const empty = wrapStyled(
        this.theme.fg(
          "muted",
          "No review units were planned. Open inventory or submit the empty walkthrough.",
        ),
        width,
      ).slice(0, bodyHeight);
      return [...header, ...empty, ...footer];
    }

    const preview = renderWalkthroughPreview(
      unitView.unit,
      bodyHeight,
      this.theme,
      width,
    );
    const feedback = renderTransientFeedback(
      this.transientFeedback,
      this.theme,
      width,
    );
    const diffHeight = Math.max(
      0,
      bodyHeight - preview.length - feedback.length,
    );
    const renderedDiff = renderUnitDiff(
      unitView,
      this.currentTarget(),
      this.review.comments,
      this.theme,
      width,
    );
    const viewport = resolveDiffViewport(
      renderedDiff,
      this.currentTarget(),
      this.diffOffset,
      diffHeight,
      !this.diffFreeScroll,
    );
    this.diffOffset = viewport.offset;
    const pinnedBlock =
      viewport.pinnedBlockIndex === undefined
        ? undefined
        : unitView.displayBlocks[viewport.pinnedBlockIndex];
    const pinnedHeader =
      pinnedBlock === undefined
        ? []
        : [fitLine(renderChangeHeader(pinnedBlock.change, this.theme), width)];
    const diffRows = sliceViewport(
      renderedDiff,
      this.diffOffset,
      viewport.contentHeight,
    ).map(({ text }) => text);

    return [
      ...header,
      ...preview,
      ...feedback,
      ...pinnedHeader,
      ...diffRows,
      ...footer,
    ];
  }

  private renderCommentEditor(width: number, rows: number): readonly string[] {
    const target = this.currentTarget();
    const header = this.renderHeader(width, rows, 6);
    const footer = this.renderFooter(
      width,
      "Enter save • Shift+Enter newline • Esc discard edit",
    );
    const bodyHeight = Math.max(0, rows - header.length - footer.length);
    const previewModel =
      target === undefined
        ? undefined
        : buildCommentTargetPreview(
            target,
            this.currentUnit()?.unit,
            this.changesById,
            this.displayOwnership,
            this.review.comments,
            this.theme,
            width,
          );
    const editorLines = this.editor.render(width);
    const minimumEditorHeight = Math.min(
      editorLines.length,
      Math.max(1, bodyHeight - 2),
      3,
    );
    const mandatoryPreviewBudget = Math.max(
      0,
      bodyHeight - minimumEditorHeight,
    );
    const mandatoryPreviewHeight =
      previewModel === undefined
        ? 0
        : commentTargetMandatoryHeight(previewModel, mandatoryPreviewBudget);
    const remainingAfterPreview = Math.max(
      0,
      bodyHeight - mandatoryPreviewHeight,
    );
    const errorLines =
      this.commentInputError === undefined
        ? []
        : wrapStyled(
            this.theme.fg("warning", safeText(this.commentInputError)),
            width,
          );
    const errorHeight = Math.min(
      errorLines.length,
      Math.max(0, remainingAfterPreview - minimumEditorHeight),
    );
    const editorHeight = Math.min(
      editorLines.length,
      remainingAfterPreview - errorHeight,
    );
    const contextBudget = Math.max(
      0,
      remainingAfterPreview - errorHeight - editorHeight,
    );
    const preview =
      previewModel === undefined
        ? []
        : renderCommentTargetPreview(
            previewModel,
            mandatoryPreviewBudget,
            contextBudget,
            this.theme,
            width,
          );
    return [
      ...header,
      ...preview,
      ...errorLines.slice(0, errorHeight),
      ...sliceEditorRows(editorLines, editorHeight, this.theme, width),
      ...footer,
    ];
  }

  private renderExplanation(width: number, rows: number): readonly string[] {
    const header = this.renderHeader(width, rows);
    const footer = this.renderFooter(
      width,
      "j/k or ↑/↓ scroll • PgUp/PgDn page • e/Esc return • ? help",
    );
    const viewportHeight = Math.max(0, rows - header.length - footer.length);
    const content = this.explanationContent(width);
    this.explanationOffset = clampOffset(
      this.explanationOffset,
      content.length,
      viewportHeight,
    );
    return [
      ...header,
      ...content.slice(
        this.explanationOffset,
        this.explanationOffset + viewportHeight,
      ),
      ...footer,
    ];
  }

  private renderInventory(width: number, rows: number): readonly string[] {
    const header = this.renderHeader(width, rows);
    const footer = this.renderFooter(
      width,
      "j/k or ↑/↓ select • Enter inspect frozen hunk • i/Esc return • ? help",
    );
    const feedback = renderTransientFeedback(
      this.transientFeedback,
      this.theme,
      width,
    );
    const viewportHeight = Math.max(
      0,
      rows - header.length - feedback.length - footer.length,
    );
    const content = renderInventoryRows(
      this.inventory,
      this.inventoryIndex,
      this.theme,
      width,
    );
    this.inventoryOffset = ensureInventorySelectionVisible(
      content,
      this.inventoryIndex,
      this.inventoryOffset,
      viewportHeight,
    );
    return [
      ...header,
      ...feedback,
      ...content
        .slice(this.inventoryOffset, this.inventoryOffset + viewportHeight)
        .map(({ text }) => text),
      ...footer,
    ];
  }

  private renderInventoryDiff(width: number, rows: number): readonly string[] {
    const header = this.renderHeader(width, rows);
    const footer = this.renderFooter(
      width,
      "j/k or ↑/↓ scroll • PgUp/PgDn page • Esc return to inventory • ? help",
    );
    const viewportHeight = Math.max(0, rows - header.length - footer.length);
    const entry = this.inventory[this.inventoryIndex];
    const content = this.inventoryDiffContent(width);
    const fullOffset = clampOffset(
      this.inventoryDiffOffset,
      content.length,
      viewportHeight,
    );
    const pinnedTitle =
      entry?.type === "file" && viewportHeight >= MIN_PINNED_HEADER_VIEWPORT
        ? pinnedFileTitle(entry, fullOffset, this.theme, width)
        : [];
    const contentHeight = viewportHeight - pinnedTitle.length;
    this.inventoryDiffOffset =
      pinnedTitle.length === 0
        ? fullOffset
        : clampOffset(this.inventoryDiffOffset, content.length, contentHeight);
    return [
      ...header,
      ...pinnedTitle,
      ...content.slice(
        this.inventoryDiffOffset,
        this.inventoryDiffOffset + contentHeight,
      ),
      ...footer,
    ];
  }

  private renderSummary(width: number, rows: number): readonly string[] {
    const header = this.renderHeader(width, rows);
    const footer = this.renderFooter(
      width,
      this.submissionStatus === "checking"
        ? "Checking repository state... • Esc cancel verification"
        : this.pendingUnits().length > 0
          ? "Enter continue next pending section • Esc return • ? help"
          : "←/→ or Tab mode • j/k scroll • Enter submit • Esc return • ? help",
    );
    const availableHeight = Math.max(0, rows - header.length - footer.length);
    const submissionNotice = renderSubmissionNotice(
      this.submissionStatus,
      this.submissionFailure,
      this.theme,
      width,
    ).slice(0, availableHeight);
    const viewportHeight = Math.max(
      0,
      availableHeight - submissionNotice.length,
    );
    const content = this.summaryContent(width);
    this.summaryOffset = clampOffset(
      this.summaryOffset,
      content.length,
      viewportHeight,
    );
    return [
      ...header,
      ...submissionNotice,
      ...content.slice(this.summaryOffset, this.summaryOffset + viewportHeight),
      ...footer,
    ];
  }

  private renderHelp(width: number, rows: number): readonly string[] {
    const header = this.renderHeader(width, rows);
    const footer = this.renderFooter(
      width,
      "j/k scroll • PgUp/PgDn page • ?/Esc return",
    );
    const viewportHeight = Math.max(0, rows - header.length - footer.length);
    const content = renderHelpLines(this.theme, width);
    this.helpOffset = clampOffset(
      this.helpOffset,
      content.length,
      viewportHeight,
    );
    return [
      ...header,
      ...content.slice(this.helpOffset, this.helpOffset + viewportHeight),
      ...footer,
    ];
  }

  private renderCancelConfirmation(
    width: number,
    rows: number,
  ): readonly string[] {
    const header = this.renderHeader(width, rows);
    const footer = this.renderFooter(
      width,
      "Enter pause and resume later • d discard review • Esc continue • ? help",
    );
    const comments = this.review.comments.length;
    const content = [
      this.theme.fg("warning", this.theme.bold("Leave DiffWalk?")),
      ...wrapStyled(
        this.theme.fg(
          "text",
          `Pause to keep ${comments} draft comment${comments === 1 ? "" : "s"} and review progress for the next /diffwalk command. Discard permanently removes drafts.`,
        ),
        width,
      ),
    ];
    const bodyHeight = Math.max(0, rows - header.length - footer.length);
    return [...header, ...content.slice(0, bodyHeight), ...footer];
  }

  private renderHeader(
    width: number,
    rows: number,
    reservedRows = 2,
  ): readonly string[] {
    return renderScreenHeader(
      {
        screen: this.screen,
        title: this.screenTitle(),
        unitCount: this.units.length,
        unitIndex: this.unitIndex,
        reviewedCount: this.reviewedUnitCount(),
        commentCount: this.review.comments.length,
        skippedCount: this.skippedCount,
        unsupportedCount: this.unsupportedCount,
        submissionStatus: this.submissionStatus,
      },
      this.theme,
      width,
      rows,
      reservedRows,
    );
  }

  private renderFooter(width: number, text: string): readonly string[] {
    return renderScreenFooter(text, this.theme, width);
  }

  private screenTitle(): string {
    switch (this.screen) {
      case "walkthrough":
      case "explanation":
        return this.currentUnit()?.unit.title ?? "Review inventory";
      case "comment-editor":
        return "Review comment";
      case "inventory":
      case "inventory-diff":
        return "Review inventory";
      case "summary":
        return "Submission summary";
      case "help":
        return "Keyboard help";
      case "cancel-confirmation":
        return "Pause or discard review";
    }
  }

  private handleWalkthroughInput(data: string, count: number): void {
    if (this.isUp(data)) {
      this.moveTarget(-count);
      return;
    }
    if (this.isDown(data)) {
      this.moveTarget(count);
      return;
    }
    if (matchesKey(data, "shift+g")) {
      this.moveTargetToEdge("last");
      return;
    }
    if (this.isPageUp(data)) {
      this.pageWalkthrough(-1, "full", count);
      return;
    }
    if (this.isPageDown(data)) {
      this.pageWalkthrough(1, "full", count);
      return;
    }
    if (matchesKey(data, "ctrl+u")) {
      this.pageWalkthrough(-1, "half", count);
      return;
    }
    if (matchesKey(data, "ctrl+d")) {
      this.pageWalkthrough(1, "half", count);
      return;
    }
    if (
      matchesKey(data, "p") ||
      matchesKey(data, "h") ||
      matchesKey(data, Key.left)
    ) {
      this.moveUnit(-count);
      return;
    }
    if (matchesKey(data, "l") || matchesKey(data, Key.right)) {
      this.moveUnit(count);
      return;
    }
    if (matchesKey(data, "n")) {
      this.completeCurrentUnitAndContinue();
      return;
    }
    if (matchesKey(data, "c")) {
      this.openCommentEditor();
      return;
    }
    if (matchesKey(data, "d")) {
      this.deleteSelectedComment();
      return;
    }
    if (matchesKey(data, "e")) {
      this.transientFeedback = undefined;
      this.openScreen("explanation");
      return;
    }
    if (matchesKey(data, "i")) {
      this.transientFeedback = undefined;
      this.openScreen("inventory");
      return;
    }
    if (matchesKey(data, "s")) {
      this.transientFeedback = undefined;
      this.openScreen("summary");
      return;
    }
    if (matchesKey(data, Key.escape)) this.openCancelConfirmation();
  }

  private handleCommentEditorInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.editor.setText("");
      this.commentInputError = undefined;
      this.openScreen("walkthrough");
      return;
    }
    this.commentInputError = undefined;
    this.editor.handleInput(data);
    this.refresh();
  }

  private handleExplanationInput(data: string, count: number): void {
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, "e") ||
      matchesKey(data, "h") ||
      matchesKey(data, Key.left)
    ) {
      this.openScreen("walkthrough");
      return;
    }
    if (this.isUp(data)) this.scrollExplanation(-count);
    else if (this.isDown(data)) this.scrollExplanation(count);
    else if (matchesKey(data, "shift+g")) this.scrollExplanationToEnd();
    else if (this.isPageUp(data))
      this.scrollExplanation(-count * this.secondaryViewportHeight());
    else if (this.isPageDown(data))
      this.scrollExplanation(count * this.secondaryViewportHeight());
    else if (matchesKey(data, "ctrl+u"))
      this.scrollExplanation(-count * halfPage(this.secondaryViewportHeight()));
    else if (matchesKey(data, "ctrl+d"))
      this.scrollExplanation(count * halfPage(this.secondaryViewportHeight()));
  }

  private handleInventoryInput(data: string, count: number): void {
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, "i") ||
      matchesKey(data, "h") ||
      matchesKey(data, Key.left)
    ) {
      this.transientFeedback = undefined;
      this.openScreen("walkthrough");
      return;
    }
    if (this.isUp(data)) {
      this.moveInventorySelection(-count);
      return;
    }
    if (this.isDown(data)) {
      this.moveInventorySelection(count);
      return;
    }
    if (matchesKey(data, "shift+g")) {
      this.moveInventoryToEdge("last");
      return;
    }
    if (this.isPageUp(data)) {
      this.pageInventory(-1, "full", count);
      return;
    }
    if (this.isPageDown(data)) {
      this.pageInventory(1, "full", count);
      return;
    }
    if (matchesKey(data, "ctrl+u")) {
      this.pageInventory(-1, "half", count);
      return;
    }
    if (matchesKey(data, "ctrl+d")) {
      this.pageInventory(1, "half", count);
      return;
    }
    if (
      matchesKey(data, Key.enter) ||
      matchesKey(data, "l") ||
      matchesKey(data, Key.right)
    ) {
      const entry = this.inventory[this.inventoryIndex];
      if (entry?.type === "file") {
        this.inventoryDiffOffset = 0;
        this.openScreen("inventory-diff");
      } else {
        this.setTransientFeedback(
          "warning",
          "The selected inventory entry has no text diff.",
        );
      }
    }
  }

  private handleInventoryDiffInput(data: string, count: number): void {
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, "h") ||
      matchesKey(data, Key.left)
    ) {
      this.openScreen("inventory");
      return;
    }
    if (this.isUp(data)) this.scrollInventoryDiff(-count);
    else if (this.isDown(data)) this.scrollInventoryDiff(count);
    else if (matchesKey(data, "shift+g")) this.scrollInventoryDiffToEnd();
    else if (this.isPageUp(data))
      this.scrollInventoryDiff(-count * this.secondaryViewportHeight());
    else if (this.isPageDown(data))
      this.scrollInventoryDiff(count * this.secondaryViewportHeight());
    else if (matchesKey(data, "ctrl+u"))
      this.scrollInventoryDiff(
        -count * halfPage(this.secondaryViewportHeight()),
      );
    else if (matchesKey(data, "ctrl+d"))
      this.scrollInventoryDiff(
        count * halfPage(this.secondaryViewportHeight()),
      );
  }

  private handleSummaryInput(data: string, count: number): void {
    if (matchesKey(data, Key.escape)) {
      this.transientFeedback = undefined;
      this.openScreen("walkthrough");
      return;
    }
    if (
      matchesKey(data, Key.left) ||
      matchesKey(data, Key.right) ||
      matchesKey(data, "h") ||
      matchesKey(data, "l") ||
      matchesKey(data, Key.tab)
    ) {
      // The mode selector is rendered only once every unit is reviewed;
      // toggling before that would change state the reviewer cannot see.
      if (this.pendingUnits().length > 0) return;
      this.updateReview(
        setInProgressReviewSubmissionMode(
          this.review,
          this.review.submissionMode === "discuss-first"
            ? "apply-change-requests"
            : "discuss-first",
          this.mutation(),
        ),
      );
      this.transientFeedback = undefined;
      this.refresh();
      return;
    }
    if (this.isUp(data)) this.scrollSummary(-count);
    else if (this.isDown(data)) this.scrollSummary(count);
    else if (matchesKey(data, "shift+g")) this.scrollSummaryToEnd();
    else if (this.isPageUp(data))
      this.scrollSummary(-count * this.summaryViewportHeight());
    else if (this.isPageDown(data))
      this.scrollSummary(count * this.summaryViewportHeight());
    else if (matchesKey(data, "ctrl+u"))
      this.scrollSummary(-count * halfPage(this.summaryViewportHeight()));
    else if (matchesKey(data, "ctrl+d"))
      this.scrollSummary(count * halfPage(this.summaryViewportHeight()));
    else if (matchesKey(data, Key.enter)) this.startSubmission();
  }

  private handleHelpInput(data: string, count: number): void {
    if (matchesKey(data, Key.escape)) {
      this.closeHelp();
      return;
    }
    if (this.isUp(data)) this.scrollHelp(-count);
    else if (this.isDown(data)) this.scrollHelp(count);
    else if (matchesKey(data, "shift+g")) this.scrollHelpToEnd();
    else if (this.isPageUp(data))
      this.scrollHelp(-count * this.secondaryViewportHeight());
    else if (this.isPageDown(data))
      this.scrollHelp(count * this.secondaryViewportHeight());
    else if (matchesKey(data, "ctrl+u"))
      this.scrollHelp(-count * halfPage(this.secondaryViewportHeight()));
    else if (matchesKey(data, "ctrl+d"))
      this.scrollHelp(count * halfPage(this.secondaryViewportHeight()));
  }

  private handleCancelConfirmationInput(data: string): void {
    if (matchesKey(data, Key.enter)) {
      this.onPause();
      return;
    }
    if (matchesKey(data, "d")) {
      this.updateReview(discardInProgressReview(this.review, this.mutation()));
      this.onDiscard();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.openScreen(this.returnScreen);
    }
  }

  /** User-configured select bindings take precedence over vim prefix keys. */
  private matchesSelectAction(data: string): boolean {
    return (
      this.keybindings.matches(data, "tui.select.up") ||
      this.keybindings.matches(data, "tui.select.down") ||
      this.keybindings.matches(data, "tui.select.pageUp") ||
      this.keybindings.matches(data, "tui.select.pageDown")
    );
  }

  /** Screens where bare g starts a gg jump instead of being text input. */
  private isMovementScreen(): boolean {
    return (
      this.screen !== "comment-editor" && this.screen !== "cancel-confirmation"
    );
  }

  /** Jump to the top of the current screen after a gg sequence. */
  private goToTop(): void {
    switch (this.screen) {
      case "walkthrough":
        this.moveTargetToEdge("first");
        return;
      case "explanation":
        this.explanationOffset = 0;
        this.refresh();
        return;
      case "inventory":
        this.moveInventoryToEdge("first");
        return;
      case "inventory-diff":
        this.inventoryDiffOffset = 0;
        this.refresh();
        return;
      case "summary":
        this.summaryOffset = 0;
        this.refresh();
        return;
      case "help":
        this.helpOffset = 0;
        this.refresh();
        return;
      default:
        return;
    }
  }

  private isUp(data: string): boolean {
    return (
      matchesKey(data, "k") || this.keybindings.matches(data, "tui.select.up")
    );
  }

  private isDown(data: string): boolean {
    return (
      matchesKey(data, "j") || this.keybindings.matches(data, "tui.select.down")
    );
  }

  private isPageUp(data: string): boolean {
    return (
      matchesKey(data, Key.pageUp) ||
      matchesKey(data, "ctrl+b") ||
      this.keybindings.matches(data, "tui.select.pageUp")
    );
  }

  private isPageDown(data: string): boolean {
    return (
      matchesKey(data, Key.pageDown) ||
      matchesKey(data, "ctrl+f") ||
      this.keybindings.matches(data, "tui.select.pageDown")
    );
  }

  private moveTarget(delta: number): void {
    const unit = this.currentUnit();
    if (unit === undefined || unit.targets.length === 0) return;
    const next = clamp(
      this.currentTargetIndex() + delta,
      0,
      unit.targets.length - 1,
    );
    this.selectedTargetByUnit[this.unitIndex] = next;
    this.diffFreeScroll = false;
    this.transientFeedback = undefined;
    this.refresh();
  }

  private moveTargetToEdge(edge: "first" | "last"): void {
    const unit = this.currentUnit();
    if (unit === undefined || unit.targets.length === 0) return;
    this.selectedTargetByUnit[this.unitIndex] =
      edge === "first" ? 0 : unit.targets.length - 1;
    this.diffFreeScroll = false;
    this.transientFeedback = undefined;
    this.refresh();
  }

  private moveInventoryToEdge(edge: "first" | "last"): void {
    if (this.inventory.length === 0) return;
    this.inventoryIndex = edge === "first" ? 0 : this.inventory.length - 1;
    this.transientFeedback = undefined;
    this.refresh();
  }

  private pageWalkthrough(
    direction: -1 | 1,
    step: "full" | "half" = "full",
    count = 1,
  ): void {
    const unit = this.currentUnit();
    if (unit === undefined || unit.targets.length === 0) return;
    const width = Math.max(1, this.tui.terminal.columns);
    const viewportHeight = Math.max(
      1,
      this.walkthroughDiffViewportHeight(width, this.tui.terminal.rows),
    );
    const rows = renderUnitDiff(
      unit,
      this.currentTarget(),
      this.review.comments,
      this.theme,
      width,
    );
    const viewport = resolveDiffViewport(
      rows,
      this.currentTarget(),
      this.diffOffset,
      viewportHeight,
      !this.diffFreeScroll,
    );
    const stride =
      count *
      (step === "half"
        ? halfPage(viewport.contentHeight)
        : viewport.contentHeight);
    const nextOffset = clampOffset(
      viewport.offset + direction * stride,
      rows.length,
      viewport.contentHeight,
    );
    if (nextOffset === viewport.offset) {
      this.transientFeedback = undefined;
      this.refresh();
      return;
    }
    const visibleRows = rows.slice(
      nextOffset,
      nextOffset + viewport.contentHeight,
    );
    const selectedKey =
      direction === 1
        ? visibleRows.find((row) => row.targetKey !== undefined)?.targetKey
        : lastTargetKey(visibleRows);
    if (selectedKey !== undefined) {
      const targetIndex = unit.targets.findIndex(
        (target) => targetKey(target) === selectedKey,
      );
      if (targetIndex >= 0)
        this.selectedTargetByUnit[this.unitIndex] = targetIndex;
      this.diffFreeScroll = false;
    } else {
      // The new viewport shows only context, span headers, or a partial
      // wrapped line. Keep scrolling freely instead of letting the next
      // render re-anchor to the off-screen selection.
      this.diffFreeScroll = true;
    }
    this.diffOffset = nextOffset;
    this.transientFeedback = undefined;
    this.refresh();
  }

  private moveUnit(delta: number): void {
    if (this.units.length === 0) return;
    this.unitIndex = clamp(this.unitIndex + delta, 0, this.units.length - 1);
    this.diffOffset = 0;
    this.diffFreeScroll = false;
    this.explanationOffset = 0;
    this.transientFeedback = undefined;
    this.refresh();
  }

  private completeCurrentUnitAndContinue(): void {
    const unit = this.currentUnit();
    if (unit === undefined) {
      this.openScreen("summary");
      return;
    }
    this.updateReview(
      markReviewUnitReviewed(this.review, unit.unit.id, this.mutation()),
    );
    if (this.unitIndex === this.units.length - 1) {
      this.openScreen("summary");
      return;
    }
    this.moveUnit(1);
  }

  private openCommentEditor(): void {
    const target = this.currentTarget();
    if (target === undefined) {
      this.setTransientFeedback(
        "warning",
        "The current unit has no commentable source line.",
      );
      return;
    }
    const existing = this.findComment(target);
    this.editor.setText(existing?.body ?? "");
    this.transientFeedback = undefined;
    this.commentInputError = undefined;
    this.openScreen("comment-editor");
  }

  private saveEditedComment(body: string): void {
    const target = this.currentTarget();
    if (target === undefined) {
      this.commentInputError =
        "The selected diff anchor is no longer available.";
      this.refresh();
      return;
    }
    try {
      this.updateReview(
        upsertInProgressReviewComment(
          this.review,
          { ...anchorFromTarget(target), body },
          this.mutation(),
        ),
      );
      this.commentInputError = undefined;
      this.openScreen("walkthrough");
    } catch (error: unknown) {
      if (error instanceof ReviewCommentInputError) {
        this.commentInputError = error.message;
        this.syncEditorFocus();
        this.refresh();
        return;
      }
      throw error;
    }
  }

  private deleteSelectedComment(): void {
    const target = this.currentTarget();
    if (target === undefined) return;
    const next = deleteInProgressReviewComment(
      this.review,
      target,
      this.mutation(),
    );
    const deleted = next !== this.review;
    this.updateReview(next);
    this.setTransientFeedback(
      deleted ? "info" : "warning",
      deleted
        ? "Deleted the comment on the selected line."
        : "The selected line has no comment.",
    );
  }

  private scrollExplanation(delta: number): void {
    this.explanationOffset = Math.max(0, this.explanationOffset + delta);
    this.refresh();
  }

  private scrollExplanationToEnd(): void {
    const width = Math.max(1, this.tui.terminal.columns);
    this.explanationOffset = Math.max(
      0,
      this.explanationContent(width).length - this.bodyHeight(width),
    );
    this.refresh();
  }

  /** Explanation body lines, shared by render and scroll-to-end. */
  private explanationContent(width: number): readonly string[] {
    const unit = this.currentUnit()?.unit;
    return unit === undefined
      ? [this.theme.fg("muted", "No unit details are available.")]
      : renderExplanationLines(unit, this.theme, width);
  }

  private moveInventorySelection(delta: number): void {
    if (this.inventory.length === 0) return;
    this.inventoryIndex = clamp(
      this.inventoryIndex + delta,
      0,
      this.inventory.length - 1,
    );
    this.transientFeedback = undefined;
    this.refresh();
  }

  private scrollInventoryDiff(delta: number): void {
    this.inventoryDiffOffset = Math.max(0, this.inventoryDiffOffset + delta);
    this.refresh();
  }

  private scrollInventoryDiffToEnd(): void {
    const width = Math.max(1, this.tui.terminal.columns);
    const viewportHeight = this.bodyHeight(width);
    const content = this.inventoryDiffContent(width);
    const fullOffset = Math.max(0, content.length - viewportHeight);
    const entry = this.inventory[this.inventoryIndex];
    const pinned =
      entry?.type === "file" && viewportHeight >= MIN_PINNED_HEADER_VIEWPORT
        ? pinnedFileTitle(entry, fullOffset, this.theme, width).length
        : 0;
    this.inventoryDiffOffset = Math.max(
      0,
      content.length - Math.max(0, viewportHeight - pinned),
    );
    this.refresh();
  }

  /** Read-only file lines, shared by render and scroll-to-end. */
  private inventoryDiffContent(width: number): readonly string[] {
    const entry = this.inventory[this.inventoryIndex];
    return entry?.type === "file"
      ? renderReadOnlyFile(entry, this.theme, width)
      : [this.theme.fg("muted", "This inventory entry has no text diff.")];
  }

  private scrollSummary(delta: number): void {
    this.summaryOffset = Math.max(0, this.summaryOffset + delta);
    this.refresh();
  }

  private scrollSummaryToEnd(): void {
    const width = Math.max(1, this.tui.terminal.columns);
    const availableHeight = this.bodyHeight(width);
    const noticeHeight = renderSubmissionNotice(
      this.submissionStatus,
      this.submissionFailure,
      this.theme,
      width,
    ).slice(0, availableHeight).length;
    this.summaryOffset = Math.max(
      0,
      this.summaryContent(width).length -
        Math.max(0, availableHeight - noticeHeight),
    );
    this.refresh();
  }

  private scrollHelp(delta: number): void {
    this.helpOffset = Math.max(0, this.helpOffset + delta);
    this.refresh();
  }

  private scrollHelpToEnd(): void {
    const width = Math.max(1, this.tui.terminal.columns);
    this.helpOffset = Math.max(
      0,
      renderHelpLines(this.theme, width).length - this.bodyHeight(width),
    );
    this.refresh();
  }

  /** Summary body lines, shared by render and scroll-to-end. */
  private summaryContent(width: number): readonly string[] {
    return renderSummaryLines(
      this.review.comments,
      this.route,
      this.inventory,
      this.review.submissionMode,
      this.transientFeedback,
      this.pendingUnits(),
      this.theme,
      width,
    );
  }

  /** Rows between the header and the one-row footer, as render lays out. */
  private bodyHeight(width: number): number {
    const rows = Math.max(1, this.tui.terminal.rows);
    return Math.max(0, rows - this.renderHeader(width, rows).length - 1);
  }

  private startSubmission(): void {
    if (this.submissionStatus === "checking") return;
    const firstPendingIndex = this.units.findIndex(
      (_unit, index) => !this.isUnitReviewed(index),
    );
    if (firstPendingIndex >= 0) {
      this.unitIndex = firstPendingIndex;
      this.diffOffset = 0;
      this.diffFreeScroll = false;
      this.explanationOffset = 0;
      this.transientFeedback = {
        type: "info",
        message: "Continue reviewing this section before submission.",
      };
      this.openScreen("walkthrough");
      return;
    }

    this.submissionAttempt += 1;
    const attempt = this.submissionAttempt;
    const controller = new AbortController();
    this.submissionAbortController = controller;
    this.submissionStatus = "checking";
    this.submissionFailure = undefined;
    this.transientFeedback = undefined;
    this.refresh();

    let submission: Promise<SubmittedGuidedReviewResult>;
    try {
      submission = this.onSubmit(this.review, controller.signal);
    } catch (error: unknown) {
      this.failSubmission(attempt, error);
      return;
    }
    void submission.then(
      (result) => {
        if (attempt !== this.submissionAttempt) return;
        this.submissionAbortController = undefined;
        this.onComplete(result);
      },
      (error: unknown) => this.failSubmission(attempt, error),
    );
  }

  private failSubmission(attempt: number, error: unknown): void {
    if (attempt !== this.submissionAttempt) return;
    this.submissionAbortController = undefined;
    const type =
      error instanceof ReviewSnapshotDriftError ||
      (error instanceof InProgressReviewError &&
        error.code === "repository-drifted")
        ? "repository-drifted"
        : "verification-failed";
    this.submissionStatus = type;
    this.submissionFailure = { type, error };
    this.summaryOffset = 0;
    this.screen = "summary";
    this.syncEditorFocus();
    this.refresh();
  }

  private abortSubmissionCheck(): void {
    if (this.submissionStatus !== "checking") return;
    this.submissionAttempt += 1;
    this.submissionAbortController?.abort();
    this.submissionAbortController = undefined;
    this.submissionStatus = "not-checked";
    this.submissionFailure = undefined;
    this.transientFeedback = {
      type: "info",
      message: "Snapshot verification was cancelled.",
    };
  }

  private setTransientFeedback(type: FeedbackType, message: string): void {
    this.transientFeedback = { type, message };
    this.refresh();
  }

  private pendingUnits(): readonly ReviewUnit[] {
    return this.units
      .filter((_unit, index) => !this.isUnitReviewed(index))
      .map(({ unit }) => unit);
  }

  private secondaryViewportHeight(): number {
    const width = Math.max(1, this.tui.terminal.columns);
    return Math.max(1, this.bodyHeight(width));
  }

  /**
   * Move the inventory selection by whole rendered viewports.
   *
   * Entries wrap by terminal width, so a page is measured in rendered rows
   * rather than a fixed number of entries: the selection jumps to the entry
   * whose rows sit one (or half a) viewport away from the current entry's
   * first row. An entry taller than the stride still advances by one entry.
   */
  private pageInventory(
    direction: -1 | 1,
    step: "full" | "half",
    count: number,
  ): void {
    if (this.inventory.length === 0) return;
    const width = Math.max(1, this.tui.terminal.columns);
    const feedbackHeight = renderTransientFeedback(
      this.transientFeedback,
      this.theme,
      width,
    ).length;
    const viewportHeight = Math.max(1, this.bodyHeight(width) - feedbackHeight);
    const stride =
      count * (step === "half" ? halfPage(viewportHeight) : viewportHeight);
    const rows = renderInventoryRows(
      this.inventory,
      this.inventoryIndex,
      this.theme,
      width,
    );
    const anchor = rows.findIndex(
      (row) => row.inventoryIndex === this.inventoryIndex,
    );
    const targetRow = clamp(
      (anchor < 0 ? 0 : anchor) + direction * stride,
      0,
      rows.length - 1,
    );
    let nextIndex = rows[targetRow]?.inventoryIndex ?? this.inventoryIndex;
    if (nextIndex === this.inventoryIndex) {
      nextIndex = clamp(
        this.inventoryIndex + direction,
        0,
        this.inventory.length - 1,
      );
    }
    this.inventoryIndex = nextIndex;
    this.transientFeedback = undefined;
    this.refresh();
  }

  private summaryViewportHeight(): number {
    const width = Math.max(1, this.tui.terminal.columns);
    const availableHeight = this.bodyHeight(width);
    const noticeHeight = renderSubmissionNotice(
      this.submissionStatus,
      this.submissionFailure,
      this.theme,
      width,
    ).slice(0, availableHeight).length;
    return Math.max(1, availableHeight - noticeHeight);
  }

  private walkthroughDiffViewportHeight(width: number, rows: number): number {
    const availableBodyHeight = Math.max(
      0,
      rows - this.renderHeader(width, rows).length - 1,
    );
    const unit = this.currentUnit();
    const previewHeight =
      unit === undefined
        ? 0
        : renderWalkthroughPreview(
            unit.unit,
            availableBodyHeight,
            this.theme,
            width,
          ).length;
    const feedbackHeight = renderTransientFeedback(
      this.transientFeedback,
      this.theme,
      width,
    ).length;
    return Math.max(0, availableBodyHeight - previewHeight - feedbackHeight);
  }

  private toggleHelp(): void {
    if (this.screen === "help") {
      this.closeHelp();
      return;
    }
    this.helpReturnScreen = this.screen;
    this.helpOffset = 0;
    this.openScreen("help");
  }

  private closeHelp(): void {
    this.openScreen(this.helpReturnScreen);
  }

  private openCancelConfirmation(): void {
    this.returnScreen = this.screen;
    this.transientFeedback = undefined;
    this.openScreen("cancel-confirmation");
  }

  private openScreen(screen: ReviewScreen): void {
    this.screen = screen;
    this.pendingGPrefix = false;
    this.pendingCount = undefined;
    this.syncEditorFocus();
    this.refresh();
  }

  private currentUnit(): UnitView | undefined {
    return this.units[this.unitIndex];
  }

  private currentTargetIndex(): number {
    return this.selectedTargetByUnit[this.unitIndex] ?? 0;
  }

  private currentTarget(): ReviewCommentTarget | undefined {
    return this.currentUnit()?.targets[this.currentTargetIndex()];
  }

  private syncEditorFocus(): void {
    this.editor.focused = this._focused && this.screen === "comment-editor";
  }

  private updateReview(review: InProgressReview): void {
    if (review === this.review) return;
    this.review = review;
    this.onReviewChange(review);
  }

  private mutation(): { expectedVersion: number; timestamp: string } {
    return {
      expectedVersion: this.review.version,
      timestamp: new Date().toISOString(),
    };
  }

  private isUnitReviewed(index: number): boolean {
    const unitView = this.units[index];
    if (unitView === undefined) return false;
    return this.review.unitProgress.some(
      (progress) =>
        progress.reviewUnitId === unitView.unit.id &&
        progress.disposition === "reviewed",
    );
  }

  private reviewedUnitCount(): number {
    return this.review.unitProgress.filter(
      (progress) => progress.disposition === "reviewed",
    ).length;
  }

  private findComment(anchor: ReviewCommentAnchor): ReviewComment | undefined {
    const key = targetKey(anchor);
    return this.review.comments.find((comment) => targetKey(comment) === key);
  }

  private clearRenderCache(): void {
    this.cachedWidth = undefined;
    this.cachedRows = undefined;
    this.cachedLines = undefined;
  }

  private refresh(): void {
    this.clearRenderCache();
    this.tui.requestRender();
  }
}

/** Upper bound for an accumulated count prefix. */
const MAX_COUNT_PREFIX = 9999;

const DIGIT_KEYS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

function digitKey(data: string): number | undefined {
  for (const [value, key] of DIGIT_KEYS.entries()) {
    if (matchesKey(data, key)) return value;
  }
  return undefined;
}

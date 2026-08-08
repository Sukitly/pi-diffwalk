import assert from "node:assert/strict";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  CURSOR_MARKER,
  Editor,
  type EditorTheme,
  type Focusable,
  Key,
  type KeybindingsManager,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { diffWords } from "diff";
import { ReviewSnapshotDriftError } from "./git-diff.ts";
import {
  deleteInProgressReviewComment,
  discardInProgressReview,
  InProgressReviewError,
  markReviewUnitReviewed,
  setInProgressReviewSubmissionMode,
  upsertInProgressReviewComment,
} from "./in-progress-review.ts";
import {
  listCommentTargets,
  type ReviewCommentAnchor,
  ReviewCommentInputError,
  type ReviewCommentTarget,
} from "./review-comments.ts";
import { assertReviewDeltaMatchesSnapshot } from "./review-delta.ts";
import {
  changedLineKey,
  listFileChangedLines,
  resolvedSpanChangedLines,
  textContent,
} from "./review-span.ts";
import { validateReviewRoute } from "./route-validation.ts";
import type {
  ChangeSide,
  DiffLine,
  FileChange,
  GuidedReviewResult,
  InProgressReview,
  ResolvedSpan,
  ReviewComment,
  ReviewDelta,
  ReviewRoute,
  ReviewRouteCandidate,
  ReviewSnapshot,
  ReviewSpanCandidate,
  ReviewSubmissionMode,
  ReviewUnit,
  SubmittedGuidedReviewResult,
} from "./types.ts";
import {
  countNoun,
  fitColumns,
  fitLine,
  fitRight,
  MEDIUM_HEADER_WIDTH,
  type PrioritizedLineGroup,
  packStatusParts,
  progressBarSegments,
  selectHeaderGroups,
  WIDE_HEADER_WIDTH,
} from "./ui-layout.ts";

export interface GuidedReviewUiInput {
  readonly review: InProgressReview;
  readonly onReviewChange: (review: InProgressReview) => void;
  readonly onSubmit: (
    review: InProgressReview,
    signal: AbortSignal,
  ) => Promise<SubmittedGuidedReviewResult>;
}

export class GuidedReviewUiUnavailableError extends Error {
  constructor(mode: ExtensionContext["mode"]) {
    super(
      `Guided review requires interactive TUI mode; current mode is ${mode}.`,
    );
    this.name = "GuidedReviewUiUnavailableError";
  }
}

export class GuidedReviewUiInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuidedReviewUiInvariantError";
  }
}

type ReviewUiTheme = Pick<Theme, "fg" | "bg" | "bold" | "inverse">;
type ReviewUiKeybindings = Pick<KeybindingsManager, "matches">;

type ReviewScreen =
  | "walkthrough"
  | "comment-editor"
  | "explanation"
  | "inventory"
  | "inventory-diff"
  | "summary"
  | "help"
  | "cancel-confirmation";

type SubmissionStatus =
  | "not-checked"
  | "checking"
  | "repository-drifted"
  | "verification-failed";

type FeedbackType = "info" | "warning";

interface TransientFeedback {
  readonly type: FeedbackType;
  readonly message: string;
}

interface SubmissionFailure {
  readonly type: "repository-drifted" | "verification-failed";
  readonly error: unknown;
}

/** One file region of a review unit, sliced out of the frozen file. */
interface SpanView {
  readonly change: FileChange;
  readonly span: ResolvedSpan;
  readonly lines: readonly DiffLine[];
}

type ChangedLineDisplayOwnership =
  | {
      readonly type: "unit";
      readonly reviewUnitId: ReviewUnit["id"];
      readonly unitTitle: string;
      readonly spanIndex: number;
    }
  | {
      readonly type: "skipped";
      readonly reason: string;
    }
  | {
      readonly type: "carried-forward";
    };

type DisplayOmissionReason =
  | { readonly type: "distant" }
  | { readonly type: "route-jump" }
  | { readonly type: "carried-forward" }
  | { readonly type: "skipped"; readonly reason: string }
  | { readonly type: "other-unit"; readonly unitTitle: string }
  | { readonly type: "shown-earlier" }
  | { readonly type: "shown-later" };

interface PlannedDiffLine {
  readonly type: "line";
  readonly line: DiffLine;
  readonly role: "owned" | "context" | "external";
  readonly externalDetail?: string;
}

interface PlannedDiffOmission {
  readonly type: "omission";
  readonly count: number;
  readonly reason: DisplayOmissionReason;
}

type PlannedDiffItem = PlannedDiffLine | PlannedDiffOmission;

interface UnitDisplayBlock {
  readonly change: FileChange;
  readonly items: readonly PlannedDiffItem[];
}

interface UnitView {
  readonly unit: ReviewUnit;
  readonly displayBlocks: readonly UnitDisplayBlock[];
  readonly targets: readonly ReviewCommentTarget[];
}

type InventoryEntry =
  | {
      readonly type: "file";
      readonly title: string;
      readonly detail: string;
      readonly change: FileChange;
      readonly regions: readonly DiffLine[][];
    }
  | {
      readonly type: "metadata-only" | "binary" | "unsupported" | "notice";
      readonly title: string;
      readonly detail: string;
    };

interface RenderedRow {
  readonly text: string;
  readonly targetKey?: string;
  readonly inventoryIndex?: number;
  readonly displayBlockIndex?: number;
  readonly isBlockHeader?: boolean;
}

interface DiffViewport {
  readonly offset: number;
  readonly contentHeight: number;
  readonly pinnedBlockIndex?: number;
}

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

export async function openGuidedReview(
  ctx: Pick<ExtensionContext, "mode" | "ui">,
  input: GuidedReviewUiInput,
): Promise<GuidedReviewResult> {
  if (ctx.mode !== "tui") {
    throw new GuidedReviewUiUnavailableError(ctx.mode);
  }

  const review = input.review;
  const attachedRoute = review.route;
  if (review.lifecycle !== "ready" || attachedRoute === undefined) {
    throw new GuidedReviewUiInvariantError(
      `Review ${review.id} is not ready for a walkthrough; lifecycle is ${review.lifecycle}.`,
    );
  }
  const route = validateReviewRoute(
    review.snapshot,
    review.delta,
    routeAsCandidate(attachedRoute),
  );
  const progressUnitIds = new Set(
    review.unitProgress.map((progress) => progress.reviewUnitId),
  );
  for (const unit of route.units) {
    if (!progressUnitIds.has(unit.id)) {
      throw new GuidedReviewUiInvariantError(
        `Review ${review.id} has no unit progress for route unit ${unit.id}.`,
      );
    }
  }

  return ctx.ui.custom<GuidedReviewResult>(
    (tui, theme, keybindings, done) =>
      new GuidedReviewComponent({
        tui,
        theme,
        keybindings,
        review,
        route,
        onReviewChange: input.onReviewChange,
        onSubmit: input.onSubmit,
        onComplete: done,
        onPause: () =>
          done({ status: "paused", snapshotId: review.snapshot.id }),
        onDiscard: () =>
          done({ status: "discarded", snapshotId: review.snapshot.id }),
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

export function routeAsCandidate(route: ReviewRoute): ReviewRouteCandidate {
  return {
    snapshotId: route.snapshotId,
    units: route.units.map((unit) => ({
      title: unit.title,
      whyHere: unit.whyHere,
      context: unit.context,
      changeSummary: unit.changeSummary,
      reviewFocus: [...unit.reviewFocus],
      spans: unit.spans.map((span) => spanCandidate(span)),
    })),
    skippedSpans: route.skippedSpans.map((skip) => ({
      span: spanCandidate(skip.span),
      reason: skip.reason,
    })),
  };
}

function spanCandidate(span: ResolvedSpan): ReviewSpanCandidate {
  return {
    path: span.path,
    ...(span.oldStart === undefined
      ? {}
      : { oldStart: span.oldStart, oldEnd: span.oldEnd }),
    ...(span.newStart === undefined
      ? {}
      : { newStart: span.newStart, newEnd: span.newEnd }),
  } as ReviewSpanCandidate;
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
    const header = this.renderHeader(width, rows);
    const footer = this.renderFooter(width, walkthroughFooterText(width));
    const bodyHeight = Math.max(0, rows - header.length - footer.length);
    if (bodyHeight === 0) return [...header, ...footer];

    const unitView = this.currentUnit();
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

    const summary = renderWalkthroughSummary(unitView.unit, this.theme, width);
    const previewHeight = walkthroughPreviewHeight(summary.length, bodyHeight);
    const preview = summary.slice(0, previewHeight);
    if (preview.length > 0 && preview.length < summary.length) {
      preview[preview.length - 1] = fitLine(
        this.theme.fg("dim", "… press e for complete context and questions"),
        width,
      );
    }

    const feedback = renderTransientFeedback(
      this.transientFeedback,
      this.theme,
      width,
    );
    const separator = preview.length > 0 ? [""] : [];
    const diffHeight = Math.max(
      0,
      bodyHeight - preview.length - separator.length - feedback.length,
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
      ...separator,
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
    const unitCount = this.units.length;
    const currentUnit = unitCount === 0 ? 0 : this.unitIndex + 1;
    const reviewed = this.reviewedUnitCount();
    const position = `Unit ${currentUnit}/${unitCount}`;
    const progress = `${reviewed}/${unitCount} reviewed`;
    const comments = countNoun(this.review.comments.length, "comment");
    const statusParts = [comments, `${this.skippedCount} skipped`];
    if (this.unsupportedCount > 0) {
      statusParts.push(`${this.unsupportedCount} unsupported`);
    }

    const brand = this.theme.fg(
      "accent",
      this.theme.bold(`DiffWalk / ${this.screenLabel()}`),
    );
    const title = this.theme.fg(
      "text",
      this.theme.bold(safeText(this.screenTitle())),
    );
    const groups: PrioritizedLineGroup[] = [];

    if (width >= WIDE_HEADER_WIDTH) {
      const progressBar = renderProgressBar(reviewed, unitCount, this.theme);
      const status = `${progressBar}  ${this.theme.fg("muted", progress)}    ${this.theme.fg("muted", statusParts.join(" · "))}`;
      groups.push(
        {
          lines: [fitColumns(brand, this.theme.fg("muted", position), width)],
          priority: 90,
        },
        { lines: [fitLine(title, width)], priority: 80 },
        {
          lines: [fitRight(status, width)],
          priority: 50,
          minimumRows: 5,
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
        { lines: [fitLine(title, width)], priority: 80 },
        {
          lines: packStatusParts([progress, ...statusParts], width).map(
            (line) => fitLine(this.theme.fg("muted", line), width),
          ),
          priority: 40,
          minimumRows: 6,
        },
      );
    } else {
      const narrowBrand =
        width >= 28
          ? brand
          : this.theme.fg("accent", this.theme.bold("DiffWalk"));
      groups.push(
        {
          lines: [
            fitLine(
              `${narrowBrand}${this.theme.fg("dim", ` · ${currentUnit}/${unitCount}`)}`,
              width,
            ),
          ],
          priority: 90,
        },
        { lines: [fitLine(title, width)], priority: 80 },
        {
          lines: [
            fitLine(
              this.theme.fg("muted", `Reviewed ${reviewed}/${unitCount}`),
              width,
            ),
          ],
          priority: 50,
          minimumRows: 6,
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

    groups.push({
      lines: renderSnapshotHeaderAlert(
        this.submissionStatus,
        this.theme,
        width,
      ),
      priority: 100,
    });
    return selectHeaderGroups(groups, rows, reservedRows);
  }

  private renderFooter(width: number, text: string): readonly string[] {
    return [fitLine(this.theme.fg("dim", safeText(text)), width)];
  }

  private screenLabel(): string {
    switch (this.screen) {
      case "walkthrough":
        return "Review";
      case "comment-editor":
        return "Comment";
      case "explanation":
        return "Details";
      case "inventory":
      case "inventory-diff":
        return "Inventory";
      case "summary":
        return "Summary";
      case "help":
        return "Help";
      case "cancel-confirmation":
        return "Pause";
    }
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
    const bodyHeight = Math.max(
      0,
      rows - this.renderHeader(width, rows).length - 1,
    );
    const unit = this.currentUnit();
    if (unit === undefined) return bodyHeight;
    const summary = renderWalkthroughSummary(unit.unit, this.theme, width);
    const previewHeight = walkthroughPreviewHeight(summary.length, bodyHeight);
    const feedbackHeight = renderTransientFeedback(
      this.transientFeedback,
      this.theme,
      width,
    ).length;
    const separatorHeight = previewHeight > 0 ? 1 : 0;
    return Math.max(
      0,
      bodyHeight - previewHeight - separatorHeight - feedbackHeight,
    );
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

function buildReviewViewModel(
  snapshot: ReviewSnapshot,
  delta: ReviewDelta,
  route: ReviewRoute,
  targets: readonly ReviewCommentTarget[],
): {
  readonly units: readonly UnitView[];
  readonly inventory: readonly InventoryEntry[];
  readonly changesById: ReadonlyMap<FileChange["id"], FileChange>;
  readonly displayOwnership: ReadonlyMap<string, ChangedLineDisplayOwnership>;
  readonly unsupportedCount: number;
} {
  assertReviewDeltaMatchesSnapshot(snapshot, delta);
  const changesById = new Map(
    snapshot.changes.map((change) => [change.id, change]),
  );

  const targetsByUnit = new Map<string, ReviewCommentTarget[]>();
  for (const target of targets) {
    const unitTargets = targetsByUnit.get(target.reviewUnitId) ?? [];
    unitTargets.push(target);
    targetsByUnit.set(target.reviewUnitId, unitTargets);
  }

  const displayOwnership = buildChangedLineDisplayOwnership(
    snapshot,
    delta,
    route,
  );
  const units = route.units.map((unit) => {
    const spans = unit.spans.map((span) => {
      const change = changesById.get(span.fileChangeId);
      assert.ok(
        change,
        `Validated route references missing file change ${span.fileChangeId}.`,
      );
      return { change, span, lines: sliceSpan(change, span) };
    });
    const displayBlocks = buildUnitDisplayBlocks(unit, spans, displayOwnership);
    return {
      unit,
      displayBlocks,
      targets: orderTargetsFromDisplayPlan(
        unit,
        displayBlocks,
        targetsByUnit.get(unit.id) ?? [],
      ),
    };
  });

  const requirements = new Map(
    delta.lines.map((requirement) => [
      changedLineKey(requirement),
      requirement,
    ]),
  );
  const plannedKeys = new Set<string>();
  for (const unit of route.units) {
    for (const span of unit.spans) {
      for (const line of resolvedSpanChangedLines(snapshot, span)) {
        plannedKeys.add(changedLineKey(line));
      }
    }
  }
  const skipReasonByKey = new Map<string, string>();
  for (const skip of route.skippedSpans) {
    for (const line of resolvedSpanChangedLines(snapshot, skip.span)) {
      skipReasonByKey.set(changedLineKey(line), skip.reason);
    }
  }

  const inventory: InventoryEntry[] = [];
  for (const change of snapshot.changes) {
    const content = textContent(change);
    if (content === undefined) continue;
    const changed = listFileChangedLines(change);
    if (changed.length === 0) continue;
    let planned = 0;
    let skipped = 0;
    let carried = 0;
    const skipReasons = new Set<string>();
    for (const line of changed) {
      const key = changedLineKey(line);
      if (requirements.get(key)?.type === "carried-forward") {
        carried += 1;
        continue;
      }
      const reason = skipReasonByKey.get(key);
      if (reason !== undefined) {
        skipped += 1;
        skipReasons.add(reason);
        continue;
      }
      if (plannedKeys.has(key)) planned += 1;
    }
    inventory.push({
      type: "file",
      title: `${fileInventoryStatus(planned, skipped, carried)}: ${displayChangePath(change)}`,
      detail: fileInventoryDetail(
        changed.length,
        planned,
        skipped,
        carried,
        skipReasons,
      ),
      change,
      regions: buildDisplayRegions(content.lines),
    });
  }

  let unsupportedCount = 0;
  for (const change of snapshot.changes) {
    if (change.content.type === "text") continue;
    if (
      change.content.type === "binary" ||
      change.content.type === "unsupported"
    ) {
      unsupportedCount += 1;
    }
    inventory.push({
      type: change.content.type,
      title: `${change.content.type}: ${change.status}: ${displayChangePath(change)}`,
      detail: nonTextChangeDetail(change),
    });
  }
  for (const notice of snapshot.notices) {
    inventory.push({
      type: "notice",
      title: `notice: ${notice.filePath === undefined ? notice.type : displayPath(notice.filePath)}`,
      detail: notice.message,
    });
  }

  return {
    units,
    inventory,
    changesById,
    displayOwnership,
    unsupportedCount,
  };
}

function buildChangedLineDisplayOwnership(
  snapshot: ReviewSnapshot,
  delta: ReviewDelta,
  route: ReviewRoute,
): ReadonlyMap<string, ChangedLineDisplayOwnership> {
  const ownership = new Map<string, ChangedLineDisplayOwnership>();
  for (const unit of route.units) {
    for (const [spanIndex, span] of unit.spans.entries()) {
      for (const line of resolvedSpanChangedLines(snapshot, span)) {
        const key = changedLineKey(line);
        const existing = ownership.get(key);
        if (existing?.type === "unit" && existing.reviewUnitId === unit.id) {
          continue;
        }
        if (existing !== undefined) {
          throw new GuidedReviewUiInvariantError(
            `Changed line ${key} has conflicting walkthrough display ownership.`,
          );
        }
        ownership.set(key, {
          type: "unit",
          reviewUnitId: unit.id,
          unitTitle: unit.title,
          spanIndex,
        });
      }
    }
  }

  for (const skip of route.skippedSpans) {
    for (const line of resolvedSpanChangedLines(snapshot, skip.span)) {
      const key = changedLineKey(line);
      if (ownership.has(key)) {
        throw new GuidedReviewUiInvariantError(
          `Changed line ${key} is both routed and skipped in the walkthrough display plan.`,
        );
      }
      ownership.set(key, { type: "skipped", reason: skip.reason });
    }
  }

  for (const requirement of delta.lines) {
    const key = changedLineKey(requirement);
    if (requirement.type === "carried-forward") {
      if (ownership.has(key)) {
        throw new GuidedReviewUiInvariantError(
          `Carried-forward changed line ${key} is also routed or skipped.`,
        );
      }
      ownership.set(key, { type: "carried-forward" });
    } else if (!ownership.has(key)) {
      throw new GuidedReviewUiInvariantError(
        `Changed line ${key} has no walkthrough display ownership.`,
      );
    }
  }
  return ownership;
}

function orderTargetsFromDisplayPlan(
  unit: ReviewUnit,
  blocks: readonly UnitDisplayBlock[],
  targets: readonly ReviewCommentTarget[],
): readonly ReviewCommentTarget[] {
  const targetsByLine = new Map(
    targets.map((target) => [
      fileLineKey(target.fileChangeId, target.side, target.line),
      target,
    ]),
  );
  const ordered: ReviewCommentTarget[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    for (const item of block.items) {
      if (item.type !== "line" || item.role !== "owned") continue;
      const key = diffLineKey(block.change.id, item.line);
      if (key === undefined) continue;
      const target = targetsByLine.get(key);
      if (target === undefined) continue;
      if (seen.has(key)) {
        throw new GuidedReviewUiInvariantError(
          `Review target ${key} is rendered more than once in unit ${unit.id}.`,
        );
      }
      seen.add(key);
      ordered.push(target);
    }
  }
  for (const target of targets) {
    const key = fileLineKey(target.fileChangeId, target.side, target.line);
    if (!seen.has(key)) {
      throw new GuidedReviewUiInvariantError(
        `Review target ${key} has no rendered row in unit ${unit.id}.`,
      );
    }
  }
  return ordered;
}

function walkthroughPreviewHeight(
  summaryLength: number,
  bodyHeight: number,
): number {
  return bodyHeight >= 12
    ? Math.min(summaryLength, 8, Math.max(6, Math.floor(bodyHeight * 0.25)))
    : 0;
}

function renderWalkthroughSummary(
  unit: ReviewUnit,
  theme: ReviewUiTheme,
  width: number,
): string[] {
  const lines = [
    "",
    ...wrapStyled(theme.fg("text", safeText(unit.changeSummary)), width),
    "",
    theme.fg("muted", theme.bold("Review checks")),
  ];
  for (const [index, focus] of unit.reviewFocus.slice(0, 2).entries()) {
    lines.push(
      ...wrapWithPrefix(
        theme.fg("accent", `${String(index + 1).padStart(2, "0")}  `),
        theme.fg("text", safeText(focus)),
        width,
      ),
    );
  }
  if (unit.reviewFocus.length > 2) {
    lines.push(
      theme.fg(
        "dim",
        `… ${unit.reviewFocus.length - 2} more question${unit.reviewFocus.length === 3 ? "" : "s"}; press e for details`,
      ),
    );
  } else {
    lines.push(theme.fg("dim", "Press e for complete context."));
  }
  return lines;
}

interface HelpEntry {
  readonly keys: string;
  readonly action: string;
}

interface HelpSection {
  readonly title: string;
  readonly entries: readonly HelpEntry[];
}

const HELP_SECTIONS: readonly HelpSection[] = [
  {
    title: "Review workflow",
    entries: [
      { keys: "j/k, ↑/↓", action: "Select a changed line or scroll the unit." },
      {
        keys: "p/h/←",
        action: "Open the previous unit without marking it reviewed.",
      },
      {
        keys: "l/→",
        action: "Open the next unit without marking it reviewed.",
      },
      { keys: "c", action: "Add or edit a comment on the selected line." },
      { keys: "d", action: "Delete the comment on the selected line." },
      { keys: "n", action: "Mark the current unit reviewed and continue." },
      { keys: "e", action: "Open the complete unit details." },
      { keys: "i", action: "Open the frozen snapshot inventory." },
      { keys: "s", action: "Open the submission summary." },
      { keys: "Esc", action: "Open the pause and discard screen." },
      { keys: "?", action: "Open or close this keyboard help." },
    ],
  },
  {
    title: "Navigation",
    entries: [
      { keys: "gg / G", action: "Jump to the first or last item." },
      {
        keys: "1-9 + move",
        action: "Repeat the next movement, for example 5j or 2Ctrl+d.",
      },
      { keys: "Ctrl+u/d", action: "Move by half a viewport." },
      {
        keys: "PgUp/PgDn, Ctrl+b/f",
        action: "Move by a full viewport.",
      },
    ],
  },
  {
    title: "Other screens",
    entries: [
      {
        keys: "Details: e/h/←/Esc",
        action: "Return to the walkthrough.",
      },
      {
        keys: "Inventory: Enter/l/→",
        action: "Inspect the selected frozen file diff.",
      },
      {
        keys: "Inventory: i/h/←/Esc",
        action: "Return to the walkthrough.",
      },
      {
        keys: "Frozen diff: h/←/Esc",
        action: "Return to the inventory.",
      },
      {
        keys: "Summary: h/l/←/→/Tab",
        action: "Switch the submission mode.",
      },
      {
        keys: "Summary: Enter",
        action: "Submit, or continue the first pending unit.",
      },
      { keys: "Summary: Esc", action: "Return to the walkthrough." },
      {
        keys: "Verification: Esc",
        action: "Cancel the repository check before submission.",
      },
    ],
  },
  {
    title: "Comment and pause screens",
    entries: [
      { keys: "Comment: Enter", action: "Save the draft comment." },
      { keys: "Comment: Shift+Enter", action: "Insert a newline." },
      { keys: "Comment: Esc", action: "Discard the current edit." },
      { keys: "Pause: Enter", action: "Pause and resume later." },
      { keys: "Pause: d", action: "Discard the review permanently." },
      { keys: "Pause: Esc", action: "Continue the review." },
    ],
  },
];

function renderHelpLines(theme: ReviewUiTheme, width: number): string[] {
  const lines: string[] = [];
  for (const [sectionIndex, section] of HELP_SECTIONS.entries()) {
    if (sectionIndex > 0) lines.push("");
    lines.push(theme.fg("muted", theme.bold(section.title)));
    for (const entry of section.entries) {
      const prefix = `${theme.fg("accent", entry.keys)}  `;
      lines.push(
        ...wrapWithPrefix(
          prefix,
          theme.fg("text", safeText(entry.action)),
          width,
        ),
      );
    }
  }
  return lines;
}

function renderExplanationLines(
  unit: ReviewUnit,
  theme: ReviewUiTheme,
  width: number,
): string[] {
  const lines: string[] = [];
  addSectionText(lines, "Why this comes next", unit.whyHere, theme, width);
  addSectionText(lines, "Context to keep in mind", unit.context, theme, width);
  addSectionText(lines, "Change", unit.changeSummary, theme, width);
  lines.push("", theme.fg("muted", theme.bold("Review checks")));
  for (const focus of unit.reviewFocus) {
    lines.push(
      ...wrapStyled(
        `${theme.fg("accent", "• ")}${theme.fg("text", safeText(focus))}`,
        width,
      ),
    );
  }
  return lines;
}

function addSectionText(
  lines: string[],
  label: string,
  value: string,
  theme: ReviewUiTheme,
  width: number,
): void {
  if (lines.length > 0) lines.push("");
  lines.push(theme.fg("muted", theme.bold(label)));
  lines.push(...wrapStyled(theme.fg("text", safeText(value)), width));
}

const INLINE_SPAN_MERGE_GAP = 6;

interface IndexedSpanView {
  readonly spanIndex: number;
  readonly spanView: SpanView;
}

interface RouteFileBlock {
  readonly change: FileChange;
  readonly spans: IndexedSpanView[];
}

interface SpanViewBounds {
  readonly start: number;
  readonly end: number;
}

function buildUnitDisplayBlocks(
  unit: ReviewUnit,
  spans: readonly SpanView[],
  ownership: ReadonlyMap<string, ChangedLineDisplayOwnership>,
): readonly UnitDisplayBlock[] {
  const routeBlocks: RouteFileBlock[] = [];
  for (const [spanIndex, spanView] of spans.entries()) {
    const previous = routeBlocks.at(-1);
    if (previous?.change.id === spanView.change.id) {
      previous.spans.push({ spanIndex, spanView });
    } else {
      routeBlocks.push({
        change: spanView.change,
        spans: [{ spanIndex, spanView }],
      });
    }
  }
  return routeBlocks.map((block) =>
    buildRouteFileBlock(unit, block, ownership),
  );
}

function buildRouteFileBlock(
  unit: ReviewUnit,
  block: RouteFileBlock,
  ownership: ReadonlyMap<string, ChangedLineDisplayOwnership>,
): UnitDisplayBlock {
  const content = textContent(block.change);
  if (content === undefined) {
    throw new GuidedReviewUiInvariantError(
      `Review span references non-text file change ${block.change.id}.`,
    );
  }
  const items: PlannedDiffItem[] = [];
  const renderedIndexes = new Set<number>();
  let previousBounds: SpanViewBounds | undefined;

  for (const { spanIndex, spanView } of block.spans) {
    const bounds = spanViewBounds(spanView, content.lines);
    if (previousBounds !== undefined) {
      if (bounds.start > previousBounds.end + 1) {
        appendGapItems(
          items,
          content.lines,
          previousBounds.end + 1,
          bounds.start - 1,
          spanIndex,
          unit,
          block.change.id,
          ownership,
          renderedIndexes,
        );
      } else if (bounds.start < previousBounds.start) {
        appendDisplayOmission(items, 0, { type: "route-jump" });
      }
    }

    for (let index = bounds.start; index <= bounds.end; index += 1) {
      const line = content.lines[index];
      if (line === undefined) continue;
      appendSpanLine(
        items,
        line,
        index,
        spanIndex,
        unit,
        block.change.id,
        ownership,
        renderedIndexes,
      );
    }
    previousBounds = bounds;
  }

  return { change: block.change, items };
}

function spanViewBounds(
  spanView: SpanView,
  fileLines: readonly DiffLine[],
): SpanViewBounds {
  const firstLine = spanView.lines[0];
  const lastLine = spanView.lines.at(-1);
  if (firstLine === undefined || lastLine === undefined) {
    throw new GuidedReviewUiInvariantError(
      `Review span for file change ${spanView.change.id} has no frozen lines.`,
    );
  }
  const start = fileLines.indexOf(firstLine);
  const end = fileLines.indexOf(lastLine);
  if (start < 0 || end < start) {
    throw new GuidedReviewUiInvariantError(
      `Review span lines are not part of frozen file change ${spanView.change.id}.`,
    );
  }
  return { start, end };
}

function appendGapItems(
  items: PlannedDiffItem[],
  fileLines: readonly DiffLine[],
  start: number,
  end: number,
  nextSpanIndex: number,
  unit: ReviewUnit,
  fileChangeId: FileChange["id"],
  ownership: ReadonlyMap<string, ChangedLineDisplayOwnership>,
  renderedIndexes: Set<number>,
): void {
  const showContext = end - start + 1 <= INLINE_SPAN_MERGE_GAP;
  for (let index = start; index <= end; index += 1) {
    if (renderedIndexes.has(index)) continue;
    const line = fileLines[index];
    if (line === undefined) continue;
    if (line.type === "context") {
      if (showContext) {
        items.push({ type: "line", line, role: "context" });
      } else {
        appendDisplayOmission(items, 1, { type: "distant" });
      }
      renderedIndexes.add(index);
      continue;
    }
    const lineOwnership = requireDisplayOwnership(
      ownership,
      fileChangeId,
      line,
    );
    appendDisplayOmission(
      items,
      1,
      omissionReasonForOwnership(lineOwnership, unit, nextSpanIndex),
    );
    if (
      lineOwnership.type !== "unit" ||
      lineOwnership.reviewUnitId !== unit.id
    ) {
      renderedIndexes.add(index);
    }
  }
}

function appendSpanLine(
  items: PlannedDiffItem[],
  line: DiffLine,
  lineIndex: number,
  spanIndex: number,
  unit: ReviewUnit,
  fileChangeId: FileChange["id"],
  ownership: ReadonlyMap<string, ChangedLineDisplayOwnership>,
  renderedIndexes: Set<number>,
): void {
  if (line.type === "context") {
    if (!renderedIndexes.has(lineIndex)) {
      items.push({ type: "line", line, role: "context" });
      renderedIndexes.add(lineIndex);
    }
    return;
  }

  const lineOwnership = requireDisplayOwnership(ownership, fileChangeId, line);
  if (lineOwnership.type === "unit" && lineOwnership.reviewUnitId === unit.id) {
    if (lineOwnership.spanIndex !== spanIndex) {
      appendDisplayOmission(
        items,
        1,
        omissionReasonForOwnership(lineOwnership, unit, spanIndex),
      );
      return;
    }
    if (renderedIndexes.has(lineIndex)) {
      throw new GuidedReviewUiInvariantError(
        `Owned changed line ${diffLineKey(fileChangeId, line)} is rendered more than once in unit ${unit.id}.`,
      );
    }
    items.push({ type: "line", line, role: "owned" });
    renderedIndexes.add(lineIndex);
    return;
  }

  if (renderedIndexes.has(lineIndex)) return;
  items.push({
    type: "line",
    line,
    role: "external",
    externalDetail: externalLineDetail(lineOwnership),
  });
  renderedIndexes.add(lineIndex);
}

function requireDisplayOwnership(
  ownership: ReadonlyMap<string, ChangedLineDisplayOwnership>,
  fileChangeId: FileChange["id"],
  line: DiffLine,
): ChangedLineDisplayOwnership {
  const key = diffLineKey(fileChangeId, line);
  if (key === undefined) {
    throw new GuidedReviewUiInvariantError(
      `Context line of file change ${fileChangeId} has no changed-line ownership.`,
    );
  }
  const result = ownership.get(key);
  if (result === undefined) {
    throw new GuidedReviewUiInvariantError(
      `Changed line ${key} has no walkthrough display ownership.`,
    );
  }
  return result;
}

function omissionReasonForOwnership(
  ownership: ChangedLineDisplayOwnership,
  unit: ReviewUnit,
  spanIndex: number,
): DisplayOmissionReason {
  switch (ownership.type) {
    case "carried-forward":
      return { type: "carried-forward" };
    case "skipped":
      return { type: "skipped", reason: ownership.reason };
    case "unit":
      if (ownership.reviewUnitId !== unit.id) {
        return { type: "other-unit", unitTitle: ownership.unitTitle };
      }
      return ownership.spanIndex < spanIndex
        ? { type: "shown-earlier" }
        : { type: "shown-later" };
  }
}

function externalLineDetail(ownership: ChangedLineDisplayOwnership): string {
  switch (ownership.type) {
    case "carried-forward":
      return "Reviewed in an earlier round; these changed lines are not selectable here.";
    case "skipped":
      return `Skipped from the walkthrough: ${ownership.reason}`;
    case "unit":
      return `Routed to review unit ${JSON.stringify(ownership.unitTitle)}; these changed lines are not selectable here.`;
  }
}

function appendDisplayOmission(
  items: PlannedDiffItem[],
  count: number,
  reason: DisplayOmissionReason,
): void {
  const previous = items.at(-1);
  if (
    count > 0 &&
    previous?.type === "omission" &&
    sameOmissionReason(previous.reason, reason)
  ) {
    items[items.length - 1] = {
      ...previous,
      count: previous.count + count,
    };
    return;
  }
  items.push({ type: "omission", count, reason });
}

function sameOmissionReason(
  left: DisplayOmissionReason,
  right: DisplayOmissionReason,
): boolean {
  if (left.type !== right.type) return false;
  switch (left.type) {
    case "skipped":
      return right.type === "skipped" && left.reason === right.reason;
    case "other-unit":
      return right.type === "other-unit" && left.unitTitle === right.unitTitle;
    default:
      return true;
  }
}

function renderUnitDiff(
  unit: UnitView,
  selectedTarget: ReviewCommentTarget | undefined,
  comments: readonly ReviewComment[],
  theme: ReviewUiTheme,
  width: number,
): readonly RenderedRow[] {
  const rows: RenderedRow[] = [];
  const targetsByLine = new Map(
    unit.targets.map((target) => [
      fileLineKey(target.fileChangeId, target.side, target.line),
      target,
    ]),
  );
  const commentsByTarget = new Map(
    comments.map((comment) => [targetKey(comment), comment]),
  );

  for (const [displayBlockIndex, block] of unit.displayBlocks.entries()) {
    if (rows.length > 0) rows.push({ text: "" });
    rows.push(
      ...wrapStyled(renderChangeHeader(block.change, theme), width).map(
        (text) => ({
          text,
          displayBlockIndex,
          isBlockHeader: true,
        }),
      ),
      ...renderPlannedDiffItems(
        block,
        displayBlockIndex,
        targetsByLine,
        commentsByTarget,
        selectedTarget,
        theme,
        width,
      ),
    );
  }
  return rows;
}

function renderPlannedDiffItems(
  block: UnitDisplayBlock,
  displayBlockIndex: number,
  targetsByLine: ReadonlyMap<string, ReviewCommentTarget>,
  commentsByTarget: ReadonlyMap<string, ReviewComment>,
  selectedTarget: ReviewCommentTarget | undefined,
  theme: ReviewUiTheme,
  width: number,
): readonly RenderedRow[] {
  const rows: RenderedRow[] = [];
  let buffered: PlannedDiffLine[] = [];
  let externalDetail: string | undefined;
  const flush = (): void => {
    if (buffered.length === 0) return;
    rows.push(
      ...renderUnitDiffLines(
        buffered,
        displayBlockIndex,
        block.change.id,
        targetsByLine,
        commentsByTarget,
        selectedTarget,
        theme,
        width,
      ),
    );
    buffered = [];
  };

  for (const item of block.items) {
    if (item.type === "omission") {
      flush();
      externalDetail = undefined;
      rows.push(renderOmittedDiffLines(item, displayBlockIndex, theme, width));
      continue;
    }
    if (item.externalDetail !== externalDetail) {
      flush();
      externalDetail = item.externalDetail;
      if (externalDetail !== undefined) {
        rows.push(
          ...renderExternalLineNotice(
            externalDetail,
            displayBlockIndex,
            theme,
            width,
          ),
        );
      }
    }
    buffered.push(item);
  }
  flush();
  return rows;
}

function renderUnitDiffLines(
  lines: readonly PlannedDiffLine[],
  displayBlockIndex: number,
  fileChangeId: FileChange["id"],
  targetsByLine: ReadonlyMap<string, ReviewCommentTarget>,
  commentsByTarget: ReadonlyMap<string, ReviewComment>,
  selectedTarget: ReviewCommentTarget | undefined,
  theme: ReviewUiTheme,
  width: number,
): readonly RenderedRow[] {
  const rows: RenderedRow[] = [];
  const inlineTextByIndex = buildInlineDiffText(
    lines.map(({ line }) => line),
    theme,
  );
  for (const [lineIndex, planned] of lines.entries()) {
    const line = planned.line;
    const target =
      planned.role === "owned"
        ? lineTarget(targetsByLine, fileChangeId, line)
        : undefined;
    const isSelected =
      target !== undefined &&
      selectedTarget !== undefined &&
      targetKey(target) === targetKey(selectedTarget);
    const comment =
      target === undefined
        ? undefined
        : commentsByTarget.get(targetKey(target));
    rows.push(
      ...renderDiffLine(
        line,
        isSelected,
        comment !== undefined,
        planned.role === "external",
        theme,
        width,
        inlineTextByIndex.get(lineIndex),
      ).map((text) => ({
        text,
        displayBlockIndex,
        targetKey: target === undefined ? undefined : targetKey(target),
      })),
    );
    if (comment !== undefined && target !== undefined) {
      rows.push(
        ...renderInlineDraftComment(comment, theme, width).map((text) => ({
          text,
          displayBlockIndex,
          targetKey: targetKey(target),
        })),
      );
    }
  }
  return rows;
}

function renderOmittedDiffLines(
  omission: PlannedDiffOmission,
  displayBlockIndex: number,
  theme: ReviewUiTheme,
  width: number,
): RenderedRow {
  const detail = omissionDetail(omission);
  return {
    text: fitLine(
      `${" ".repeat(DIFF_GUTTER_WIDTH)}${theme.fg("dim", `⋯ ${safeText(detail)}`)}`,
      width,
    ),
    displayBlockIndex,
  };
}

function omissionDetail(omission: PlannedDiffOmission): string {
  const lines = `${omission.count} frozen diff line${omission.count === 1 ? "" : "s"}`;
  switch (omission.reason.type) {
    case "distant":
      return `${lines} not shown`;
    case "route-jump":
      return "routed region continues elsewhere in this file";
    case "carried-forward":
      return `${lines} not shown; reviewed in an earlier round`;
    case "skipped":
      return `${lines} not shown; skipped: ${omission.reason.reason}`;
    case "other-unit":
      return `${lines} not shown; routed to unit ${JSON.stringify(omission.reason.unitTitle)}`;
    case "shown-earlier":
      return `${lines} already shown earlier in this unit`;
    case "shown-later":
      return `${lines} shown later in this unit`;
  }
}

function renderExternalLineNotice(
  detail: string,
  displayBlockIndex: number,
  theme: ReviewUiTheme,
  width: number,
): readonly RenderedRow[] {
  return wrapWithPrefix(
    " ".repeat(DIFF_GUTTER_WIDTH),
    theme.fg("dim", `· ${safeText(detail)}`),
    width,
  ).map((text) => ({ text, displayBlockIndex }));
}

/** Highlighted file path shown above a route-ordered display block. */
function renderChangeHeader(change: FileChange, theme: ReviewUiTheme): string {
  return theme.fg("accent", theme.bold(displayBareChangePath(change)));
}

function lineTarget(
  targetsByLine: ReadonlyMap<string, ReviewCommentTarget>,
  fileChangeId: FileChange["id"],
  line: DiffLine,
): ReviewCommentTarget | undefined {
  const key = diffLineKey(fileChangeId, line);
  return key === undefined ? undefined : targetsByLine.get(key);
}

function diffLineKey(
  fileChangeId: FileChange["id"],
  line: DiffLine,
): string | undefined {
  if (line.type === "added" && line.newLine !== undefined) {
    return fileLineKey(fileChangeId, "new", line.newLine);
  }
  if (line.type === "removed" && line.oldLine !== undefined) {
    return fileLineKey(fileChangeId, "old", line.oldLine);
  }
  return undefined;
}

function describeSpanRange(span: ResolvedSpan): string {
  const parts: string[] = [];
  if (span.oldStart !== undefined && span.oldEnd !== undefined) {
    parts.push(`old ${span.oldStart}-${span.oldEnd}`);
  }
  if (span.newStart !== undefined && span.newEnd !== undefined) {
    parts.push(`new ${span.newStart}-${span.newEnd}`);
  }
  return parts.join("  ");
}

function renderReadOnlyFile(
  entry: Extract<InventoryEntry, { readonly type: "file" }>,
  theme: ReviewUiTheme,
  width: number,
): readonly string[] {
  const lines = [
    ...wrapStyled(theme.fg("accent", theme.bold(safeText(entry.title))), width),
    ...wrapStyled(theme.fg("muted", safeText(entry.detail)), width),
    "",
  ];
  for (const [index, region] of entry.regions.entries()) {
    if (index > 0) lines.push("");
    const inlineTextByIndex = buildInlineDiffText(region, theme);
    for (const [lineIndex, line] of region.entries()) {
      lines.push(
        ...renderDiffLine(
          line,
          false,
          false,
          false,
          theme,
          width,
          inlineTextByIndex.get(lineIndex),
        ),
      );
    }
  }
  return lines;
}

const INLINE_DIFF_MAX_LINE_LENGTH = 1_000;

/**
 * Mirrors Pi's conservative inline-highlighting rule: only pair a replacement
 * block when it contains exactly one removed line followed by one added line.
 * Very long untrusted lines stay line-colored without quadratic word diffing.
 */
function buildInlineDiffText(
  lines: readonly DiffLine[],
  theme: ReviewUiTheme,
): ReadonlyMap<number, string> {
  const rendered = new Map<number, string>();
  let index = 0;
  while (index < lines.length) {
    if (lines[index]?.type !== "removed") {
      index += 1;
      continue;
    }

    const removedStart = index;
    while (lines[index]?.type === "removed") index += 1;
    const addedStart = index;
    while (lines[index]?.type === "added") index += 1;
    if (addedStart - removedStart !== 1 || index - addedStart !== 1) continue;

    const removed = lines[removedStart];
    const added = lines[addedStart];
    if (
      removed === undefined ||
      added === undefined ||
      removed.text.length > INLINE_DIFF_MAX_LINE_LENGTH ||
      added.text.length > INLINE_DIFF_MAX_LINE_LENGTH
    ) {
      continue;
    }
    const pair = renderInlineDiffPair(removed.text, added.text, theme);
    rendered.set(removedStart, `-${pair.removed}`);
    rendered.set(addedStart, `+${pair.added}`);
  }
  return rendered;
}

function renderInlineDiffPair(
  removedText: string,
  addedText: string,
  theme: ReviewUiTheme,
): { readonly removed: string; readonly added: string } {
  const parts = diffWords(safeText(removedText), safeText(addedText));
  let removed = "";
  let added = "";
  let isFirstRemoved = true;
  let isFirstAdded = true;

  for (const part of parts) {
    if (part.removed) {
      let value = part.value;
      if (isFirstRemoved) {
        const leadingWhitespace = value.match(/^(\s*)/)?.[1] ?? "";
        removed += leadingWhitespace;
        value = value.slice(leadingWhitespace.length);
        isFirstRemoved = false;
      }
      if (value.length > 0) removed += theme.inverse(value);
    } else if (part.added) {
      let value = part.value;
      if (isFirstAdded) {
        const leadingWhitespace = value.match(/^(\s*)/)?.[1] ?? "";
        added += leadingWhitespace;
        value = value.slice(leadingWhitespace.length);
        isFirstAdded = false;
      }
      if (value.length > 0) added += theme.inverse(value);
    } else {
      removed += part.value;
      added += part.value;
    }
  }

  return { removed, added };
}

function renderDiffLine(
  line: DiffLine,
  selected: boolean,
  hasComment: boolean,
  external: boolean,
  theme: ReviewUiTheme,
  width: number,
  inlineText?: string,
): readonly string[] {
  const oldLine = line.oldLine === undefined ? "" : String(line.oldLine);
  const newLine = line.newLine === undefined ? "" : String(line.newLine);
  const marker = selected ? ">" : hasComment ? "●" : external ? "·" : " ";
  const prefix = `${marker} ${oldLine.padStart(5)} ${newLine.padStart(5)} `;
  const raw = theme.fg(
    diffColor(line),
    inlineText ?? safeText(diffLineText(line)),
  );
  const lines = wrapWithPrefix(prefix, raw, width);
  if (!selected) return lines;
  return lines.map((rendered) =>
    theme.bg("selectedBg", truncateToWidth(rendered, width, "", true)),
  );
}

const DIFF_GUTTER_WIDTH = 14;
const COMMENT_CARD_MAX_WIDTH = 120;

function renderInlineDraftComment(
  comment: ReviewComment,
  theme: ReviewUiTheme,
  width: number,
): readonly string[] {
  const cardWidth = widthAfterMargin(width, DIFF_GUTTER_WIDTH);
  const contentWidth = Math.min(cardWidth, COMMENT_CARD_MAX_WIDTH);
  const content = [
    ...wrapStyled(
      theme.fg("accent", theme.bold("  [Draft comment]")),
      contentWidth,
    ),
    ...wrapWithPrefix(
      "  ",
      theme.fg("text", safeText(comment.body)),
      contentWidth,
    ),
  ];
  return [
    ...renderBackgroundBlock(
      content,
      "userMessageBg",
      theme,
      width,
      DIFF_GUTTER_WIDTH,
    ),
    "",
  ];
}

interface CommentTargetPreview {
  readonly path: string;
  readonly anchorRows: readonly string[];
  readonly beforeRows: readonly string[];
  readonly afterRows: readonly string[];
}

function buildCommentTargetPreview(
  target: ReviewCommentTarget,
  unit: ReviewUnit | undefined,
  changesById: ReadonlyMap<FileChange["id"], FileChange>,
  ownership: ReadonlyMap<string, ChangedLineDisplayOwnership>,
  comments: readonly ReviewComment[],
  theme: ReviewUiTheme,
  width: number,
): CommentTargetPreview {
  if (unit === undefined || unit.id !== target.reviewUnitId) {
    throw new GuidedReviewUiInvariantError(
      `Comment target ${target.fileChangeId}:${target.side}:${target.line} is not part of the current review unit.`,
    );
  }
  const change = changesById.get(target.fileChangeId);
  if (change === undefined) {
    throw new GuidedReviewUiInvariantError(
      `Comment target ${target.fileChangeId}:${target.side}:${target.line} references file change ${target.fileChangeId}, which is not in the frozen snapshot.`,
    );
  }
  const content = textContent(change);
  if (content === undefined) {
    throw new GuidedReviewUiInvariantError(
      `Comment target ${target.fileChangeId}:${target.side}:${target.line} has no frozen text content.`,
    );
  }
  const anchor = target.context.lines[target.context.anchorIndex];
  if (anchor === undefined || !isCommentTargetLine(target, anchor)) {
    throw new GuidedReviewUiInvariantError(
      `Comment target ${target.fileChangeId}:${target.side}:${target.line} has an invalid frozen context anchor.`,
    );
  }
  const fileIndexes = target.context.lines.map(
    (_line, index) => target.context.fileStartIndex + index,
  );
  const inlineTextByFileIndex = buildInlineDiffTextForFileIndexes(
    content.lines,
    fileIndexes,
    theme,
  );
  const commentedLines = new Set(
    comments.map((comment) =>
      fileLineKey(comment.fileChangeId, comment.side, comment.line),
    ),
  );
  const rows = target.context.lines.map((line, index) => {
    const fileIndex = target.context.fileStartIndex + index;
    const selected = index === target.context.anchorIndex;
    if (line.type !== "context") {
      const lineOwnership = requireDisplayOwnership(
        ownership,
        target.fileChangeId,
        line,
      );
      if (
        lineOwnership.type !== "unit" ||
        lineOwnership.reviewUnitId !== unit.id
      ) {
        return [
          renderCompactCommentOmission(
            commentOmissionReason(lineOwnership),
            theme,
            width,
          ),
        ];
      }
    }
    const key = diffLineKey(target.fileChangeId, line);
    const hasComment = key !== undefined && commentedLines.has(key);
    if (selected) {
      return renderDiffLine(
        line,
        true,
        hasComment,
        false,
        theme,
        width,
        inlineTextByFileIndex.get(fileIndex),
      );
    }
    return [
      renderCompactDiffLine(
        line,
        hasComment,
        theme,
        width,
        inlineTextByFileIndex.get(fileIndex),
      ),
    ];
  });
  return {
    path: truncateToWidth(renderChangeHeader(change, theme), width, "…", true),
    anchorRows: rows[target.context.anchorIndex] ?? [],
    beforeRows: rows.slice(0, target.context.anchorIndex).flat(),
    afterRows: rows.slice(target.context.anchorIndex + 1).flat(),
  };
}

function commentTargetMandatoryHeight(
  preview: CommentTargetPreview,
  maxRows: number,
): number {
  if (maxRows <= 0) return 0;
  if (maxRows === 1) return 1;
  return 1 + Math.min(preview.anchorRows.length, maxRows - 1);
}

function renderCommentTargetPreview(
  preview: CommentTargetPreview,
  mandatoryRows: number,
  contextRows: number,
  theme: ReviewUiTheme,
  width: number,
): readonly string[] {
  if (mandatoryRows <= 0) return [];
  if (mandatoryRows === 1) {
    return [truncateRenderedRows(preview.anchorRows, 1, theme, width)[0] ?? ""];
  }
  const visibleAnchor = truncateRenderedRows(
    preview.anchorRows,
    mandatoryRows - 1,
    theme,
    width,
  );
  if (visibleAnchor.length < preview.anchorRows.length) {
    return [preview.path, ...visibleAnchor];
  }
  const context = selectCommentContextRows(
    preview.beforeRows,
    preview.afterRows,
    contextRows,
  );
  return [preview.path, ...context.before, ...visibleAnchor, ...context.after];
}

function truncateRenderedRows(
  rows: readonly string[],
  height: number,
  theme: ReviewUiTheme,
  width: number,
): readonly string[] {
  if (height <= 0 || rows.length === 0) return [];
  if (rows.length <= height) return [...rows];
  const visible = rows.slice(0, height);
  visible[visible.length - 1] = appendTruncationMarker(
    visible.at(-1) ?? "",
    theme,
    width,
  );
  return visible;
}

function appendTruncationMarker(
  row: string,
  theme: ReviewUiTheme,
  width: number,
): string {
  if (width <= 1) return theme.fg("dim", "…");
  return `${truncateToWidth(row, width - 1, "", true)}${theme.fg("dim", "…")}`;
}

function selectCommentContextRows(
  before: readonly string[],
  after: readonly string[],
  height: number,
): { readonly before: readonly string[]; readonly after: readonly string[] } {
  let beforeCount = 0;
  let afterCount = 0;
  while (beforeCount + afterCount < height) {
    if (
      beforeCount < before.length &&
      (beforeCount <= afterCount || afterCount >= after.length)
    ) {
      beforeCount += 1;
    } else if (afterCount < after.length) {
      afterCount += 1;
    } else {
      break;
    }
  }
  return {
    before: before.slice(before.length - beforeCount),
    after: after.slice(0, afterCount),
  };
}

function commentOmissionReason(
  ownership: ChangedLineDisplayOwnership,
): DisplayOmissionReason {
  switch (ownership.type) {
    case "carried-forward":
      return { type: "carried-forward" };
    case "skipped":
      return { type: "skipped", reason: ownership.reason };
    case "unit":
      return { type: "other-unit", unitTitle: ownership.unitTitle };
  }
}

function renderCompactCommentOmission(
  reason: DisplayOmissionReason,
  theme: ReviewUiTheme,
  width: number,
): string {
  return truncateToWidth(
    `${" ".repeat(DIFF_GUTTER_WIDTH)}${theme.fg("dim", `⋯ ${safeText(omissionDetail({ type: "omission", count: 1, reason }))}`)}`,
    width,
    "…",
    true,
  );
}

function renderCompactDiffLine(
  line: DiffLine,
  hasComment: boolean,
  theme: ReviewUiTheme,
  width: number,
  inlineText?: string,
): string {
  const oldLine = line.oldLine === undefined ? "" : String(line.oldLine);
  const newLine = line.newLine === undefined ? "" : String(line.newLine);
  const marker = hasComment ? "●" : " ";
  const prefix = `${marker} ${oldLine.padStart(5)} ${newLine.padStart(5)} `;
  const raw = theme.fg(
    diffColor(line),
    inlineText ?? safeText(diffLineText(line)),
  );
  return truncateToWidth(`${prefix}${raw}`, width, "…", true);
}

function buildInlineDiffTextForFileIndexes(
  lines: readonly DiffLine[],
  fileIndexes: readonly number[],
  theme: ReviewUiTheme,
): ReadonlyMap<number, string> {
  const rendered = new Map<number, string>();
  for (const fileIndex of new Set(fileIndexes)) {
    const pair = oneLineReplacementAt(lines, fileIndex);
    if (pair === undefined || rendered.has(pair.removedIndex)) continue;
    const removed = lines[pair.removedIndex];
    const added = lines[pair.addedIndex];
    if (
      removed === undefined ||
      added === undefined ||
      removed.text.length > INLINE_DIFF_MAX_LINE_LENGTH ||
      added.text.length > INLINE_DIFF_MAX_LINE_LENGTH
    ) {
      continue;
    }
    const inline = renderInlineDiffPair(removed.text, added.text, theme);
    rendered.set(pair.removedIndex, `-${inline.removed}`);
    rendered.set(pair.addedIndex, `+${inline.added}`);
  }
  return rendered;
}

function oneLineReplacementAt(
  lines: readonly DiffLine[],
  fileIndex: number,
): { readonly removedIndex: number; readonly addedIndex: number } | undefined {
  const line = lines[fileIndex];
  if (line?.type !== "removed" && line?.type !== "added") return undefined;
  let addedStart = fileIndex;
  if (line.type === "added") {
    while (lines[addedStart - 1]?.type === "added") addedStart -= 1;
  } else {
    while (lines[addedStart]?.type === "removed") addedStart += 1;
  }
  let removedStart = addedStart;
  while (lines[removedStart - 1]?.type === "removed") removedStart -= 1;
  let addedEnd = addedStart;
  while (lines[addedEnd]?.type === "added") addedEnd += 1;
  if (addedStart - removedStart !== 1 || addedEnd - addedStart !== 1) {
    return undefined;
  }
  const removedIndex = removedStart;
  const addedIndex = addedStart;
  if (fileIndex !== removedIndex && fileIndex !== addedIndex) return undefined;
  return { removedIndex, addedIndex };
}

function isCommentTargetLine(
  target: ReviewCommentTarget,
  line: DiffLine,
): boolean {
  return target.side === "old"
    ? line.type === "removed" && line.oldLine === target.line
    : line.type === "added" && line.newLine === target.line;
}

function sliceEditorRows(
  lines: readonly string[],
  height: number,
  theme: ReviewUiTheme,
  width: number,
): readonly string[] {
  if (height <= 0) return [];
  if (lines.length <= height) return [...lines];
  const cursorIndex = lines.findIndex((line) => line.includes(CURSOR_MARKER));
  if (height === 1) {
    return [lines[cursorIndex < 0 ? lines.length - 2 : cursorIndex] ?? ""];
  }
  if (height === 2) {
    const cursor =
      lines[cursorIndex < 0 ? lines.length - 2 : cursorIndex] ?? "";
    return [
      cursor,
      renderEditorClipBorder("↓", lines.length - 1, theme, width),
    ];
  }
  const topBorder = lines[0] ?? "";
  const bottomBorder = lines.at(-1) ?? "";
  const content = lines.slice(1, -1);
  const contentHeight = height - 2;
  const contentCursorIndex = content.findIndex((line) =>
    line.includes(CURSOR_MARKER),
  );
  const start = clamp(
    (contentCursorIndex < 0 ? content.length - 1 : contentCursorIndex) -
      Math.floor(contentHeight / 2),
    0,
    content.length - contentHeight,
  );
  const end = start + contentHeight;
  const hiddenAbove = editorBorderHiddenCount(topBorder, "↑") + start;
  const hiddenBelow =
    editorBorderHiddenCount(bottomBorder, "↓") + content.length - end;
  return [
    hiddenAbove > 0
      ? renderEditorClipBorder("↑", hiddenAbove, theme, width)
      : topBorder,
    ...content.slice(start, end),
    hiddenBelow > 0
      ? renderEditorClipBorder("↓", hiddenBelow, theme, width)
      : bottomBorder,
  ];
}

function editorBorderHiddenCount(border: string, direction: "↑" | "↓"): number {
  const match = border.match(new RegExp(`${direction} (\\d+) more`));
  return match === null ? 0 : Number(match[1]);
}

function renderEditorClipBorder(
  direction: "↑" | "↓",
  hiddenRows: number,
  theme: ReviewUiTheme,
  width: number,
): string {
  const indicator = `─── ${direction} ${hiddenRows} more `;
  const line = `${indicator}${"─".repeat(Math.max(0, width - visibleWidth(indicator)))}`;
  return theme.fg("accent", truncateToWidth(line, width, "", true));
}

function renderInventoryRows(
  inventory: readonly InventoryEntry[],
  selectedIndex: number,
  theme: ReviewUiTheme,
  width: number,
): readonly RenderedRow[] {
  if (inventory.length === 0) {
    return [
      { text: theme.fg("muted", "The frozen snapshot inventory is empty.") },
    ];
  }
  const rows: RenderedRow[] = [];
  for (const [index, entry] of inventory.entries()) {
    const selected = index === selectedIndex;
    const prefix = selected ? "> " : "  ";
    const color =
      entry.type === "binary" ||
      entry.type === "unsupported" ||
      entry.type === "notice"
        ? "warning"
        : "text";
    const titleRows = wrapWithPrefix(
      prefix,
      theme.fg(color, safeText(entry.title)),
      width,
    );
    const detailRows = wrapWithPrefix(
      "    ",
      theme.fg("muted", safeText(entry.detail)),
      width,
    );
    for (const text of [...titleRows, ...detailRows]) {
      rows.push({
        text: selected
          ? theme.bg("selectedBg", truncateToWidth(text, width, "", true))
          : text,
        inventoryIndex: index,
      });
    }
  }
  return rows;
}

function renderTransientFeedback(
  feedback: TransientFeedback | undefined,
  theme: ReviewUiTheme,
  width: number,
): readonly string[] {
  if (feedback === undefined) return [];
  return wrapStyled(
    theme.fg(
      feedback.type === "warning" ? "warning" : "muted",
      safeText(feedback.message),
    ),
    width,
  );
}

function renderSubmissionNotice(
  status: SubmissionStatus,
  failure: SubmissionFailure | undefined,
  theme: ReviewUiTheme,
  width: number,
): readonly string[] {
  if (status === "checking") {
    return wrapStyled(
      theme.fg("muted", "Checking the frozen snapshot before submission..."),
      width,
    );
  }
  if (failure === undefined) return [];
  const title =
    failure.type === "repository-drifted"
      ? "Repository drift blocks submission"
      : "Snapshot verification failed";
  return [
    ...wrapStyled(theme.fg("error", theme.bold(title)), width),
    ...wrapStyled(
      theme.fg("warning", safeText(errorMessage(failure.error))),
      width,
    ),
  ];
}

function renderSummaryLines(
  comments: readonly ReviewComment[],
  route: ReviewRoute,
  inventory: readonly InventoryEntry[],
  submissionMode: ReviewSubmissionMode,
  feedback: TransientFeedback | undefined,
  pendingUnits: readonly ReviewUnit[],
  theme: ReviewUiTheme,
  width: number,
): readonly string[] {
  const lines: string[] = [];
  lines.push(...renderTransientFeedback(feedback, theme, width));
  if (pendingUnits.length > 0) {
    lines.unshift(theme.fg("warning", theme.bold("Review incomplete")));
    lines.push(
      ...wrapStyled(
        theme.fg(
          "warning",
          `${pendingUnits.length} section${pendingUnits.length === 1 ? "" : "s"} remain: ${safeText(pendingUnits.map((unit) => unit.title).join(", "))}.`,
        ),
        width,
      ),
      "",
      theme.fg(
        "text",
        "Press Enter to continue with the next pending section.",
      ),
    );
    return lines;
  }
  lines.unshift(
    theme.fg("accent", theme.bold("Comment batch and submission mode")),
  );
  lines.push(
    modeLine(
      submissionMode === "discuss-first",
      "Discuss first",
      "Agent investigates and responds without editing files.",
      theme,
      width,
    ),
    modeLine(
      submissionMode === "apply-change-requests",
      "Apply change requests",
      "Agent may apply direct requests; questions still require discussion.",
      theme,
      width,
    ),
    "",
    theme.fg(
      "muted",
      theme.bold(`Comments (${comments.length}) returned as one batch`),
    ),
  );

  if (comments.length === 0) {
    lines.push(theme.fg("dim", "No comments were added."));
  }
  for (const [index, comment] of comments.entries()) {
    lines.push(
      ...wrapStyled(
        theme.fg(
          "accent",
          `${index + 1}. ${displayCommentPath(comment)} ${renderCommentAnchor(comment)}`,
        ),
        width,
      ),
    );
    lines.push(
      ...wrapWithPrefix(
        "   ",
        theme.fg("toolDiffContext", safeText(comment.selectedText)),
        width,
      ),
    );
    lines.push(
      ...wrapWithPrefix("   ", theme.fg("text", safeText(comment.body)), width),
    );
  }

  lines.push("", theme.fg("muted", theme.bold("Explicitly skipped regions")));
  if (route.skippedSpans.length === 0) {
    lines.push(theme.fg("dim", "None."));
  } else {
    for (const skip of route.skippedSpans) {
      lines.push(
        ...wrapStyled(
          theme.fg(
            "warning",
            `${safeText(displayPath(skip.span.path))} ${safeText(describeSpanRange(skip.span))}: ${safeText(skip.reason)}`,
          ),
          width,
        ),
      );
    }
  }

  const nonTextChanges = inventory.filter((entry) => entry.type !== "file");
  lines.push("", theme.fg("muted", theme.bold("Non-text changes and notices")));
  if (nonTextChanges.length === 0) {
    lines.push(theme.fg("dim", "None."));
  } else {
    for (const entry of nonTextChanges) {
      lines.push(
        ...wrapStyled(
          theme.fg(
            "warning",
            `${safeText(entry.title)}: ${safeText(entry.detail)}`,
          ),
          width,
        ),
      );
    }
  }

  return lines;
}

function modeLine(
  selected: boolean,
  title: string,
  description: string,
  theme: ReviewUiTheme,
  width: number,
): string {
  const text = `${selected ? ">" : " "} ${title}: ${description}`;
  const fitted = truncateToWidth(safeText(text), width, "", true);
  return selected
    ? theme.bg("selectedBg", theme.fg("text", fitted))
    : theme.fg("dim", fitted);
}

function createEditorTheme(theme: ReviewUiTheme): EditorTheme {
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

/** Unchanged lines rendered around a span so a narrow region is never shown bare. */
const SPAN_DISPLAY_CONTEXT_RADIUS = 3;

/**
 * Contiguous slice of the frozen file covering one span.
 *
 * The slice is padded with neighbouring unchanged lines so that a span drawn
 * tightly around its changed lines is still readable. Padding stops at the
 * first changed line outside the span, because that line belongs to another
 * unit and must not look reviewable here. Padding is display only and never
 * affects coverage.
 */
function sliceSpan(
  change: FileChange,
  span: ResolvedSpan,
): readonly DiffLine[] {
  const content = textContent(change);
  if (content === undefined) {
    throw new GuidedReviewUiInvariantError(
      `Validated route references non-text file change ${change.id}.`,
    );
  }
  let start = -1;
  let end = -1;
  for (const [index, line] of content.lines.entries()) {
    if (!lineWithinSpan(span, line)) continue;
    if (start < 0) start = index;
    end = index;
  }
  if (start < 0) return [];

  for (let padded = 0; padded < SPAN_DISPLAY_CONTEXT_RADIUS; padded += 1) {
    if (start === 0 || content.lines[start - 1]?.type !== "context") break;
    start -= 1;
  }
  for (let padded = 0; padded < SPAN_DISPLAY_CONTEXT_RADIUS; padded += 1) {
    if (
      end === content.lines.length - 1 ||
      content.lines[end + 1]?.type !== "context"
    ) {
      break;
    }
    end += 1;
  }
  return content.lines.slice(start, end + 1);
}

function lineWithinSpan(span: ResolvedSpan, line: DiffLine): boolean {
  if (
    line.oldLine !== undefined &&
    span.oldStart !== undefined &&
    span.oldEnd !== undefined &&
    line.oldLine >= span.oldStart &&
    line.oldLine <= span.oldEnd
  ) {
    return true;
  }
  return (
    line.newLine !== undefined &&
    span.newStart !== undefined &&
    span.newEnd !== undefined &&
    line.newLine >= span.newStart &&
    line.newLine <= span.newEnd
  );
}

/** Changed regions of a whole file, padded with context, for read-only inspection. */
function buildDisplayRegions(
  lines: readonly DiffLine[],
  radius = 3,
): readonly DiffLine[][] {
  const regions: DiffLine[][] = [];
  let start = -1;
  let end = -1;
  for (const [index, line] of lines.entries()) {
    if (line.type === "context") continue;
    const from = Math.max(0, index - radius);
    const to = Math.min(lines.length - 1, index + radius);
    if (start < 0) {
      start = from;
      end = to;
      continue;
    }
    if (from <= end + 1) {
      end = Math.max(end, to);
      continue;
    }
    regions.push([...lines.slice(start, end + 1)]);
    start = from;
    end = to;
  }
  if (start >= 0) regions.push([...lines.slice(start, end + 1)]);
  return regions;
}

function fileInventoryStatus(
  planned: number,
  skipped: number,
  carried: number,
): string {
  const parts: string[] = [];
  if (planned > 0) parts.push("planned");
  if (skipped > 0) parts.push("skipped");
  if (carried > 0) parts.push("carried-forward");
  return parts.length === 0 ? "unrouted" : parts.join("+");
}

function fileInventoryDetail(
  total: number,
  planned: number,
  skipped: number,
  carried: number,
  skipReasons: ReadonlySet<string>,
): string {
  const parts = [
    `${total} changed line${total === 1 ? "" : "s"}: ${planned} planned, ${skipped} skipped, ${carried} carried forward.`,
  ];
  for (const reason of skipReasons) parts.push(`Skip reason: ${reason}`);
  return parts.join(" ");
}

function lastTargetKey(rows: readonly RenderedRow[]): string | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const key = rows[index]?.targetKey;
    if (key !== undefined) return key;
  }
  return undefined;
}

/** Smallest diff viewport that can afford to reserve a line for a pinned header. */
const MIN_PINNED_HEADER_VIEWPORT = 5;

/**
 * Scroll offset and pinned display-block header for the walkthrough diff viewport.
 *
 * When the file header of the block at the top of the viewport has scrolled
 * away, one viewport line is reserved to pin that header so the file name
 * stays visible, and the offset is recomputed so the selected line remains
 * inside the smaller viewport. Viewports shorter than
 * MIN_PINNED_HEADER_VIEWPORT keep every line for content.
 *
 * With anchorToTarget false the offset is only clamped, so paging can move
 * through regions without a commentable line while the selection stays
 * off-screen.
 */
function resolveDiffViewport(
  rows: readonly RenderedRow[],
  target: ReviewCommentTarget | undefined,
  offset: number,
  height: number,
  anchorToTarget = true,
): DiffViewport {
  let next = anchorToTarget
    ? ensureTargetVisible(rows, target, offset, height)
    : clampOffset(offset, rows.length, height);
  let pinned =
    height >= MIN_PINNED_HEADER_VIEWPORT
      ? stickyBlockIndex(rows, next)
      : undefined;
  if (pinned !== undefined) {
    next = anchorToTarget
      ? ensureTargetVisible(rows, target, next, height - 1)
      : clampOffset(next, rows.length, height - 1);
    pinned = stickyBlockIndex(rows, next);
  }
  return {
    offset: next,
    contentHeight: pinned === undefined ? height : height - 1,
    ...(pinned === undefined ? {} : { pinnedBlockIndex: pinned }),
  };
}

/**
 * Index of the display block whose header must be pinned for the given scroll offset.
 *
 * Returns undefined when the top of the viewport already shows a block header,
 * so the pinned line never duplicates a visible header.
 */
function stickyBlockIndex(
  rows: readonly RenderedRow[],
  offset: number,
): number | undefined {
  if (offset <= 0) return undefined;
  for (let index = offset; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.displayBlockIndex === undefined) continue;
    return row.isBlockHeader ? undefined : row.displayBlockIndex;
  }
  return undefined;
}

/**
 * Single-line file title pinned above the read-only file viewport once the
 * inline title has scrolled out, so the file name stays visible.
 */
function pinnedFileTitle(
  entry: Extract<InventoryEntry, { readonly type: "file" }>,
  offset: number,
  theme: ReviewUiTheme,
  width: number,
): readonly string[] {
  const title = theme.fg("accent", theme.bold(safeText(entry.title)));
  if (offset < wrapStyled(title, width).length) return [];
  return [fitLine(title, width)];
}

/**
 * Rows kept visible above and below the selected line while scrolling, so
 * the unchanged padding around a span reappears when the cursor returns to
 * the edge of the viewport. Shrinks to fit small viewports.
 */
const DIFF_SCROLL_MARGIN = SPAN_DISPLAY_CONTEXT_RADIUS;

function ensureTargetVisible(
  rows: readonly RenderedRow[],
  target: ReviewCommentTarget | undefined,
  offset: number,
  viewportHeight: number,
): number {
  if (viewportHeight <= 0 || target === undefined) return 0;
  const selectedKey = targetKey(target);
  const first = rows.findIndex((row) => row.targetKey === selectedKey);
  let last = -1;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index]?.targetKey === selectedKey) {
      last = index;
      break;
    }
  }
  if (first < 0) return clampOffset(offset, rows.length, viewportHeight);

  let next = clampOffset(offset, rows.length, viewportHeight);
  const selectedHeight = last - first + 1;
  if (selectedHeight <= viewportHeight) {
    const margin = Math.min(
      DIFF_SCROLL_MARGIN,
      Math.floor((viewportHeight - selectedHeight) / 2),
    );
    if (first - margin < next) next = Math.max(0, first - margin);
    else if (last + margin >= next + viewportHeight) {
      next = last + margin - viewportHeight + 1;
    }
  } else if (last < next || first >= next + viewportHeight) {
    next = first;
  }
  return clampOffset(next, rows.length, viewportHeight);
}

function ensureInventorySelectionVisible(
  rows: readonly RenderedRow[],
  selectedIndex: number,
  offset: number,
  viewportHeight: number,
): number {
  if (viewportHeight <= 0) return 0;
  const first = rows.findIndex((row) => row.inventoryIndex === selectedIndex);
  let last = -1;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index]?.inventoryIndex === selectedIndex) {
      last = index;
      break;
    }
  }
  if (first < 0) return clampOffset(offset, rows.length, viewportHeight);
  let next = clampOffset(offset, rows.length, viewportHeight);
  if (first < next) next = first;
  else if (last >= next + viewportHeight) next = first;
  return clampOffset(next, rows.length, viewportHeight);
}

function sliceViewport(
  rows: readonly RenderedRow[],
  offset: number,
  height: number,
): readonly RenderedRow[] {
  if (height <= 0) return [];
  return rows.slice(offset, offset + height);
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

function renderProgressBar(
  reviewed: number,
  total: number,
  theme: ReviewUiTheme,
): string {
  const segments = progressBarSegments(reviewed, total);
  return `${theme.fg("accent", "█".repeat(segments.completed))}${theme.fg(
    "borderMuted",
    "░".repeat(segments.remaining),
  )}`;
}

function renderSnapshotHeaderAlert(
  status: SubmissionStatus,
  theme: ReviewUiTheme,
  width: number,
): readonly string[] {
  switch (status) {
    case "not-checked":
      return [];
    case "checking":
      return [
        fitLine(theme.fg("warning", "Snapshot check in progress"), width),
      ];
    case "repository-drifted":
      return [
        fitLine(
          theme.fg("error", "Snapshot changed; submission is blocked"),
          width,
        ),
      ];
    case "verification-failed":
      return [
        fitLine(
          theme.fg("error", "Snapshot check failed; submission is blocked"),
          width,
        ),
      ];
  }
}

const WALKTHROUGH_FOOTERS = [
  "j/k line • ←/→ unit • c comment • d delete • n complete • e details • i inventory • s summary • Esc pause • ? help",
  "j/k line • ←/→ unit • c comment • n complete • e details • i inventory • s summary • Esc pause • ? help",
  "j/k line • ←/→ unit • c comment • n complete • e details • i inventory • s summary • ? help",
  "j/k line • ←/→ unit • c comment • n complete • e details • s summary • ? help",
  "j/k line • ←/→ unit • c comment • n complete • ? help",
  "c comment • ←/→ unit • n finish • ? help",
  "c comment • n finish • ? help",
  "c comment • ? help",
  "? help",
  "?",
] as const;

function walkthroughFooterText(width: number): string {
  const available = Math.max(1, width);
  return (
    WALKTHROUGH_FOOTERS.find((footer) => visibleWidth(footer) <= available) ??
    "?"
  );
}

function fillLine(line: string, width: number): string {
  const fitted = fitLine(line, width);
  return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}

function renderBackgroundBlock(
  lines: readonly string[],
  background: Parameters<ReviewUiTheme["bg"]>[0],
  theme: ReviewUiTheme,
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

function displayPath(path: string): string {
  return safeText(JSON.stringify(path));
}

function displayChangePath(change: FileChange): string {
  if (
    change.oldPath !== undefined &&
    change.newPath !== undefined &&
    change.oldPath !== change.newPath
  ) {
    return `${displayPath(change.oldPath)} -> ${displayPath(change.newPath)}`;
  }
  const path = change.newPath ?? change.oldPath;
  return path === undefined ? "<unknown path>" : displayPath(path);
}

function displayBareChangePath(change: FileChange): string {
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

function nonTextChangeDetail(change: FileChange): string {
  if (change.content.type === "text") {
    throw new GuidedReviewUiInvariantError(
      `Text change ${change.id} was rendered as a non-text inventory entry.`,
    );
  }
  const details = [`Status: ${change.status}.`, `Source: ${change.source}.`];
  if (change.oldMode !== undefined || change.newMode !== undefined) {
    details.push(`Mode: ${change.oldMode ?? "-"} -> ${change.newMode ?? "-"}.`);
  }
  details.push(change.content.unsupportedReason);
  return details.join(" ");
}

function displayCommentPath(comment: ReviewComment): string {
  if (
    comment.oldPath !== undefined &&
    comment.newPath !== undefined &&
    comment.oldPath !== comment.newPath
  ) {
    return `${displayPath(comment.oldPath)} -> ${displayPath(comment.newPath)}`;
  }
  return displayPath(comment.filePath);
}

function renderCommentAnchor(comment: ReviewComment): string {
  return `(old ${comment.oldLine ?? "-"}, new ${comment.newLine ?? "-"})`;
}

function diffColor(line: DiffLine): Parameters<ReviewUiTheme["fg"]>[0] {
  switch (line.type) {
    case "added":
      return "toolDiffAdded";
    case "removed":
      return "toolDiffRemoved";
    case "context":
      return "toolDiffContext";
  }
}

/** Restores the unified diff prefix that the frozen model stores separately. */
function diffLineText(line: DiffLine): string {
  const prefix =
    line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
  return `${prefix}${line.text}`;
}

function anchorFromTarget(target: ReviewCommentTarget): ReviewCommentAnchor {
  return {
    reviewUnitId: target.reviewUnitId,
    fileChangeId: target.fileChangeId,
    side: target.side,
    line: target.line,
  };
}

function targetKey(anchor: ReviewCommentAnchor): string {
  return `${anchor.reviewUnitId}\u0000${changedLineKey(anchor)}`;
}

function fileLineKey(
  fileChangeId: FileChange["id"],
  side: ChangeSide,
  line: number,
): string {
  return `${fileChangeId}\u0000${side}\u0000${line}`;
}

function halfPage(viewportHeight: number): number {
  return Math.max(1, Math.floor(viewportHeight / 2));
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

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}

function clampOffset(
  offset: number,
  contentLength: number,
  viewportHeight: number,
): number {
  return clamp(offset, 0, Math.max(0, contentLength - viewportHeight));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

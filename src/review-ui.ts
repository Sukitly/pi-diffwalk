import assert from "node:assert/strict";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
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

type ReviewUiTheme = Pick<Theme, "fg" | "bg" | "bold">;
type ReviewUiKeybindings = Pick<KeybindingsManager, "matches">;

type ReviewScreen =
  | "walkthrough"
  | "comment-editor"
  | "explanation"
  | "inventory"
  | "inventory-diff"
  | "summary"
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

interface UnitView {
  readonly unit: ReviewUnit;
  readonly spans: readonly SpanView[];
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
  readonly spanIndex?: number;
  readonly isSpanHeader?: boolean;
}

interface DiffViewport {
  readonly offset: number;
  readonly contentHeight: number;
  readonly pinnedSpanIndex?: number;
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
  private unitIndex = 0;
  private readonly selectedTargetByUnit: number[];
  private diffOffset = 0;
  private explanationOffset = 0;
  private inventoryIndex = 0;
  private inventoryOffset = 0;
  private inventoryDiffOffset = 0;
  private summaryOffset = 0;
  private submissionStatus: SubmissionStatus = "not-checked";
  private submissionFailure?: SubmissionFailure;
  private transientFeedback?: TransientFeedback;
  private commentInputError?: string;
  private submissionAttempt = 0;
  private submissionAbortController?: AbortController;
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

    switch (this.screen) {
      case "walkthrough":
        this.handleWalkthroughInput(data);
        break;
      case "comment-editor":
        this.handleCommentEditorInput(data);
        break;
      case "explanation":
        this.handleExplanationInput(data);
        break;
      case "inventory":
        this.handleInventoryInput(data);
        break;
      case "inventory-diff":
        this.handleInventoryDiffInput(data);
        break;
      case "summary":
        this.handleSummaryInput(data);
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
      case "cancel-confirmation":
        return this.renderCancelConfirmation(width, rows);
    }
  }

  private renderWalkthrough(width: number, rows: number): readonly string[] {
    const header = this.renderHeader(width);
    const footer = this.renderFooter(
      width,
      "j/k select line • c comment • n complete section • e details • s summary • Esc pause",
    );
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
    const summaryBudget =
      bodyHeight >= 12
        ? Math.min(
            summary.length,
            8,
            Math.max(3, Math.floor(bodyHeight * 0.25)),
          )
        : 0;
    const preview = summary.slice(0, summaryBudget);
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
    const diffLabel = this.theme.fg(
      "accent",
      this.theme.bold("Git snapshot diff"),
    );
    const separator = preview.length > 0 ? [""] : [];
    const diffHeight = Math.max(
      0,
      bodyHeight - preview.length - separator.length - feedback.length - 1,
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
    );
    this.diffOffset = viewport.offset;
    const pinnedSpan =
      viewport.pinnedSpanIndex === undefined
        ? undefined
        : unitView.spans[viewport.pinnedSpanIndex];
    const pinnedHeader =
      pinnedSpan === undefined
        ? []
        : [
            fitLine(
              this.theme.fg(
                "muted",
                this.theme.bold(spanHeaderLabel(pinnedSpan)),
              ),
              width,
            ),
          ];
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
      diffLabel,
      ...pinnedHeader,
      ...diffRows,
      ...footer,
    ];
  }

  private renderCommentEditor(width: number, rows: number): readonly string[] {
    const target = this.currentTarget();
    const header = this.renderHeader(width);
    const footer = this.renderFooter(
      width,
      "Enter save • Shift+Enter newline • Esc discard edit",
    );
    const bodyHeight = Math.max(0, rows - header.length - footer.length);
    const body: string[] = [];
    body.push(this.theme.fg("accent", this.theme.bold("Review comment")));
    if (target !== undefined) {
      body.push(
        ...wrapStyled(
          `${this.theme.fg("muted", displayPath(target.filePath))} ${renderLineAnchor(target.diffLine)}`,
          width,
        ),
      );
      body.push(renderSelectedDiffText(target.diffLine, this.theme, width));
    }
    if (this.commentInputError !== undefined) {
      body.push(
        ...wrapStyled(
          this.theme.fg("warning", safeText(this.commentInputError)),
          width,
        ),
      );
    }
    const remaining = Math.max(0, bodyHeight - body.length);
    const editorLines = this.editor.render(width);
    if (editorLines.length <= remaining) {
      body.push(...editorLines);
    } else if (remaining > 0) {
      body.push(...editorLines.slice(editorLines.length - remaining));
    }
    return [...header, ...body.slice(0, bodyHeight), ...footer];
  }

  private renderExplanation(width: number, rows: number): readonly string[] {
    const header = this.renderHeader(width);
    const footer = this.renderFooter(
      width,
      "j/k or ↑/↓ scroll • PgUp/PgDn page • e/Esc return",
    );
    const viewportHeight = Math.max(0, rows - header.length - footer.length);
    const unit = this.currentUnit()?.unit;
    const content =
      unit === undefined
        ? [this.theme.fg("muted", "No agent explanation is available.")]
        : renderExplanationLines(unit, this.theme, width);
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
    const header = this.renderHeader(width);
    const footer = this.renderFooter(
      width,
      "j/k or ↑/↓ select • Enter inspect frozen hunk • i/Esc return",
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
    const header = this.renderHeader(width);
    const footer = this.renderFooter(
      width,
      "j/k or ↑/↓ scroll • PgUp/PgDn page • Esc return to inventory",
    );
    const viewportHeight = Math.max(0, rows - header.length - footer.length);
    const entry = this.inventory[this.inventoryIndex];
    const content =
      entry?.type === "file"
        ? renderReadOnlyFile(entry, this.theme, width)
        : [this.theme.fg("muted", "This inventory entry has no text diff.")];
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
    const header = this.renderHeader(width);
    const footer = this.renderFooter(
      width,
      this.submissionStatus === "checking"
        ? "Checking repository state... • Esc cancel verification"
        : this.pendingUnits().length > 0
          ? "Enter continue next pending section • Esc return"
          : "←/→ or Tab mode • j/k scroll • Enter submit • Esc return",
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
    const content = renderSummaryLines(
      this.review.comments,
      this.route,
      this.inventory,
      this.review.submissionMode,
      this.transientFeedback,
      this.pendingUnits(),
      this.theme,
      width,
    );
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

  private renderCancelConfirmation(
    width: number,
    rows: number,
  ): readonly string[] {
    const header = this.renderHeader(width);
    const footer = this.renderFooter(
      width,
      "Enter pause and resume later • d discard review • Esc continue",
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

  private renderHeader(width: number): readonly string[] {
    const unitCount = this.units.length;
    const position =
      unitCount === 0 ? "unit 0/0" : `unit ${this.unitIndex + 1}/${unitCount}`;
    const progress = `reviewed ${this.reviewedUnitCount()}/${unitCount}`;
    const comments = `comments ${this.review.comments.length}`;
    const inventory = `skipped ${this.skippedCount} • unsupported ${this.unsupportedCount}`;
    const verification = `snapshot ${submissionLabel(this.submissionStatus)}`;
    const title = this.screenTitle();
    return [
      fitLine(
        `${this.theme.fg(
          "accent",
          this.theme.bold(`DiffWalk • ${position} • ${progress} • ${comments}`),
        )} ${this.theme.fg("dim", `• ${inventory} • ${verification}`)}`,
        width,
      ),
      fitLine(this.theme.fg("text", safeText(title)), width),
      "",
    ];
  }

  private renderFooter(width: number, text: string): readonly string[] {
    return [fitLine(this.theme.fg("dim", safeText(text)), width)];
  }

  private screenTitle(): string {
    switch (this.screen) {
      case "walkthrough":
        return this.currentUnit()?.unit.title ?? "Review inventory";
      case "comment-editor":
        return "Review comment";
      case "explanation":
        return "Agent explanation";
      case "inventory":
      case "inventory-diff":
        return "Review inventory";
      case "summary":
        return "Submission summary";
      case "cancel-confirmation":
        return "Pause or discard review";
    }
  }

  private handleWalkthroughInput(data: string): void {
    if (this.isUp(data)) {
      this.moveTarget(-1);
      return;
    }
    if (this.isDown(data)) {
      this.moveTarget(1);
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.pageWalkthrough(-1);
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.pageWalkthrough(1);
      return;
    }
    if (matchesKey(data, "p") || matchesKey(data, Key.left)) {
      this.moveUnit(-1);
      return;
    }
    if (matchesKey(data, Key.right)) {
      this.moveUnit(1);
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

  private handleExplanationInput(data: string): void {
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, "e") ||
      matchesKey(data, Key.left)
    ) {
      this.openScreen("walkthrough");
      return;
    }
    if (this.isUp(data)) this.scrollExplanation(-1);
    else if (this.isDown(data)) this.scrollExplanation(1);
    else if (matchesKey(data, Key.pageUp))
      this.scrollExplanation(-this.secondaryViewportHeight());
    else if (matchesKey(data, Key.pageDown))
      this.scrollExplanation(this.secondaryViewportHeight());
  }

  private handleInventoryInput(data: string): void {
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, "i") ||
      matchesKey(data, Key.left)
    ) {
      this.transientFeedback = undefined;
      this.openScreen("walkthrough");
      return;
    }
    if (this.isUp(data)) {
      this.moveInventorySelection(-1);
      return;
    }
    if (this.isDown(data)) {
      this.moveInventorySelection(1);
      return;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
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

  private handleInventoryDiffInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
      this.openScreen("inventory");
      return;
    }
    if (this.isUp(data)) this.scrollInventoryDiff(-1);
    else if (this.isDown(data)) this.scrollInventoryDiff(1);
    else if (matchesKey(data, Key.pageUp))
      this.scrollInventoryDiff(-this.secondaryViewportHeight());
    else if (matchesKey(data, Key.pageDown))
      this.scrollInventoryDiff(this.secondaryViewportHeight());
  }

  private handleSummaryInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.transientFeedback = undefined;
      this.openScreen("walkthrough");
      return;
    }
    if (
      matchesKey(data, Key.left) ||
      matchesKey(data, Key.right) ||
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
    if (this.isUp(data)) this.scrollSummary(-1);
    else if (this.isDown(data)) this.scrollSummary(1);
    else if (matchesKey(data, Key.pageUp))
      this.scrollSummary(-this.summaryViewportHeight());
    else if (matchesKey(data, Key.pageDown))
      this.scrollSummary(this.summaryViewportHeight());
    else if (matchesKey(data, Key.enter)) this.startSubmission();
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

  private moveTarget(delta: number): void {
    const unit = this.currentUnit();
    if (unit === undefined || unit.targets.length === 0) return;
    const next = clamp(
      this.currentTargetIndex() + delta,
      0,
      unit.targets.length - 1,
    );
    this.selectedTargetByUnit[this.unitIndex] = next;
    this.transientFeedback = undefined;
    this.refresh();
  }

  private pageWalkthrough(direction: -1 | 1): void {
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
    );
    const nextOffset = clampOffset(
      viewport.offset + direction * viewport.contentHeight,
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
    }
    this.diffOffset = nextOffset;
    this.transientFeedback = undefined;
    this.refresh();
  }

  private moveUnit(delta: number): void {
    if (this.units.length === 0) return;
    this.unitIndex = clamp(this.unitIndex + delta, 0, this.units.length - 1);
    this.diffOffset = 0;
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

  private scrollSummary(delta: number): void {
    this.summaryOffset = Math.max(0, this.summaryOffset + delta);
    this.refresh();
  }

  private startSubmission(): void {
    if (this.submissionStatus === "checking") return;
    const firstPendingIndex = this.units.findIndex(
      (_unit, index) => !this.isUnitReviewed(index),
    );
    if (firstPendingIndex >= 0) {
      this.unitIndex = firstPendingIndex;
      this.diffOffset = 0;
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
    return Math.max(1, this.tui.terminal.rows - 3);
  }

  private summaryViewportHeight(): number {
    const width = Math.max(1, this.tui.terminal.columns);
    const availableHeight = Math.max(0, this.tui.terminal.rows - 3);
    const noticeHeight = renderSubmissionNotice(
      this.submissionStatus,
      this.submissionFailure,
      this.theme,
      width,
    ).slice(0, availableHeight).length;
    return Math.max(1, availableHeight - noticeHeight);
  }

  private walkthroughDiffViewportHeight(width: number, rows: number): number {
    const bodyHeight = Math.max(0, rows - 3);
    const unit = this.currentUnit();
    if (unit === undefined) return Math.max(0, bodyHeight - 1);
    const summary = renderWalkthroughSummary(unit.unit, this.theme, width);
    const previewHeight =
      bodyHeight >= 8
        ? Math.min(
            summary.length,
            8,
            Math.max(3, Math.floor(bodyHeight * 0.25)),
          )
        : 0;
    const feedbackHeight = renderTransientFeedback(
      this.transientFeedback,
      this.theme,
      width,
    ).length;
    return Math.max(0, bodyHeight - previewHeight - feedbackHeight - 1);
  }

  private openCancelConfirmation(): void {
    this.returnScreen = this.screen;
    this.transientFeedback = undefined;
    this.openScreen("cancel-confirmation");
  }

  private openScreen(screen: ReviewScreen): void {
    this.screen = screen;
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

  const units = route.units.map((unit) => ({
    unit,
    spans: unit.spans.map((span) => {
      const change = changesById.get(span.fileChangeId);
      assert.ok(
        change,
        `Validated route references missing file change ${span.fileChangeId}.`,
      );
      return { change, span, lines: sliceSpan(change, span) };
    }),
    targets: targetsByUnit.get(unit.id) ?? [],
  }));

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

  return { units, inventory, unsupportedCount };
}

function renderWalkthroughSummary(
  unit: ReviewUnit,
  theme: ReviewUiTheme,
  width: number,
): string[] {
  const lines = [theme.fg("accent", theme.bold("Review this change"))];
  lines.push(
    ...wrapStyled(theme.fg("text", safeText(unit.changeSummary)), width),
  );
  lines.push(theme.fg("muted", theme.bold("Focus")));
  for (const focus of unit.reviewFocus.slice(0, 2)) {
    lines.push(
      ...wrapStyled(
        `${theme.fg("accent", "• ")}${theme.fg("text", safeText(focus))}`,
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
    lines.push(
      theme.fg("dim", "Press e for context and the full explanation."),
    );
  }
  return lines;
}

function renderExplanationLines(
  unit: ReviewUnit,
  theme: ReviewUiTheme,
  width: number,
): string[] {
  const lines: string[] = [];
  lines.push(theme.fg("accent", theme.bold("Agent explanation")));
  addLabeledText(lines, "Why here", unit.whyHere, theme, width);
  addLabeledText(lines, "Context", unit.context, theme, width);
  addLabeledText(lines, "What changed", unit.changeSummary, theme, width);
  lines.push(theme.fg("muted", theme.bold("Review focus")));
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

function addLabeledText(
  lines: string[],
  label: string,
  value: string,
  theme: ReviewUiTheme,
  width: number,
): void {
  const prefix = `${theme.fg("muted", theme.bold(`${label}:`))} `;
  lines.push(
    ...wrapWithPrefix(prefix, theme.fg("text", safeText(value)), width),
  );
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
  const commentedTargets = new Set(
    comments.map((comment) => targetKey(comment)),
  );
  for (const [spanIndex, spanView] of unit.spans.entries()) {
    if (spanIndex > 0) rows.push({ text: "" });
    rows.push(
      ...wrapStyled(theme.fg("muted", spanHeaderLabel(spanView)), width).map(
        (text) => ({ text, spanIndex, isSpanHeader: true }),
      ),
    );
    for (const line of spanView.lines) {
      const target = lineTarget(targetsByLine, spanView.change.id, line);
      const isSelected =
        target !== undefined &&
        selectedTarget !== undefined &&
        targetKey(target) === targetKey(selectedTarget);
      const hasComment =
        target !== undefined && commentedTargets.has(targetKey(target));
      rows.push(
        ...renderDiffLine(line, isSelected, hasComment, theme, width).map(
          (text) => ({
            text,
            spanIndex,
            targetKey: target === undefined ? undefined : targetKey(target),
          }),
        ),
      );
    }
  }
  return rows;
}

/** File path and line ranges shown above a span and pinned when scrolled. */
function spanHeaderLabel(spanView: SpanView): string {
  return `${displayChangePath(spanView.change)}  ${safeText(describeSpanRange(spanView.span))}`;
}

function lineTarget(
  targetsByLine: ReadonlyMap<string, ReviewCommentTarget>,
  fileChangeId: FileChange["id"],
  line: DiffLine,
): ReviewCommentTarget | undefined {
  if (line.type === "added" && line.newLine !== undefined) {
    return targetsByLine.get(fileLineKey(fileChangeId, "new", line.newLine));
  }
  if (line.type === "removed" && line.oldLine !== undefined) {
    return targetsByLine.get(fileLineKey(fileChangeId, "old", line.oldLine));
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
    for (const line of region) {
      lines.push(...renderDiffLine(line, false, false, theme, width));
    }
  }
  return lines;
}

function renderDiffLine(
  line: DiffLine,
  selected: boolean,
  hasComment: boolean,
  theme: ReviewUiTheme,
  width: number,
): readonly string[] {
  const oldLine = line.oldLine === undefined ? "" : String(line.oldLine);
  const newLine = line.newLine === undefined ? "" : String(line.newLine);
  const marker = selected ? ">" : hasComment ? "●" : " ";
  const prefix = `${marker} ${oldLine.padStart(5)} ${newLine.padStart(5)} `;
  const raw = theme.fg(diffColor(line), safeText(diffLineText(line)));
  const lines = wrapWithPrefix(prefix, raw, width);
  if (!selected) return lines;
  return lines.map((rendered) =>
    theme.bg("selectedBg", truncateToWidth(rendered, width, "", true)),
  );
}

function renderSelectedDiffText(
  line: DiffLine,
  theme: ReviewUiTheme,
  width: number,
): string {
  return fitLine(
    theme.fg(diffColor(line), safeText(diffLineText(line))),
    width,
  );
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
 * Scroll offset and pinned span header for the walkthrough diff viewport.
 *
 * When the file header of the span at the top of the viewport has scrolled
 * away, one viewport line is reserved to pin that header so the file name
 * stays visible, and the offset is recomputed so the selected line remains
 * inside the smaller viewport. Viewports shorter than
 * MIN_PINNED_HEADER_VIEWPORT keep every line for content.
 */
function resolveDiffViewport(
  rows: readonly RenderedRow[],
  target: ReviewCommentTarget | undefined,
  offset: number,
  height: number,
): DiffViewport {
  let next = ensureTargetVisible(rows, target, offset, height);
  let pinned =
    height >= MIN_PINNED_HEADER_VIEWPORT
      ? stickySpanIndex(rows, next)
      : undefined;
  if (pinned !== undefined) {
    next = ensureTargetVisible(rows, target, next, height - 1);
    pinned = stickySpanIndex(rows, next);
  }
  return {
    offset: next,
    contentHeight: pinned === undefined ? height : height - 1,
    ...(pinned === undefined ? {} : { pinnedSpanIndex: pinned }),
  };
}

/**
 * Index of the span whose header must be pinned for the given scroll offset.
 *
 * Returns undefined when the top of the viewport already shows a span header,
 * so the pinned line never duplicates a visible header.
 */
function stickySpanIndex(
  rows: readonly RenderedRow[],
  offset: number,
): number | undefined {
  if (offset <= 0) return undefined;
  for (let index = offset; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.spanIndex === undefined) continue;
    return row.isSpanHeader ? undefined : row.spanIndex;
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
    if (first < next) next = first;
    else if (last >= next + viewportHeight) next = last - viewportHeight + 1;
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

function fitLine(line: string, width: number): string {
  return truncateToWidth(line, Math.max(1, width), "");
}

function fillLine(line: string, width: number): string {
  const fitted = fitLine(line, width);
  return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
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

function renderLineAnchor(line: DiffLine): string {
  return `(old ${line.oldLine ?? "-"}, new ${line.newLine ?? "-"})`;
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

function submissionLabel(status: SubmissionStatus): string {
  switch (status) {
    case "not-checked":
      return "check-on-submit";
    case "checking":
      return "checking";
    case "repository-drifted":
      return "repository-drifted";
    case "verification-failed":
      return "verification-failed";
  }
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

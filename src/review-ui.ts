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
  type ReviewCommentAnchor,
  ReviewCommentInputError,
  type ReviewCommentTarget,
  ReviewSession,
  type ReviewSnapshotVerifier,
} from "./review-comments.ts";
import {
  assertReviewDeltaMatchesSnapshot,
  listSnapshotHunks,
} from "./review-delta.ts";
import { validateReviewRoute } from "./route-validation.ts";
import type {
  DiffHunk,
  DiffLine,
  FileChange,
  GuidedReviewResult,
  HunkId,
  HunkReviewRequirement,
  ReviewComment,
  ReviewDelta,
  ReviewRoute,
  ReviewRouteCandidate,
  ReviewSnapshot,
  ReviewSubmissionMode,
  ReviewUnit,
  SubmittedGuidedReviewResult,
} from "./types.ts";

export interface GuidedReviewUiInput {
  readonly snapshot: ReviewSnapshot;
  readonly delta: ReviewDelta;
  readonly route: ReviewRouteCandidate;
  readonly verifySnapshot: ReviewSnapshotVerifier;
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

type FeedbackKind = "info" | "warning";

interface TransientFeedback {
  readonly kind: FeedbackKind;
  readonly message: string;
}

interface SubmissionFailure {
  readonly kind: "repository-drifted" | "verification-failed";
  readonly error: unknown;
}

interface HunkView {
  readonly hunk: DiffHunk;
  readonly change: FileChange;
}

interface UnitView {
  readonly unit: ReviewUnit;
  readonly hunks: readonly HunkView[];
  readonly targets: readonly ReviewCommentTarget[];
}

type InventoryEntry =
  | {
      readonly kind: "hunk";
      readonly title: string;
      readonly detail: string;
      readonly hunkView: HunkView;
    }
  | {
      readonly kind: "metadata-only" | "binary" | "unsupported" | "notice";
      readonly title: string;
      readonly detail: string;
    };

interface RenderedRow {
  readonly text: string;
  readonly targetKey?: string;
  readonly inventoryIndex?: number;
}

interface GuidedReviewComponentOptions {
  readonly tui: TUI;
  readonly theme: ReviewUiTheme;
  readonly keybindings: ReviewUiKeybindings;
  readonly snapshot: ReviewSnapshot;
  readonly delta: ReviewDelta;
  readonly route: ReviewRoute;
  readonly session: ReviewSession;
  readonly onSubmit: (
    mode: ReviewSubmissionMode,
    signal: AbortSignal,
  ) => Promise<SubmittedGuidedReviewResult>;
  readonly onComplete: (result: SubmittedGuidedReviewResult) => void;
  readonly onCancel: () => void;
}

export async function openGuidedReview(
  ctx: Pick<ExtensionContext, "mode" | "ui">,
  input: GuidedReviewUiInput,
): Promise<GuidedReviewResult> {
  if (ctx.mode !== "tui") {
    throw new GuidedReviewUiUnavailableError(ctx.mode);
  }

  const route = validateReviewRoute(input.snapshot, input.delta, input.route);
  const session = new ReviewSession(input.snapshot, route);

  return ctx.ui.custom<GuidedReviewResult>(
    (tui, theme, keybindings, done) =>
      new GuidedReviewComponent({
        tui,
        theme,
        keybindings,
        snapshot: input.snapshot,
        delta: input.delta,
        route,
        session,
        onSubmit: (mode, signal) =>
          session.submit(mode, input.verifySnapshot, signal),
        onComplete: done,
        onCancel: () => done(session.cancel()),
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

export class GuidedReviewComponent implements Component, Focusable {
  private readonly tui: TUI;
  private readonly theme: ReviewUiTheme;
  private readonly keybindings: ReviewUiKeybindings;
  private readonly route: ReviewRoute;
  private readonly session: ReviewSession;
  private readonly units: readonly UnitView[];
  private readonly inventory: readonly InventoryEntry[];
  private readonly skippedCount: number;
  private readonly unsupportedCount: number;
  private readonly onSubmit: (
    mode: ReviewSubmissionMode,
    signal: AbortSignal,
  ) => Promise<SubmittedGuidedReviewResult>;
  private readonly onComplete: (result: SubmittedGuidedReviewResult) => void;
  private readonly onCancel: () => void;
  private readonly editor: Editor;
  private screen: ReviewScreen = "walkthrough";
  private returnScreen: ReviewScreen = "walkthrough";
  private unitIndex = 0;
  private readonly selectedTargetByUnit: number[];
  private readonly visitedUnits = new Set<number>();
  private diffOffset = 0;
  private explanationOffset = 0;
  private inventoryIndex = 0;
  private inventoryOffset = 0;
  private inventoryDiffOffset = 0;
  private summaryOffset = 0;
  private submissionMode: ReviewSubmissionMode = "discuss-first";
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
    this.session = options.session;
    this.onSubmit = options.onSubmit;
    this.onComplete = options.onComplete;
    this.onCancel = options.onCancel;
    const viewModel = buildReviewViewModel(
      options.snapshot,
      options.delta,
      options.route,
      options.session.listCommentableLines(),
    );
    this.units = viewModel.units;
    this.inventory = viewModel.inventory;
    this.skippedCount = options.route.skippedHunks.length;
    this.unsupportedCount = viewModel.unsupportedCount;
    this.selectedTargetByUnit = this.units.map(() => 0);
    if (this.units.length > 0) this.visitedUnits.add(0);

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
      "j/k line • n/p unit • c comment • d delete • e explain • i inventory • s submit • Esc cancel",
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

    const explanation = renderExplanationLines(
      unitView.unit,
      this.theme,
      width,
    );
    const previewBudget =
      bodyHeight >= 8
        ? Math.min(
            explanation.length,
            Math.max(2, Math.floor(bodyHeight * 0.35)),
          )
        : 0;
    const preview = explanation.slice(0, previewBudget);
    if (preview.length > 0 && preview.length < explanation.length) {
      preview[preview.length - 1] = fitLine(
        this.theme.fg("dim", "… press e for the complete agent explanation"),
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
    const diffHeight = Math.max(
      0,
      bodyHeight - preview.length - feedback.length - 1,
    );
    const renderedDiff = renderUnitDiff(
      unitView,
      this.currentTarget(),
      this.session,
      this.theme,
      width,
    );
    this.diffOffset = ensureTargetVisible(
      renderedDiff,
      this.currentTarget(),
      this.diffOffset,
      diffHeight,
    );
    const diffRows = sliceViewport(
      renderedDiff,
      this.diffOffset,
      diffHeight,
    ).map(({ text }) => text);

    return [
      ...header,
      ...preview,
      ...feedback,
      diffLabel,
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
          `${this.theme.fg("muted", displayPath(target.filePath))} ${renderLineAnchor(target.line)}`,
          width,
        ),
      );
      body.push(renderSelectedDiffText(target.line, this.theme, width));
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
        : renderExplanationLines(unit, this.theme, width, true);
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
      entry?.kind === "hunk"
        ? renderReadOnlyHunk(entry, this.theme, width)
        : [this.theme.fg("muted", "This inventory entry has no text diff.")];
    this.inventoryDiffOffset = clampOffset(
      this.inventoryDiffOffset,
      content.length,
      viewportHeight,
    );
    return [
      ...header,
      ...content.slice(
        this.inventoryDiffOffset,
        this.inventoryDiffOffset + viewportHeight,
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
      this.session.getComments(),
      this.route,
      this.inventory,
      this.submissionMode,
      this.transientFeedback,
      this.unvisitedUnits(),
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
      "Enter/y cancel review • Esc/n keep reviewing",
    );
    const comments = this.session.getComments().length;
    const content = [
      this.theme.fg("warning", this.theme.bold("Cancel guided review?")),
      ...wrapStyled(
        this.theme.fg(
          "text",
          `The ${comments} draft comment${comments === 1 ? "" : "s"} will remain local to this review session and will not be returned to the agent.`,
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
    const progress = `visited ${this.visitedUnits.size}/${unitCount}`;
    const comments = `comments ${this.session.getComments().length}`;
    const inventory = `skipped ${this.skippedCount} • unsupported ${this.unsupportedCount}`;
    const verification = `snapshot ${submissionLabel(this.submissionStatus)}`;
    const title = this.screenTitle();
    return [
      fitLine(
        this.theme.fg(
          "accent",
          this.theme.bold(`DiffWalk • ${position} • ${progress} • ${comments}`),
        ),
        width,
      ),
      fitLine(
        `${this.theme.fg("text", safeText(title))} ${this.theme.fg("dim", `• ${inventory} • ${verification}`)}`,
        width,
      ),
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
        return "Cancel guided review";
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
    if (matchesKey(data, "n") || matchesKey(data, Key.right)) {
      this.moveUnit(1);
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
      if (entry?.kind === "hunk") {
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
      this.submissionMode =
        this.submissionMode === "discuss-first"
          ? "apply-change-requests"
          : "discuss-first";
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
    if (matchesKey(data, Key.enter) || matchesKey(data, "y")) {
      this.onCancel();
      return;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, "n")) {
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
      this.session,
      this.theme,
      width,
    );
    const currentOffset = ensureTargetVisible(
      rows,
      this.currentTarget(),
      this.diffOffset,
      viewportHeight,
    );
    const nextOffset = clampOffset(
      currentOffset + direction * viewportHeight,
      rows.length,
      viewportHeight,
    );
    if (nextOffset === currentOffset) {
      this.transientFeedback = undefined;
      this.refresh();
      return;
    }
    const visibleRows = rows.slice(nextOffset, nextOffset + viewportHeight);
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
    this.visitedUnits.add(this.unitIndex);
    this.diffOffset = 0;
    this.explanationOffset = 0;
    this.transientFeedback = undefined;
    this.refresh();
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
    const existing = this.session.getComment(target);
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
      this.session.upsertComment({ ...anchorFromTarget(target), body });
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
    const { deleted } = this.session.deleteComment(target);
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
    const unvisited = this.unvisitedUnits();
    if (unvisited.length > 0) {
      this.summaryOffset = 0;
      this.refresh();
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
      submission = this.onSubmit(this.submissionMode, controller.signal);
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
    const kind =
      error instanceof ReviewSnapshotDriftError
        ? "repository-drifted"
        : "verification-failed";
    this.submissionStatus = kind;
    this.submissionFailure = { kind, error };
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
      kind: "info",
      message: "Snapshot verification was cancelled.",
    };
  }

  private setTransientFeedback(kind: FeedbackKind, message: string): void {
    this.transientFeedback = { kind, message };
    this.refresh();
  }

  private unvisitedUnits(): readonly ReviewUnit[] {
    return this.units
      .filter((_unit, index) => !this.visitedUnits.has(index))
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
    const explanation = renderExplanationLines(unit.unit, this.theme, width);
    const previewHeight =
      bodyHeight >= 8
        ? Math.min(
            explanation.length,
            Math.max(2, Math.floor(bodyHeight * 0.35)),
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
  const hunks = listSnapshotHunks(snapshot);
  const changesById = new Map(
    snapshot.changes.map((change) => [change.id, change]),
  );
  const hunkViewsById = new Map<HunkId, HunkView>();
  for (const hunk of hunks) {
    const change = changesById.get(hunk.fileChangeId);
    assert.ok(change, `Snapshot hunk ${hunk.id} has no file change.`);
    hunkViewsById.set(hunk.id, { hunk, change });
  }

  const targetsByUnit = new Map<string, ReviewCommentTarget[]>();
  for (const target of targets) {
    const unitTargets = targetsByUnit.get(target.reviewUnitId) ?? [];
    unitTargets.push(target);
    targetsByUnit.set(target.reviewUnitId, unitTargets);
  }

  const units = route.units.map((unit) => ({
    unit,
    hunks: unit.hunkIds.map((hunkId) => {
      const hunkView = hunkViewsById.get(hunkId);
      assert.ok(hunkView, `Validated route references missing hunk ${hunkId}.`);
      return hunkView;
    }),
    targets: targetsByUnit.get(unit.id) ?? [],
  }));

  const requirementsById = new Map(
    delta.hunks.map((requirement) => [requirement.hunkId, requirement]),
  );
  const unitsByHunkId = new Map(
    route.units.flatMap((unit) =>
      unit.hunkIds.map((hunkId) => [hunkId, unit] as const),
    ),
  );
  const skipsByHunkId = new Map(
    route.skippedHunks.map((skip) => [skip.hunkId, skip.reason]),
  );
  const inventory: InventoryEntry[] = hunks.map((hunk) => {
    const hunkView = hunkViewsById.get(hunk.id);
    const requirement = requirementsById.get(hunk.id);
    assert.ok(hunkView, `Snapshot inventory lost hunk ${hunk.id}.`);
    assert.ok(
      requirement,
      `Review delta has no requirement for hunk ${hunk.id}.`,
    );
    return {
      kind: "hunk",
      title: `${inventoryStatus(requirement, unitsByHunkId.get(hunk.id), skipsByHunkId.get(hunk.id))}: ${displayChangePath(hunkView.change)} ${hunk.header.raw}`,
      detail: inventoryDetail(
        requirement,
        unitsByHunkId.get(hunk.id),
        skipsByHunkId.get(hunk.id),
      ),
      hunkView,
    };
  });

  let unsupportedCount = 0;
  for (const change of snapshot.changes) {
    if (change.content.kind === "text") continue;
    if (
      change.content.kind === "binary" ||
      change.content.kind === "unsupported"
    ) {
      unsupportedCount += 1;
    }
    inventory.push({
      kind: change.content.kind,
      title: `${change.content.kind}: ${change.status}: ${displayChangePath(change)}`,
      detail: nonTextChangeDetail(change),
    });
  }
  for (const notice of snapshot.notices) {
    inventory.push({
      kind: "notice",
      title: `notice: ${notice.filePath === undefined ? notice.kind : displayPath(notice.filePath)}`,
      detail: notice.message,
    });
  }

  return { units, inventory, unsupportedCount };
}

function renderExplanationLines(
  unit: ReviewUnit,
  theme: ReviewUiTheme,
  width: number,
  complete = false,
): string[] {
  const lines: string[] = [];
  lines.push(
    theme.fg(
      "accent",
      theme.bold(
        complete
          ? "Agent explanation"
          : "Agent explanation (press e to expand)",
      ),
    ),
  );
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
  session: ReviewSession,
  theme: ReviewUiTheme,
  width: number,
): readonly RenderedRow[] {
  const rows: RenderedRow[] = [];
  const targetsByLine = new Map(
    unit.targets.map((target) => [
      hunkLineKey(target.hunkId, target.diffLineIndex),
      target,
    ]),
  );
  const commentedTargets = new Set(
    session.getComments().map((comment) => targetKey(comment)),
  );
  for (const [hunkIndex, hunkView] of unit.hunks.entries()) {
    if (hunkIndex > 0) rows.push({ text: "" });
    rows.push(
      ...wrapStyled(
        theme.fg(
          "muted",
          `${displayChangePath(hunkView.change)}  ${safeText(hunkView.hunk.header.raw)}`,
        ),
        width,
      ).map((text) => ({ text })),
    );
    for (const line of hunkView.hunk.lines) {
      const target = targetsByLine.get(
        hunkLineKey(hunkView.hunk.id, line.index),
      );
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
            targetKey: target === undefined ? undefined : targetKey(target),
          }),
        ),
      );
    }
  }
  return rows;
}

function renderReadOnlyHunk(
  entry: Extract<InventoryEntry, { readonly kind: "hunk" }>,
  theme: ReviewUiTheme,
  width: number,
): readonly string[] {
  const lines = [
    ...wrapStyled(theme.fg("accent", theme.bold(safeText(entry.title))), width),
    ...wrapStyled(theme.fg("muted", safeText(entry.detail)), width),
    "",
  ];
  for (const line of entry.hunkView.hunk.lines) {
    lines.push(...renderDiffLine(line, false, false, theme, width));
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
  const raw = theme.fg(diffColor(line), safeText(line.raw));
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
  return fitLine(theme.fg(diffColor(line), safeText(line.raw)), width);
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
      entry.kind === "binary" ||
      entry.kind === "unsupported" ||
      entry.kind === "notice"
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
      feedback.kind === "warning" ? "warning" : "muted",
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
    failure.kind === "repository-drifted"
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
  unvisitedUnits: readonly ReviewUnit[],
  theme: ReviewUiTheme,
  width: number,
): readonly string[] {
  const lines: string[] = [
    theme.fg("accent", theme.bold("Comment batch and submission mode")),
  ];
  lines.push(...renderTransientFeedback(feedback, theme, width));
  if (unvisitedUnits.length > 0) {
    lines.push(
      ...wrapStyled(
        theme.fg(
          "warning",
          `Submission requires visiting every planned unit. Remaining: ${safeText(unvisitedUnits.map((unit) => unit.title).join(", "))}.`,
        ),
        width,
      ),
    );
  }
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
        theme.fg("toolDiffContext", safeText(comment.selectedDiffText)),
        width,
      ),
    );
    lines.push(
      ...wrapWithPrefix("   ", theme.fg("text", safeText(comment.body)), width),
    );
  }

  lines.push("", theme.fg("muted", theme.bold("Explicitly skipped hunks")));
  if (route.skippedHunks.length === 0) {
    lines.push(theme.fg("dim", "None."));
  } else {
    for (const skip of route.skippedHunks) {
      lines.push(
        ...wrapStyled(
          theme.fg(
            "warning",
            `${safeText(skip.hunkId)}: ${safeText(skip.reason)}`,
          ),
          width,
        ),
      );
    }
  }

  const nonTextChanges = inventory.filter((entry) => entry.kind !== "hunk");
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

function inventoryStatus(
  requirement: HunkReviewRequirement,
  unit: ReviewUnit | undefined,
  skipReason: string | undefined,
): string {
  if (requirement.type === "carried-forward") {
    if (unit !== undefined || skipReason !== undefined) {
      throw new GuidedReviewUiInvariantError(
        `Carried-forward hunk ${requirement.hunkId} appears in the planned route.`,
      );
    }
    return "carried-forward";
  }
  if (skipReason !== undefined) return "skipped";
  if (unit !== undefined) return "planned";
  throw new GuidedReviewUiInvariantError(
    `Needs-review hunk ${requirement.hunkId} is neither planned nor explicitly skipped.`,
  );
}

function inventoryDetail(
  requirement: HunkReviewRequirement,
  unit: ReviewUnit | undefined,
  skipReason: string | undefined,
): string {
  if (requirement.type === "carried-forward") {
    return `Reviewed in round ${requirement.reviewedInRoundId}; available for explicit inspection outside the planned route.`;
  }
  if (skipReason !== undefined) return `Skip reason: ${skipReason}`;
  if (unit !== undefined) {
    return `Review unit: ${unit.title}. Requirement: ${requirement.reason}.`;
  }
  return `Requirement: ${requirement.reason}.`;
}

function lastTargetKey(rows: readonly RenderedRow[]): string | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const key = rows[index]?.targetKey;
    if (key !== undefined) return key;
  }
  return undefined;
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
  if (change.content.kind === "text") {
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
  switch (line.kind) {
    case "added":
      return "toolDiffAdded";
    case "removed":
      return "toolDiffRemoved";
    case "context":
    case "no-newline-marker":
      return "toolDiffContext";
  }
}

function anchorFromTarget(target: ReviewCommentTarget): ReviewCommentAnchor {
  return {
    reviewUnitId: target.reviewUnitId,
    hunkId: target.hunkId,
    diffLineIndex: target.diffLineIndex,
  };
}

function targetKey(anchor: ReviewCommentAnchor): string {
  return JSON.stringify([
    anchor.reviewUnitId,
    anchor.hunkId,
    anchor.diffLineIndex,
  ]);
}

function hunkLineKey(hunkId: HunkId, diffLineIndex: number): string {
  return JSON.stringify([hunkId, diffLineIndex]);
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

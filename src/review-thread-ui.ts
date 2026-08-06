import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { REVIEW_COMMENT_CONTEXT_RADIUS } from "./review-comments.ts";
import { setReviewThreadResolved } from "./review-threads.ts";
import type {
  DiffLine,
  FileChange,
  ReviewCommentId,
  ReviewCommentThread,
  ReviewSnapshot,
  ReviewThreadBatch,
} from "./types.ts";

interface ReviewThreadUiInput {
  readonly snapshot: ReviewSnapshot;
  readonly batch: ReviewThreadBatch;
  readonly onBatchChange: (batch: ReviewThreadBatch) => void;
}

type ThreadUiTheme = Pick<Theme, "fg" | "bg" | "bold">;

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
  readonly theme: ThreadUiTheme;
  readonly getRows: () => number;
  readonly requestRender: () => void;
  readonly onClose: (batch: ReviewThreadBatch) => void;
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
): Promise<ReviewThreadBatch> {
  if (ctx.mode !== "tui") {
    throw new ReviewThreadUiError(
      `DiffWalk comment threads require interactive TUI mode; current mode is ${ctx.mode}.`,
    );
  }
  assertBatchMatchesSnapshot(input.batch, input.snapshot);

  return ctx.ui.custom<ReviewThreadBatch>(
    (tui, theme, _keybindings, done) =>
      new ReviewThreadComponent({
        ...input,
        theme,
        getRows: () => tui.terminal.rows,
        requestRender: () => tui.requestRender(),
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
  private readonly theme: ThreadUiTheme;
  private readonly getRows: () => number;
  private readonly requestRender: () => void;
  private readonly onBatchChange: (batch: ReviewThreadBatch) => void;
  private readonly onClose: (batch: ReviewThreadBatch) => void;
  private readonly regions: readonly ThreadRegion[];
  private threadIndex = 0;
  private offset = 0;
  private freeScroll = false;
  private feedback?: string;
  private cachedWidth?: number;
  private cachedRows?: number;
  private cachedLines?: readonly string[];
  focused = false;

  constructor(options: ReviewThreadComponentOptions) {
    assertBatchMatchesSnapshot(options.batch, options.snapshot);
    this.snapshot = structuredClone(options.snapshot);
    this.batch = structuredClone(options.batch);
    this.theme = options.theme;
    this.getRows = options.getRows;
    this.requestRender = options.requestRender;
    this.onBatchChange = options.onBatchChange;
    this.onClose = options.onClose;
    this.regions = buildThreadRegions(this.snapshot, this.batch);
  }

  render(width: number): string[] {
    const renderWidth = Math.max(1, Math.floor(width));
    const terminalRows = Math.max(1, this.getRows());
    if (
      this.cachedWidth === renderWidth &&
      this.cachedRows === terminalRows &&
      this.cachedLines !== undefined
    ) {
      return [...this.cachedLines];
    }
    const header = this.renderHeader(renderWidth);
    const footer = [
      fitLine(
        this.theme.fg(
          "dim",
          "j/k thread • PgUp/PgDn scroll • r resolve/reopen • Esc close",
        ),
        renderWidth,
      ),
    ];
    const feedback =
      this.feedback === undefined
        ? []
        : wrapStyled(
            this.theme.fg("warning", safeText(this.feedback)),
            renderWidth,
          );
    const viewportHeight = Math.max(
      0,
      terminalRows - header.length - feedback.length - footer.length,
    );
    const rows = renderThreadRows(
      this.regions,
      this.batch,
      this.currentThread()?.id,
      this.theme,
      renderWidth,
    );
    this.offset = this.freeScroll
      ? clampOffset(this.offset, rows.length, viewportHeight)
      : ensureThreadVisible(
          rows,
          this.currentThread()?.id,
          this.offset,
          viewportHeight,
        );
    const screen = fillScreenHeight(
      [
        ...header,
        ...feedback,
        ...rows
          .slice(this.offset, this.offset + viewportHeight)
          .map((row) => row.text),
        ...footer,
      ],
      terminalRows,
    ).map((line) => fillLine(oneTerminalLine(line), renderWidth));
    this.cachedWidth = renderWidth;
    this.cachedRows = terminalRows;
    this.cachedLines = screen;
    return [...screen];
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.onClose(structuredClone(this.batch));
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
    if (matchesKey(data, "r")) this.toggleResolved();
  }

  invalidate(): void {
    this.clearCache();
  }

  private renderHeader(width: number): readonly string[] {
    const total = this.batch.threads.length;
    const answered = this.batch.threads.filter(
      (thread) => thread.response !== undefined,
    ).length;
    const resolved = this.batch.threads.filter(
      (thread) => thread.resolved,
    ).length;
    return [
      fitLine(
        this.theme.fg(
          "accent",
          this.theme.bold(
            `DiffWalk threads • ${this.threadIndex + 1}/${total} • answered ${answered}/${total} • resolved ${resolved}/${total}`,
          ),
        ),
        width,
      ),
      fitLine(
        this.theme.fg(
          "text",
          this.currentThread() === undefined
            ? "Comment responses"
            : `${this.currentThread()?.id} • ${this.currentThread()?.resolved ? "resolved" : "open"}`,
        ),
        width,
      ),
      "",
    ];
  }

  private currentThread(): ReviewCommentThread | undefined {
    return this.batch.threads[this.threadIndex];
  }

  private moveThread(delta: number): void {
    this.threadIndex = clamp(
      this.threadIndex + delta,
      0,
      this.batch.threads.length - 1,
    );
    this.freeScroll = false;
    this.feedback = undefined;
    this.refresh();
  }

  private page(direction: -1 | 1): void {
    const viewportHeight = Math.max(1, this.getRows() - 4);
    this.offset = Math.max(0, this.offset + direction * viewportHeight);
    this.freeScroll = true;
    this.feedback = undefined;
    this.refresh();
  }

  private toggleResolved(): void {
    const thread = this.currentThread();
    if (thread === undefined) return;
    if (thread.response === undefined) {
      this.feedback = "The Agent has not answered this comment yet.";
      this.refresh();
      return;
    }
    this.batch = setReviewThreadResolved(
      this.batch,
      thread.id,
      !thread.resolved,
    );
    this.onBatchChange(structuredClone(this.batch));
    this.feedback = undefined;
    this.refresh();
  }

  private clearCache(): void {
    this.cachedWidth = undefined;
    this.cachedRows = undefined;
    this.cachedLines = undefined;
  }

  private refresh(): void {
    this.clearCache();
    this.requestRender();
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
  if (batch.threads.length === 0) {
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
    const change = changes.get(thread.comment.fileChangeId);
    if (change === undefined) {
      throw new ReviewThreadUiError(
        `Thread ${thread.id} references missing file change ${thread.comment.fileChangeId}.`,
      );
    }
    if (change.content.type !== "text") {
      throw new ReviewThreadUiError(
        `Thread ${thread.id} references non-text file change ${change.id}.`,
      );
    }
    const anchorIndex = change.content.lines.findIndex((line) =>
      thread.comment.side === "new"
        ? line.newLine === thread.comment.line && line.type === "added"
        : line.oldLine === thread.comment.line && line.type === "removed",
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
  theme: ThreadUiTheme,
  width: number,
): readonly RenderedThreadRow[] {
  const currentThreads = new Map(
    batch.threads.map((thread) => [thread.id, thread]),
  );
  const rows: RenderedThreadRow[] = [];
  for (const [regionIndex, region] of regions.entries()) {
    if (regionIndex > 0) rows.push({ text: "" });
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
    for (const original of region.threads) {
      const thread = currentThreads.get(original.id) ?? original;
      const anchorIndex = region.change.content.lines.findIndex((line) =>
        thread.comment.side === "new"
          ? line.newLine === thread.comment.line && line.type === "added"
          : line.oldLine === thread.comment.line && line.type === "removed",
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
          ...renderThread(thread, thread.id === selectedId, theme, width),
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
  selected: boolean,
  theme: ThreadUiTheme,
  width: number,
): readonly RenderedThreadRow[] {
  const cardWidth = widthAfterMargin(width, DIFF_GUTTER_WIDTH);
  const contentWidth = Math.min(cardWidth, THREAD_CARD_MAX_WIDTH);
  const status = thread.resolved ? "resolved" : "open";
  const selectionMarker = selected ? "▌" : " ";
  const reviewerRows = [
    ...wrapStyled(
      theme.fg(
        "accent",
        theme.bold(`${selectionMarker} [${thread.id} • ${status} • You]`),
      ),
      contentWidth,
    ),
    ...wrapWithPrefix(
      "  ",
      theme.fg("text", safeText(thread.comment.body)),
      contentWidth,
    ),
  ];
  const response = thread.response?.body ?? "Awaiting structured response.";
  const agentRows = [
    ...wrapStyled(theme.fg("muted", "  [Agent response]"), contentWidth),
    ...wrapWithPrefix(
      "  ",
      theme.fg(
        thread.response === undefined ? "warning" : "text",
        safeText(response),
      ),
      contentWidth,
    ),
  ];
  return [
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
    { text: "" },
  ];
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

import { truncateToWidth } from "@earendil-works/pi-tui";
import type {
  ReviewCommentId,
  ReviewCommentThread,
  ReviewSubmissionMode,
  ReviewThreadBatch,
} from "../review/types.ts";
import { DIFF_GUTTER_WIDTH, renderDiffLine } from "../ui/diff-line.ts";
import {
  clampedMargin,
  countNoun,
  fitColumns,
  fitLine,
  renderBackgroundBlock,
  selectHeaderGroups,
  widthAfterMargin,
} from "../ui/layout.ts";
import { displayBareChangePath } from "../ui/paths.ts";
import { safeText, wrapStyled, wrapWithPrefix } from "../ui/text.ts";
import {
  type RenderedThreadRow,
  ReviewThreadUiError,
  type ThreadRegion,
  type ThreadUiTheme,
} from "./types.ts";

export function renderThreadRows(
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
        theme.fg("accent", theme.bold(displayBareChangePath(region.change))),
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
        ...renderDiffLine(line, {}, theme, width).map((text) => ({ text })),
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
export function renderReplyContext(
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
      theme.fg("accent", theme.bold(displayBareChangePath(region.change))),
      width,
    ),
    ...renderDiffLine(anchorLine, {}, theme, width),
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

interface ThreadHeadlineOptions {
  readonly marker?: string;
  readonly id: ReviewCommentId;
  readonly resolved?: boolean;
  readonly turnLabel?: string;
}

export function renderThreadHeadline(
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

export function renderMode(
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

export function editorViewport(
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

export function renderScreenHeader(
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

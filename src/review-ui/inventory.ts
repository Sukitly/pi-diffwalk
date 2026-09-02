import { truncateToWidth } from "@earendil-works/pi-tui";
import { safeText, wrapWithPrefix } from "../ui/text.ts";
import type { InventoryEntry, RenderedRow, ReviewUiTheme } from "./types.ts";

export function renderInventoryRows(
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

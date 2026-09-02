import { safeText, wrapWithPrefix } from "../ui/text.ts";
import type { ReviewUiTheme } from "./types.ts";

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

export function renderHelpLines(theme: ReviewUiTheme, width: number): string[] {
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

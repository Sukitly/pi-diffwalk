import type { Theme } from "@earendil-works/pi-coding-agent";
import type { EditorTheme } from "@earendil-works/pi-tui";

/** The subset of the pi theme every DiffWalk screen needs. */
export type UiTheme = Pick<Theme, "fg" | "bg" | "bold">;

export type ThemeColor = Parameters<UiTheme["fg"]>[0];
export type ThemeBackground = Parameters<UiTheme["bg"]>[0];

export function createEditorTheme(theme: UiTheme): EditorTheme {
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

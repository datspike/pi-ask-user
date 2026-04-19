import type { Theme } from "@mariozechner/pi-coding-agent";
import {
  type Component,
  decodeKittyPrintable,
  type EditorTheme,
  Key,
  type Keybinding,
  type KeybindingsManager,
  Markdown,
  type MarkdownTheme,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { renderSingleSelectRows, type QuestionOption } from "./single-select-layout";
import { getOptionalMarkdownTheme } from "./pi-compat";

export const BOX_BORDER_LEFT = "│ ";
export const BOX_BORDER_RIGHT = " │";
export const BOX_BORDER_OVERHEAD = BOX_BORDER_LEFT.length + BOX_BORDER_RIGHT.length;
export const ASK_OVERLAY_MAX_HEIGHT_RATIO = 0.85;
export const SINGLE_SELECT_SPLIT_PANE_MIN_WIDTH = 84;
export const SINGLE_SELECT_SPLIT_PANE_LEFT_MIN_WIDTH = 32;
export const SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH = 28;
export const SINGLE_SELECT_SPLIT_PANE_SEPARATOR = " │ ";
export const COMMENT_TOGGLE_LABEL = "Add extra context after selection";
export const FREEFORM_SENTINEL = "\u270f\ufe0f Type custom response...";
export const BATCH_NEXT_KEY = Key.ctrl("n");
export const BATCH_PREVIOUS_KEY = Key.ctrl("p");
export const BATCH_SUBMIT_KEY = Key.ctrl("s");
export const BATCH_NEXT_ARROW_KEYS = [
  (Key as Record<string, string | undefined>).right,
  "right",
  "arrowright",
].filter((key): key is string => typeof key === "string" && key.length > 0);
export const BATCH_PREVIOUS_ARROW_KEYS = [
  (Key as Record<string, string | undefined>).left,
  "left",
  "arrowleft",
].filter((key): key is string => typeof key === "string" && key.length > 0);

export function createSelectListTheme(theme: Theme) {
  return {
    selectedPrefix: (t: string) => theme.fg("accent", t),
    selectedText: (t: string) => theme.fg("accent", t),
    description: (t: string) => theme.fg("muted", t),
    scrollInfo: (t: string) => theme.fg("dim", t),
    noMatch: (t: string) => theme.fg("warning", t),
  };
}

export function createEditorTheme(theme: Theme): EditorTheme {
  return {
    borderColor: (s: string) => theme.fg("accent", s),
    selectList: createSelectListTheme(theme),
  };
}

export class BoxBorderTop implements Component {
  private color: (s: string) => string;
  private title?: string;
  private titleColor?: (s: string) => string;

  constructor(color: (s: string) => string, title?: string, titleColor?: (s: string) => string) {
    this.color = color;
    this.title = title;
    this.titleColor = titleColor;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const inner = Math.max(0, width - 2);
    if (!this.title || inner < this.title.length + 4) {
      return [this.color(`╭${"─".repeat(inner)}╮`)];
    }

    const label = ` ${this.title} `;
    const remaining = inner - 1 - label.length;
    const titleStyle = this.titleColor ?? this.color;
    return [this.color("╭─") + titleStyle(label) + this.color("─".repeat(Math.max(0, remaining)) + "╮")];
  }
}

export class BoxBorderBottom implements Component {
  private color: (s: string) => string;
  private label?: string;
  private labelColor?: (s: string) => string;

  constructor(color: (s: string) => string, label?: string, labelColor?: (s: string) => string) {
    this.color = color;
    this.label = label;
    this.labelColor = labelColor;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const inner = Math.max(0, width - 2);
    if (!this.label || inner < this.label.length + 4) {
      return [this.color(`╰${"─".repeat(inner)}╯`)];
    }

    const tag = ` ${this.label} `;
    const leftDashes = inner - tag.length - 1;
    const style = this.labelColor ?? this.color;
    return [this.color("╰" + "─".repeat(Math.max(0, leftDashes))) + style(tag) + this.color("─╯")];
  }
}

export function formatKeyList(keys: string[]): string {
  return keys.join("/");
}

export function keybindingHint(
  theme: Theme,
  keybindings: KeybindingsManager,
  keybinding: Keybinding,
  description: string,
): string {
  return `${theme.fg("dim", formatKeyList(keybindings.getKeys(keybinding)))}${theme.fg("muted", ` ${description}`)}`;
}

export function literalHint(theme: Theme, key: string, description: string): string {
  return `${theme.fg("dim", key)}${theme.fg("muted", ` ${description}`)}`;
}

export function isCommentToggleKey(data: string): boolean {
  return matchesKey(data, Key.ctrl("g"));
}

export function matchesAnyKey(data: string, keys: string[]): boolean {
  return keys.some((key) => matchesKey(data, key));
}

function isPrintableTextInputCharacter(character: string): boolean {
  const characters = [...character];
  if (characters.length !== 1) {
    return false;
  }

  const [value] = characters;
  if (!value) {
    return false;
  }

  const code = value.charCodeAt(0);
  return code >= 32 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f);
}

export class MultiSelectList implements Component {
  private options: QuestionOption[];
  private allowFreeform: boolean;
  private allowComment: boolean;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private selectedIndex = 0;
  private checked = new Set<number>();
  private commentEnabled = false;
  private cachedWidth?: number;
  private cachedLines?: string[];

  public onCancel?: () => void;
  public onSubmit?: (result: string[]) => void;
  public onEnterFreeform?: (draft?: string) => void;

  constructor(
    options: QuestionOption[],
    allowFreeform: boolean,
    allowComment: boolean,
    theme: Theme,
    keybindings: KeybindingsManager,
  ) {
    this.options = options;
    this.allowFreeform = allowFreeform;
    this.allowComment = allowComment;
    this.theme = theme;
    this.keybindings = keybindings;
  }

  public isCommentEnabled(): boolean {
    return this.commentEnabled;
  }

  public setSelections(selections: string[]): void {
    this.checked.clear();
    const wanted = new Set(selections.map((selection) => selection.trim()).filter(Boolean));
    this.options.forEach((option, index) => {
      if (wanted.has(option.title)) {
        this.checked.add(index);
      }
    });
    this.invalidate();
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  private getItemCount(): number {
    return this.options.length + (this.allowComment ? 1 : 0) + (this.allowFreeform ? 1 : 0);
  }

  private getCommentToggleIndex(): number | null {
    return this.allowComment ? this.options.length : null;
  }

  private getFreeformIndex(): number {
    return this.options.length + (this.allowComment ? 1 : 0);
  }

  private isCommentToggleRow(index: number): boolean {
    const toggleIndex = this.getCommentToggleIndex();
    return toggleIndex !== null && index === toggleIndex;
  }

  private isFreeformRow(index: number): boolean {
    return this.allowFreeform && index === this.getFreeformIndex();
  }

  private toggle(index: number): void {
    if (index < 0 || index >= this.options.length) return;
    if (this.checked.has(index)) this.checked.delete(index);
    else this.checked.add(index);
  }

  private toggleComment(): void {
    if (!this.allowComment) return;
    this.commentEnabled = !this.commentEnabled;
    this.invalidate();
  }

  private getPrintableInput(data: string): string | null {
    const kittyPrintable = decodeKittyPrintable(data);
    if (kittyPrintable !== undefined) {
      return isPrintableTextInputCharacter(kittyPrintable) ? kittyPrintable : null;
    }

    return isPrintableTextInputCharacter(data) ? data : null;
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.onCancel?.();
      return;
    }

    const count = this.getItemCount();
    if (count === 0) {
      this.onCancel?.();
      return;
    }

    if (this.allowComment && isCommentToggleKey(data)) {
      this.toggleComment();
      return;
    }

    if (this.keybindings.matches(data, "tui.select.up") || matchesKey(data, Key.shift("tab"))) {
      this.selectedIndex = this.selectedIndex === 0 ? count - 1 : this.selectedIndex - 1;
      this.invalidate();
      return;
    }

    if (this.keybindings.matches(data, "tui.select.down") || matchesKey(data, Key.tab)) {
      this.selectedIndex = this.selectedIndex === count - 1 ? 0 : this.selectedIndex + 1;
      this.invalidate();
      return;
    }

    const printableInput = this.getPrintableInput(data);
    if (printableInput && this.isFreeformRow(this.selectedIndex)) {
      this.onEnterFreeform?.(printableInput);
      return;
    }

    const numMatch = data.match(/^[1-9]$/);
    if (numMatch) {
      const idx = Number.parseInt(numMatch[0], 10) - 1;
      if (idx >= 0 && idx < this.options.length) {
        this.toggle(idx);
        this.selectedIndex = Math.min(idx, count - 1);
        this.invalidate();
      }
      return;
    }

    if (matchesKey(data, Key.space)) {
      if (this.isCommentToggleRow(this.selectedIndex)) {
        this.toggleComment();
        return;
      }
      if (this.isFreeformRow(this.selectedIndex)) {
        this.onEnterFreeform?.();
        return;
      }
      this.toggle(this.selectedIndex);
      this.invalidate();
      return;
    }

    if (this.keybindings.matches(data, "tui.select.confirm")) {
      if (this.isCommentToggleRow(this.selectedIndex)) {
        this.toggleComment();
        return;
      }
      if (this.isFreeformRow(this.selectedIndex)) {
        this.onEnterFreeform?.();
        return;
      }

      const selectedTitles = Array.from(this.checked)
        .sort((a, b) => a - b)
        .map((i) => this.options[i]?.title)
        .filter((t): t is string => !!t);

      const fallback = this.options[this.selectedIndex]?.title;
      const result = selectedTitles.length > 0 ? selectedTitles : fallback ? [fallback] : [];

      if (result.length > 0) this.onSubmit?.(result);
      else this.onCancel?.();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const theme = this.theme;
    const count = this.getItemCount();
    const maxVisible = Math.min(count, 10);

    if (count === 0) {
      this.cachedLines = [theme.fg("warning", "No options")];
      this.cachedWidth = width;
      return this.cachedLines;
    }

    const startIndex = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), count - maxVisible));
    const endIndex = Math.min(startIndex + maxVisible, count);

    const lines: string[] = [];

    for (let i = startIndex; i < endIndex; i++) {
      const isSelected = i === this.selectedIndex;
      const prefix = isSelected ? theme.fg("accent", "→") : " ";

      if (this.isCommentToggleRow(i)) {
        const checkbox = this.commentEnabled ? theme.fg("success", "[✓]") : theme.fg("dim", "[ ]");
        const label = isSelected
          ? theme.fg("accent", theme.bold(COMMENT_TOGGLE_LABEL))
          : theme.fg("text", theme.bold(COMMENT_TOGGLE_LABEL));
        lines.push(truncateToWidth(`${prefix}   ${checkbox} ${label}`, width, ""));
        continue;
      }

      if (this.isFreeformRow(i)) {
        const label = theme.fg("text", theme.bold("Type something."));
        const desc = theme.fg("muted", "Enter a custom response");
        const line = `${prefix}   ${label} ${theme.fg("dim", "—")} ${desc}`;
        lines.push(truncateToWidth(line, width, ""));
        continue;
      }

      const option = this.options[i];
      if (!option) continue;

      const checkbox = this.checked.has(i) ? theme.fg("success", "[✓]") : theme.fg("dim", "[ ]");
      const num = theme.fg("dim", `${i + 1}.`);
      const title = isSelected
        ? theme.fg("accent", theme.bold(option.title))
        : theme.fg("text", theme.bold(option.title));

      const firstLine = `${prefix} ${num} ${checkbox} ${title}`;
      lines.push(truncateToWidth(firstLine, width, ""));

      if (option.description) {
        const indent = "      ";
        const wrapWidth = Math.max(10, width - indent.length);
        const wrapped = wrapTextWithAnsi(option.description, wrapWidth);
        for (const w of wrapped) {
          lines.push(truncateToWidth(indent + theme.fg("muted", w), width, ""));
        }
      }
    }

    if (startIndex > 0 || endIndex < count) {
      lines.push(theme.fg("dim", truncateToWidth(`  (${this.selectedIndex + 1}/${count})`, width, "")));
    }

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
}

export class WrappedSingleSelectList implements Component {
  private options: QuestionOption[];
  private allowFreeform: boolean;
  private allowComment: boolean;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private selectedIndex = 0;
  private commentEnabled = false;
  private maxVisibleRows = 12;
  private cachedWidth?: number;
  private cachedLines?: string[];

  public onCancel?: () => void;
  public onSubmit?: (result: string) => void;
  public onEnterFreeform?: (draft?: string) => void;

  constructor(
    options: QuestionOption[],
    allowFreeform: boolean,
    allowComment: boolean,
    theme: Theme,
    keybindings: KeybindingsManager,
  ) {
    this.options = options;
    this.allowFreeform = allowFreeform;
    this.allowComment = allowComment;
    this.theme = theme;
    this.keybindings = keybindings;
  }

  public isCommentEnabled(): boolean {
    return this.commentEnabled;
  }

  public setSelectedTitle(title: string | undefined): void {
    if (!title) return;
    const index = this.options.findIndex((option) => option.title === title);
    if (index >= 0) {
      this.selectedIndex = index;
      this.invalidate();
    }
  }

  setMaxVisibleRows(rows: number): void {
    const next = Math.max(1, Math.floor(rows));
    if (next !== this.maxVisibleRows) {
      this.maxVisibleRows = next;
      this.invalidate();
    }
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  private getItemCount(): number {
    return this.options.length + (this.allowComment ? 1 : 0) + (this.allowFreeform ? 1 : 0);
  }

  private isCommentToggleRow(index: number): boolean {
    return this.allowComment && index === this.options.length;
  }

  private isFreeformRow(index: number): boolean {
    return this.allowFreeform && index === this.options.length + (this.allowComment ? 1 : 0);
  }

  private toggleComment(): void {
    if (!this.allowComment) return;
    this.commentEnabled = !this.commentEnabled;
    this.invalidate();
  }

  private getPrintableInput(data: string): string | null {
    const kittyPrintable = decodeKittyPrintable(data);
    if (kittyPrintable !== undefined) {
      return isPrintableTextInputCharacter(kittyPrintable) ? kittyPrintable : null;
    }

    return isPrintableTextInputCharacter(data) ? data : null;
  }

  private styleListLine(line: string, width: number, isSelected: boolean): string {
    const trimmed = line.trim();

    if (trimmed.startsWith("(")) {
      return truncateToWidth(this.theme.fg("dim", line), width, "");
    }

    if (isSelected) {
      return truncateToWidth(this.theme.fg("accent", this.theme.bold(line)), width, "");
    }

    if (line.startsWith("      ")) {
      return truncateToWidth(this.theme.fg("muted", line), width, "");
    }

    if (line.startsWith("→")) {
      return truncateToWidth(this.theme.fg("accent", this.theme.bold(line)), width, "");
    }

    return truncateToWidth(this.theme.fg("text", line), width, "");
  }

  private getSplitPaneWidths(width: number): { left: number; right: number } | null {
    if (width < SINGLE_SELECT_SPLIT_PANE_MIN_WIDTH) return null;

    const availableWidth = width - SINGLE_SELECT_SPLIT_PANE_SEPARATOR.length;
    if (availableWidth < SINGLE_SELECT_SPLIT_PANE_LEFT_MIN_WIDTH + SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH) {
      return null;
    }

    const preferredLeftWidth = Math.floor(availableWidth * 0.42);
    const left = Math.max(
      SINGLE_SELECT_SPLIT_PANE_LEFT_MIN_WIDTH,
      Math.min(preferredLeftWidth, availableWidth - SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH),
    );
    const right = availableWidth - left;

    if (right < SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH) return null;
    return { left, right };
  }

  private buildListLines(width: number, hideDescriptions = false): string[] {
    const count = this.getItemCount();
    if (count === 0) {
      return [truncateToWidth(this.theme.fg("warning", "No options"), width, "")];
    }

    const optionRows = renderSingleSelectRows({
      options: this.options,
      selectedIndex: this.selectedIndex,
      width,
      allowFreeform: this.allowFreeform,
      allowComment: this.allowComment,
      commentEnabled: this.commentEnabled,
      maxRows: this.maxVisibleRows,
      hideDescriptions,
    });
    return optionRows.map((row) => this.styleListLine(row.line, width, row.selected)).slice(0, this.maxVisibleRows);
  }

  private buildPreviewLines(width: number, maxLines: number): string[] {
    if (maxLines <= 0) return [];

    const mdTheme: MarkdownTheme | undefined = getOptionalMarkdownTheme();

    let md = "";

    if (this.isCommentToggleRow(this.selectedIndex)) {
      md += "## Additional context\n\n";
      md += `Currently: **${this.commentEnabled ? "Enabled" : "Disabled"}**\n\n`;
      md += "Turn this on when the selected option needs extra explanation before the tool submits.\n";
    } else if (this.isFreeformRow(this.selectedIndex)) {
      md += "## Custom response\n\n";
      md += "Open the editor to write **any** answer.\n\n";
      md += "*Use this when none of the listed options fit, or just start typing to answer directly.*\n";
    } else {
      const selected = this.options[this.selectedIndex];
      if (!selected) {
        md += "*No option selected*\n";
      } else {
        md += `## ${selected.title}\n\n`;
        if (selected.description?.trim()) {
          md += `${selected.description}\n`;
        } else {
          md += "*No additional details provided for this option.*\n";
        }
        md += "\n---\n\nPress `Enter` to select this option.\n";
        if (this.allowFreeform) {
          md += "Type to start a custom response instead.\n";
        }
      }
    }

    let lines: string[];
    if (mdTheme) {
      const mdComponent = new Markdown(md.trim(), 0, 0, mdTheme);
      lines = mdComponent.render(width);
    } else {
      lines = [];
      for (const line of wrapTextWithAnsi(md.trim(), Math.max(10, width))) {
        lines.push(truncateToWidth(line, width, ""));
      }
    }

    while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") {
      lines.pop();
    }

    if (lines.length <= maxLines) return lines;
    if (maxLines === 1) return [truncateToWidth(this.theme.fg("dim", "…"), width, "")];

    const visibleLines = lines.slice(0, maxLines - 1);
    visibleLines.push(truncateToWidth(this.theme.fg("dim", "…"), width, ""));
    return visibleLines;
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.onCancel?.();
      return;
    }

    if (this.allowComment && isCommentToggleKey(data)) {
      this.toggleComment();
      return;
    }

    const count = this.getItemCount();

    if ((this.keybindings.matches(data, "tui.select.up") || matchesKey(data, Key.shift("tab"))) && count > 0) {
      this.selectedIndex = this.selectedIndex === 0 ? count - 1 : this.selectedIndex - 1;
      this.invalidate();
      return;
    }

    if ((this.keybindings.matches(data, "tui.select.down") || matchesKey(data, Key.tab)) && count > 0) {
      this.selectedIndex = this.selectedIndex === count - 1 ? 0 : this.selectedIndex + 1;
      this.invalidate();
      return;
    }

    const printableInput = this.getPrintableInput(data);
    if (printableInput && this.isFreeformRow(this.selectedIndex)) {
      this.onEnterFreeform?.(printableInput);
      return;
    }

    const numMatch = data.match(/^[1-9]$/);
    if (numMatch && this.options.length > 0) {
      const idx = Number.parseInt(numMatch[0], 10) - 1;
      if (idx >= 0 && idx < this.options.length) {
        this.selectedIndex = idx;
        this.invalidate();
        return;
      }
    }

    if (matchesKey(data, Key.space) && count > 0 && this.isCommentToggleRow(this.selectedIndex)) {
      this.toggleComment();
      return;
    }

    if (this.keybindings.matches(data, "tui.select.confirm") && count > 0) {
      if (this.isCommentToggleRow(this.selectedIndex)) {
        this.toggleComment();
        return;
      }
      if (this.isFreeformRow(this.selectedIndex)) {
        this.onEnterFreeform?.();
        return;
      }

      const result = this.options[this.selectedIndex]?.title;
      if (result) this.onSubmit?.(result);
      else this.onCancel?.();
      return;
    }

    if (printableInput && this.allowFreeform) {
      this.onEnterFreeform?.(printableInput);
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const count = this.getItemCount();
    this.selectedIndex = count > 0 ? Math.max(0, Math.min(this.selectedIndex, count - 1)) : 0;

    const splitPane = this.getSplitPaneWidths(width);
    let lines: string[];

    if (!splitPane) {
      lines = this.buildListLines(width);
    } else {
      const listLines = this.buildListLines(splitPane.left, true);
      const previewLines = this.buildPreviewLines(splitPane.right, this.maxVisibleRows);
      const rowCount = Math.min(this.maxVisibleRows, Math.max(listLines.length, previewLines.length));
      const separator = this.theme.fg("dim", SINGLE_SELECT_SPLIT_PANE_SEPARATOR);
      lines = Array.from({ length: rowCount }, (_, index) => {
        const left = truncateToWidth(listLines[index] ?? "", splitPane.left, "", true);
        const right = truncateToWidth(previewLines[index] ?? "", splitPane.right, "");
        return `${left}${separator}${right}`;
      });
    }

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
}

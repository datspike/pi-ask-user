/**
 * Ask Tool Extension - Interactive question UI for pi-coding-agent
 *
 * Refactored to use built-in TUI primitives (Container/Text/Spacer/SelectList/Editor)
 * and a custom box border instead of manual ANSI box drawing.
 */

import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
   Container,
   type Component,
   decodeKittyPrintable,
   Editor,
   type EditorTheme,
   Key,
   type Keybinding,
   type KeybindingsManager,
   Markdown,
   type MarkdownTheme,
   matchesKey,
   Spacer,
   Text,
   type TUI,
   truncateToWidth,
   wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { renderSingleSelectRows } from "./single-select-layout";

import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
const ASK_USER_VERSION: string = (_require("./package.json") as { version: string }).version;

type AskOptionInput = QuestionOption | string;

interface SingleAskParams {
   mode?: "single";
   question: string;
   context?: string;
   options?: AskOptionInput[];
   allowMultiple?: boolean;
   allowFreeform?: boolean;
   allowComment?: boolean;
   timeout?: number;
}

interface BatchQuestionInput {
   id: string;
   question: string;
   options?: AskOptionInput[];
   allowMultiple?: boolean;
   allowFreeform?: boolean;
   required?: boolean;
}

interface BatchAskParams {
   mode: "batch";
   title?: string;
   context?: string;
   questions: BatchQuestionInput[];
   timeout?: number;
}

type AskParams = SingleAskParams | BatchAskParams;

type SingleAskResponse =
   | {
      kind: "selection";
      selections: string[];
      comment?: string;
   }
   | {
      kind: "freeform";
      text: string;
   };

type BatchAnswer =
   | {
      id: string;
      kind: "selection";
      selections: string[];
   }
   | {
      id: string;
      kind: "freeform";
      text: string;
   }
   | {
      id: string;
      kind: "skipped";
   };

type AskResponse =
   | SingleAskResponse
   | {
      kind: "batch";
      answers: BatchAnswer[];
   };

interface BatchQuestion {
   id: string;
   question: string;
   options: QuestionOption[];
   allowMultiple: boolean;
   allowFreeform: boolean;
   required: boolean;
}

interface AskToolDetails {
   mode: "single" | "batch";
   question?: string;
   title?: string;
   context?: string;
   options?: QuestionOption[];
   questions?: BatchQuestion[];
   response: AskResponse | null;
   cancelled: boolean;
}

type AskUIResult = AskResponse;

function normalizeOptions(options: AskOptionInput[]): QuestionOption[] {
   return options
      .map((option) => {
         if (typeof option === "string") {
            return { title: option };
         }
         if (option && typeof option === "object" && typeof option.title === "string") {
            return { title: option.title, description: option.description };
         }
         return null;
      })
      .filter((option): option is QuestionOption => option !== null);
}

function formatOptionsForMessage(options: QuestionOption[]): string {
   return options
      .map((option, index) => {
         const desc = option.description ? ` — ${option.description}` : "";
         return `${index + 1}. ${option.title}${desc}`;
      })
      .join("\n");
}

function normalizeOptionalComment(text: string | null | undefined): string | undefined {
   const trimmed = text?.trim();
   return trimmed ? trimmed : undefined;
}

function isBatchParams(params: AskParams): params is BatchAskParams {
   return (params as BatchAskParams).mode === "batch";
}

function createFreeformResponse(text: string | null | undefined): SingleAskResponse | null {
   const trimmed = text?.trim();
   return trimmed ? { kind: "freeform", text: trimmed } : null;
}

function createSelectionResponse(selections: string[], comment?: string | null): SingleAskResponse | null {
   const normalizedSelections = selections.map((selection) => selection.trim()).filter(Boolean);
   if (normalizedSelections.length === 0) return null;

   const normalizedComment = normalizeOptionalComment(comment);
   return normalizedComment
      ? { kind: "selection", selections: normalizedSelections, comment: normalizedComment }
      : { kind: "selection", selections: normalizedSelections };
}

function createSkippedBatchAnswer(id: string): BatchAnswer {
   return { id, kind: "skipped" };
}

function createBatchAnswer(id: string, response: SingleAskResponse | null): BatchAnswer {
   if (!response) return createSkippedBatchAnswer(id);
   if (response.kind === "freeform") {
      return { id, kind: "freeform", text: response.text };
   }
   return { id, kind: "selection", selections: response.selections };
}

function formatSingleResponseSummary(response: SingleAskResponse): string {
   if (response.kind === "freeform") return response.text;

   const selections = response.selections.join(", ");
   return response.comment ? `${selections} — ${response.comment}` : selections;
}

function formatBatchAnswerSummary(answer: BatchAnswer): string {
   if (answer.kind === "skipped") return "Skipped";
   if (answer.kind === "freeform") return answer.text;
   return answer.selections.join(", ");
}

function formatSuccessfulResponseContent(
   response: AskResponse,
   details?: { title?: string; questions?: BatchQuestion[] },
): string {
   if (response.kind !== "batch") {
      return `User answered: ${formatSingleResponseSummary(response)}`;
   }

   const header = details?.title?.trim()
      ? `User answered the clarification batch (${details.title.trim()}):`
      : "User answered the clarification batch:";
   const lines = response.answers.map((answer, index) => {
      const questionLabel = details?.questions?.[index]?.question ?? answer.id;
      return `- ${questionLabel}: ${formatBatchAnswerSummary(answer)}`;
   });
   return [header, ...lines].join("\n");
}

function formatResponseSummary(response: AskResponse): string {
   if (response.kind === "batch") {
      return `${response.answers.length} answer(s)`;
   }
   return formatSingleResponseSummary(response);
}

function normalizeBatchQuestions(rawQuestions: BatchQuestionInput[]): BatchQuestion[] {
   if (!Array.isArray(rawQuestions) || rawQuestions.length < 2 || rawQuestions.length > 7) {
      throw new Error("Batch mode requires between 2 and 7 questions.");
   }

   const seenIds = new Set<string>();
   return rawQuestions.map((question, index) => {
      const id = question?.id?.trim();
      const prompt = question?.question?.trim();
      if (!id) {
         throw new Error(`Batch question ${index + 1} is missing a valid id.`);
      }
      if (seenIds.has(id)) {
         throw new Error(`Batch question ids must be unique. Duplicate id: ${id}`);
      }
      seenIds.add(id);
      if (!prompt) {
         throw new Error(`Batch question ${index + 1} is missing a valid question.`);
      }

      return {
         id,
         question: prompt,
         options: normalizeOptions(question.options ?? []),
         allowMultiple: Boolean(question.allowMultiple),
         allowFreeform: question.allowFreeform ?? true,
         required: question.required ?? true,
      };
   });
}

function buildCommentPrompt(prompt: string, selections: string[]): string {
   const label = selections.length === 1 ? "Selected option" : "Selected options";
   const lines = selections.map((selection) => `- ${selection}`).join("\n");
   return `${prompt}\n\n${label}:\n${lines}`;
}

function parseDialogSelections(input: string): string[] {
   return input
      .split(",")
      .map((selection) => selection.trim())
      .filter(Boolean);
}

function isCancelledInput(value: unknown): value is null | undefined {
   return value === null || value === undefined;
}

function isSelectionResponse(response: AskResponse): response is Extract<AskResponse, { kind: "selection" }> {
   return response.kind === "selection";
}

function createSelectListTheme(theme: Theme) {
   return {
      selectedPrefix: (t: string) => theme.fg("accent", t),
      selectedText: (t: string) => theme.fg("accent", t),
      description: (t: string) => theme.fg("muted", t),
      scrollInfo: (t: string) => theme.fg("dim", t),
      noMatch: (t: string) => theme.fg("warning", t),
   };
}

function createEditorTheme(theme: Theme): EditorTheme {
   return {
      borderColor: (s: string) => theme.fg("accent", s),
      selectList: createSelectListTheme(theme),
   };
}

const BOX_BORDER_LEFT = "│ ";
const BOX_BORDER_RIGHT = " │";
const BOX_BORDER_OVERHEAD = BOX_BORDER_LEFT.length + BOX_BORDER_RIGHT.length;

class BoxBorderTop implements Component {
   private color: (s: string) => string;
   private title?: string;
   private titleColor?: (s: string) => string;
   constructor(color: (s: string) => string, title?: string, titleColor?: (s: string) => string) {
      this.color = color;
      this.title = title;
      this.titleColor = titleColor;
   }
   invalidate(): void { }
   render(width: number): string[] {
      const inner = Math.max(0, width - 2);
      if (!this.title || inner < this.title.length + 4) {
         return [this.color(`╭${"─".repeat(inner)}╮`)];
      }
      const label = ` ${this.title} `;
      const remaining = inner - 1 - label.length;
      const titleStyle = this.titleColor ?? this.color;
      return [
         this.color("╭─") + titleStyle(label) + this.color("─".repeat(Math.max(0, remaining)) + "╮"),
      ];
   }
}

class BoxBorderBottom implements Component {
   private color: (s: string) => string;
   private label?: string;
   private labelColor?: (s: string) => string;
   constructor(color: (s: string) => string, label?: string, labelColor?: (s: string) => string) {
      this.color = color;
      this.label = label;
      this.labelColor = labelColor;
   }
   invalidate(): void { }
   render(width: number): string[] {
      const inner = Math.max(0, width - 2);
      if (!this.label || inner < this.label.length + 4) {
         return [this.color(`╰${"─".repeat(inner)}╯`)];
      }
      const tag = ` ${this.label} `;
      const leftDashes = inner - tag.length - 1;
      const style = this.labelColor ?? this.color;
      return [
         this.color("╰" + "─".repeat(Math.max(0, leftDashes))) + style(tag) + this.color("─╯"),
      ];
   }
}

function formatKeyList(keys: string[]): string {
   return keys.join("/");
}

function keybindingHint(
   theme: Theme,
   keybindings: KeybindingsManager,
   keybinding: Keybinding,
   description: string,
): string {
   return `${theme.fg("dim", formatKeyList(keybindings.getKeys(keybinding)))}${theme.fg("muted", ` ${description}`)}`;
}

function literalHint(theme: Theme, key: string, description: string): string {
   return `${theme.fg("dim", key)}${theme.fg("muted", ` ${description}`)}`;
}

function isCommentToggleKey(data: string): boolean {
   return matchesKey(data, Key.ctrl("g"));
}

type AskMode = "select" | "freeform" | "comment";

const ASK_OVERLAY_MAX_HEIGHT_RATIO = 0.85;
const ASK_OVERLAY_WIDTH = "92%";
const ASK_OVERLAY_MIN_WIDTH = 40;
const SINGLE_SELECT_SPLIT_PANE_MIN_WIDTH = 84;
const SINGLE_SELECT_SPLIT_PANE_LEFT_MIN_WIDTH = 32;
const SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH = 28;
const SINGLE_SELECT_SPLIT_PANE_SEPARATOR = " │ ";
const FREEFORM_SENTINEL = "\u270f\ufe0f Type custom response...";
const COMMENT_TOGGLE_LABEL = "Add extra context after selection";

class MultiSelectList implements Component {
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
      if (kittyPrintable !== undefined) return kittyPrintable;

      const characters = [...data];
      if (characters.length !== 1) return null;

      const [character] = characters;
      if (!character) return null;

      const code = character.charCodeAt(0);
      if (code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
         return null;
      }

      return character;
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

class WrappedSingleSelectList implements Component {
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
      if (kittyPrintable !== undefined) return kittyPrintable;

      const characters = [...data];
      if (characters.length !== 1) return null;

      const [character] = characters;
      if (!character) return null;

      const code = character.charCodeAt(0);
      if (code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
         return null;
      }

      return character;
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

      let mdTheme: MarkdownTheme | undefined;
      try {
         mdTheme = getMarkdownTheme();
      } catch { }

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

/**
 * Interactive ask UI. Uses a root Container for layout and swaps the center
 * component between SelectList/MultiSelectList and an Editor (freeform mode).
 */
class AskComponent extends Container {
   private question: string;
   private context?: string;
   private options: QuestionOption[];
   private allowMultiple: boolean;
   private allowFreeform: boolean;
   private allowComment: boolean;
   private tui: TUI;
   private theme: Theme;
   private keybindings: KeybindingsManager;
   private onDone: (result: AskUIResult | null) => void;

   private mode: AskMode = "select";
   private pendingSelections: string[] = [];
   private freeformDraft = "";
   private commentDraft = "";

   // Static layout components
   private titleText: Text;
   private questionText: Text;
   private contextComponent?: Component;
   private modeContainer: Container;
   private helpText: Text;

   // Mode components
   private singleSelectList?: WrappedSingleSelectList;
   private multiSelectList?: MultiSelectList;
   private editor?: Editor;

   // Focusable - propagate to Editor for IME cursor positioning
   private _focused = false;
   get focused(): boolean {
      return this._focused;
   }
   set focused(value: boolean) {
      this._focused = value;
      if (this.editor && (this.mode === "freeform" || this.mode === "comment")) {
         (this.editor as any).focused = value;
      }
   }

   constructor(
      question: string,
      context: string | undefined,
      options: QuestionOption[],
      allowMultiple: boolean,
      allowFreeform: boolean,
      allowComment: boolean,
      tui: TUI,
      theme: Theme,
      keybindings: KeybindingsManager,
      onDone: (result: AskUIResult | null) => void,
   ) {
      super();

      this.question = question;
      this.context = context;
      this.options = options;
      this.allowMultiple = allowMultiple;
      this.allowFreeform = allowFreeform;
      this.allowComment = allowComment;
      this.tui = tui;
      this.theme = theme;
      this.keybindings = keybindings;
      this.onDone = onDone;

      // Layout skeleton
      this.addChild(new BoxBorderTop(
         (s: string) => theme.fg("accent", s),
         "ask_user",
         (s: string) => theme.fg("dim", theme.bold(s)),
      ));
      this.addChild(new Spacer(1));

      this.titleText = new Text("", 1, 0);
      this.addChild(this.titleText);
      this.addChild(new Spacer(1));

      this.questionText = new Text("", 1, 0);
      this.addChild(this.questionText);

      if (this.context) {
         this.addChild(new Spacer(1));
         let mdTheme: MarkdownTheme | undefined;
         try {
            mdTheme = getMarkdownTheme();
         } catch { }
         if (mdTheme) {
            this.contextComponent = new Markdown("", 1, 0, mdTheme);
         } else {
            this.contextComponent = new Text("", 1, 0);
         }
         this.addChild(this.contextComponent);
      }

      this.addChild(new Spacer(1));

      this.modeContainer = new Container();
      this.addChild(this.modeContainer);

      this.addChild(new Spacer(1));
      this.helpText = new Text("", 1, 0);
      this.addChild(this.helpText);

      this.addChild(new Spacer(1));
      this.addChild(new BoxBorderBottom(
         (s: string) => theme.fg("accent", s),
         `v${ASK_USER_VERSION}`,
         (s: string) => theme.fg("dim", s),
      ));

      this.updateStaticText();
      this.showSelectMode();
   }

   override invalidate(): void {
      super.invalidate();
      this.updateStaticText();
      this.updateHelpText();
   }

   override render(width: number): string[] {
      const innerWidth = Math.max(1, width - BOX_BORDER_OVERHEAD);

      if (this.mode === "select" && !this.allowMultiple) {
         const overlayMaxHeight = Math.max(12, Math.floor(this.tui.terminal.rows * ASK_OVERLAY_MAX_HEIGHT_RATIO));
         const staticLines = this.countStaticLines(innerWidth);
         const availableOptionRows = Math.max(4, overlayMaxHeight - staticLines);
         this.ensureSingleSelectList().setMaxVisibleRows(availableOptionRows);
      }

      // Render children at the inner width (excluding side border characters)
      const rawLines = super.render(innerWidth);

      // First and last lines are the top/bottom box borders — pass through at full width.
      // All inner lines get wrapped with side borders.
      const borderColor = (s: string) => this.theme.fg("accent", s);
      const titleColor = (s: string) => this.theme.fg("dim", this.theme.bold(s));
      return rawLines.map((line, index) => {
         if (index === 0 || index === rawLines.length - 1) {
            // Box top/bottom borders already rendered at innerWidth — re-render at full width
            if (index === 0) return new BoxBorderTop(borderColor, "ask_user", titleColor).render(width)[0];
            return new BoxBorderBottom(borderColor, `v${ASK_USER_VERSION}`, (s: string) => this.theme.fg("dim", s)).render(width)[0];
         }
         const padded = truncateToWidth(line, innerWidth, "", true);
         return `${borderColor(BOX_BORDER_LEFT)}${padded}${borderColor(BOX_BORDER_RIGHT)}`;
      });
   }

   private countWrappedLines(text: string, width: number): number {
      return Math.max(1, wrapTextWithAnsi(text, Math.max(10, width - 2)).length);
   }

   private countStaticLines(width: number): number {
      const titleLines = 1;
      const questionLines = this.countWrappedLines(this.question, width);
      const contextLines = this.context ? 1 + this.countWrappedLines(this.context, width) : 0;
      const helpLines = 1;
      const borderLines = 2;
      const spacerLines = this.context ? 6 : 5;
      return borderLines + spacerLines + titleLines + questionLines + contextLines + helpLines;
   }

   private updateStaticText(): void {
      const theme = this.theme;
      const title = this.mode === "comment" ? "Optional comment" : "Question";
      this.titleText.setText(theme.fg("accent", theme.bold(title)));
      this.questionText.setText(theme.fg("text", theme.bold(this.question)));
      if (this.contextComponent && this.context) {
         if (this.contextComponent instanceof Markdown) {
            (this.contextComponent as Markdown).setText(
               `**Context:**\n${this.context}`,
            );
         } else {
            (this.contextComponent as Text).setText(
               `${theme.fg("accent", theme.bold("Context:"))}\n${theme.fg("dim", this.context)}`,
            );
         }
      }
   }

   private updateHelpText(): void {
      const theme = this.theme;
      if (this.mode === "freeform" || this.mode === "comment") {
         const alternateCancelKeys = this.keybindings
            .getKeys("tui.select.cancel")
            .filter((key) => key !== "escape" && key !== "esc");
         const hints = [
            keybindingHint(theme, this.keybindings, "tui.input.submit", this.mode === "comment" ? "submit/skip" : "submit"),
            keybindingHint(theme, this.keybindings, "tui.input.newLine", "newline"),
            literalHint(theme, "esc", "back"),
            alternateCancelKeys.length > 0 ? literalHint(theme, formatKeyList(alternateCancelKeys), "cancel") : null,
         ]
            .filter((hint): hint is string => !!hint)
            .join(" • ");
         this.helpText.setText(theme.fg("dim", hints));
         return;
      }

      if (this.allowMultiple) {
         const hints = [
            literalHint(theme, "↑↓", "navigate"),
            literalHint(theme, "space", "toggle"),
            this.allowComment ? literalHint(theme, "ctrl+g", "toggle context") : null,
            keybindingHint(theme, this.keybindings, "tui.select.confirm", "submit"),
            keybindingHint(theme, this.keybindings, "tui.select.cancel", "cancel"),
         ]
            .filter((hint): hint is string => !!hint)
            .join(" • ");
         this.helpText.setText(theme.fg("dim", hints));
      } else {
         const alternateCancelKeys = this.keybindings
            .getKeys("tui.select.cancel")
            .filter((key) => key !== "escape" && key !== "esc");
         const hints = [
            literalHint(theme, "↑↓", "navigate"),
            this.allowFreeform ? literalHint(theme, "type", "custom answer") : null,
            this.allowComment ? literalHint(theme, "ctrl+g", "toggle context") : null,
            keybindingHint(theme, this.keybindings, "tui.select.confirm", "select"),
            literalHint(theme, "esc", "cancel"),
            alternateCancelKeys.length > 0
               ? literalHint(theme, formatKeyList(alternateCancelKeys), "cancel")
               : null,
         ]
            .filter((hint): hint is string => !!hint)
            .join(" • ");
         this.helpText.setText(theme.fg("dim", hints));
      }
   }

   private ensureSingleSelectList(): WrappedSingleSelectList {
      if (this.singleSelectList) return this.singleSelectList;

      const list = new WrappedSingleSelectList(
         this.options,
         this.allowFreeform,
         this.allowComment,
         this.theme,
         this.keybindings,
      );
      list.onSubmit = (result) => this.handleSelectionSubmit([result], list.isCommentEnabled());
      list.onCancel = () => this.onDone(null);
      list.onEnterFreeform = (draft) => this.showFreeformMode(draft);

      this.singleSelectList = list;
      return list;
   }

   private ensureMultiSelectList(): MultiSelectList {
      if (this.multiSelectList) return this.multiSelectList;

      const list = new MultiSelectList(
         this.options,
         this.allowFreeform,
         this.allowComment,
         this.theme,
         this.keybindings,
      );
      list.onCancel = () => this.onDone(null);
      list.onSubmit = (result) => this.handleSelectionSubmit(result, list.isCommentEnabled());
      list.onEnterFreeform = (draft) => this.showFreeformMode(draft);

      this.multiSelectList = list;
      return list;
   }

   private ensureEditor(): Editor {
      if (this.editor) return this.editor;
      const editor = new Editor(this.tui, createEditorTheme(this.theme));
      editor.disableSubmit = false;
      editor.onSubmit = (text: string) => {
         this.handleEditorSubmit(text);
      };
      this.editor = editor;
      return editor;
   }

   private saveEditorDraft(): void {
      if (!this.editor) return;
      const getText = (this.editor as any).getText;
      if (typeof getText !== "function") return;

      const currentText = String(getText.call(this.editor) ?? "");
      if (this.mode === "freeform") {
         this.freeformDraft = currentText;
      } else if (this.mode === "comment") {
         this.commentDraft = currentText;
      }
   }

   private setEditorText(text: string): void {
      const editor = this.ensureEditor();
      const setText = (editor as any).setText;
      if (typeof setText === "function") {
         setText.call(editor, text);
      }
   }

   private handleSelectionSubmit(selections: string[], wantsComment: boolean): void {
      if (this.allowComment && wantsComment) {
         this.pendingSelections = selections;
         this.commentDraft = "";
         this.showCommentMode();
         return;
      }

      this.onDone(createSelectionResponse(selections));
   }

   private handleEditorSubmit(text: string): void {
      if (this.mode === "freeform") {
         this.onDone(createFreeformResponse(text));
         return;
      }

      if (this.mode === "comment") {
         this.commentDraft = text;
         this.onDone(createSelectionResponse(this.pendingSelections, text));
      }
   }

   private showSelectMode(): void {
      if (this.mode === "freeform" || this.mode === "comment") {
         this.saveEditorDraft();
      }

      this.mode = "select";
      this.pendingSelections = [];
      this.modeContainer.clear();

      if (this.allowMultiple) {
         this.modeContainer.addChild(this.ensureMultiSelectList());
      } else {
         this.modeContainer.addChild(this.ensureSingleSelectList());
      }

      this.updateHelpText();
      this.invalidate();
      this.tui.requestRender();
   }

   private showFreeformMode(initialDraft?: string): void {
      if (this.mode === "comment") {
         this.saveEditorDraft();
      }

      if (typeof initialDraft === "string") {
         this.freeformDraft = initialDraft;
      }

      this.mode = "freeform";
      this.modeContainer.clear();

      const editor = this.ensureEditor();
      this.setEditorText(this.freeformDraft);
      (editor as any).focused = this._focused;

      this.modeContainer.addChild(new Text(this.theme.fg("accent", this.theme.bold("Custom response")), 1, 0));
      this.modeContainer.addChild(new Spacer(1));
      this.modeContainer.addChild(editor);

      this.updateHelpText();
      this.invalidate();
      this.tui.requestRender();
   }

   private showCommentMode(): void {
      if (this.mode === "freeform") {
         this.saveEditorDraft();
      }

      this.mode = "comment";
      this.modeContainer.clear();

      const editor = this.ensureEditor();
      this.setEditorText(this.commentDraft);
      (editor as any).focused = this._focused;

      const selectedLabel = this.pendingSelections.length === 1 ? "Selected option:" : "Selected options:";
      this.modeContainer.addChild(new Text(this.theme.fg("accent", this.theme.bold(selectedLabel)), 1, 0));
      this.modeContainer.addChild(new Text(this.theme.fg("text", this.pendingSelections.join(", ")), 1, 0));
      this.modeContainer.addChild(new Spacer(1));
      this.modeContainer.addChild(editor);

      this.updateHelpText();
      this.invalidate();
      this.tui.requestRender();
   }

   handleInput(data: string): void {
      if (this.mode === "freeform" || this.mode === "comment") {
         if (matchesKey(data, Key.escape)) {
            this.showSelectMode();
            return;
         }

         if (this.keybindings.matches(data, "tui.select.cancel")) {
            this.onDone(null);
            return;
         }

         this.ensureEditor().handleInput(data);
         this.tui.requestRender();
         return;
      }

      if (this.allowMultiple) {
         this.ensureMultiSelectList().handleInput?.(data);
         this.tui.requestRender();
         return;
      }

      this.ensureSingleSelectList().handleInput?.(data);
      this.tui.requestRender();
   }
}

const BATCH_SKIP_SENTINEL = "Skip this question";
const BATCH_NEXT_KEY = Key.ctrl("n");
const BATCH_PREVIOUS_KEY = Key.ctrl("p");
const BATCH_SUBMIT_KEY = Key.ctrl("s");
const BATCH_NEXT_ARROW_KEYS = [
   (Key as Record<string, string | undefined>).right,
   "right",
   "arrowright",
].filter((key): key is string => typeof key === "string" && key.length > 0);
const BATCH_PREVIOUS_ARROW_KEYS = [
   (Key as Record<string, string | undefined>).left,
   "left",
   "arrowleft",
].filter((key): key is string => typeof key === "string" && key.length > 0);

function matchesAnyKey(data: string, keys: string[]): boolean {
   return keys.some((key) => matchesKey(data, key));
}

type BatchAskMode = "select" | "freeform";

class BatchAskComponent implements Component {
   private title?: string;
   private context?: string;
   private questions: BatchQuestion[];
   private tui: TUI;
   private theme: Theme;
   private keybindings: KeybindingsManager;
   private onDone: (result: AskUIResult | null) => void;

   private currentIndex = 0;
   private mode: BatchAskMode;
   private answers = new Map<string, SingleAskResponse>();
   private freeformDrafts = new Map<string, string>();
   private singleSelectList?: WrappedSingleSelectList;
   private multiSelectList?: MultiSelectList;
   private editor?: Editor;
   private _focused = false;

   constructor(
      title: string | undefined,
      context: string | undefined,
      questions: BatchQuestion[],
      tui: TUI,
      theme: Theme,
      keybindings: KeybindingsManager,
      onDone: (result: AskUIResult | null) => void,
   ) {
      this.title = title?.trim() || undefined;
      this.context = context;
      this.questions = questions;
      this.tui = tui;
      this.theme = theme;
      this.keybindings = keybindings;
      this.onDone = onDone;
      this.mode = this.getDefaultMode(this.getCurrentQuestion());
   }

   get focused(): boolean {
      return this._focused;
   }

   set focused(value: boolean) {
      this._focused = value;
      if (this.editor && this.mode === "freeform") {
         (this.editor as any).focused = value;
      }
   }

   invalidate(): void {
      this.singleSelectList?.invalidate();
      this.multiSelectList?.invalidate();
   }

   private getCurrentQuestion(): BatchQuestion {
      return this.questions[this.currentIndex]!;
   }

   private getDefaultMode(question: BatchQuestion): BatchAskMode {
      const existing = this.answers.get(question.id);
      if (existing?.kind === "freeform") return "freeform";
      return question.options.length === 0 ? "freeform" : "select";
   }

   private buildQuestionStatusLabel(question: BatchQuestion, index: number): string {
      const current = index === this.currentIndex;
      const answer = this.answers.get(question.id);
      const marker = current
         ? this.theme.fg("accent", "●")
         : answer
            ? this.theme.fg("success", "✓")
            : this.theme.fg("dim", question.required ? "○" : "◌");
      const prompt = question.question.replace(/\s+/g, " ").trim();
      const summary = answer ? ` — ${formatSingleResponseSummary(answer)}` : question.required ? " — pending" : " — optional";
      return `${marker} ${index + 1}. ${prompt}${summary}`;
   }

   private getMissingRequiredIndex(): number {
      return this.questions.findIndex((question) => question.required && !this.answers.has(question.id));
   }

   private goToQuestion(index: number): void {
      if (this.mode === "freeform") {
         this.saveEditorDraft();
      }

      this.currentIndex = Math.max(0, Math.min(index, this.questions.length - 1));
      this.singleSelectList = undefined;
      this.multiSelectList = undefined;
      this.mode = this.getDefaultMode(this.getCurrentQuestion());

      if (this.mode === "freeform") {
         this.setEditorText(this.getCurrentEditorText());
      }

      this.invalidate();
      this.tui.requestRender();
   }

   private moveNext(): void {
      if (this.currentIndex < this.questions.length - 1) {
         this.goToQuestion(this.currentIndex + 1);
      }
   }

   private movePrevious(): void {
      if (this.currentIndex > 0) {
         this.goToQuestion(this.currentIndex - 1);
      }
   }

   private ensureSingleSelectList(): WrappedSingleSelectList {
      if (this.singleSelectList) return this.singleSelectList;

      const question = this.getCurrentQuestion();
      const list = new WrappedSingleSelectList(
         question.options,
         question.allowFreeform,
         false,
         this.theme,
         this.keybindings,
      );
      const existing = this.answers.get(question.id);
      if (existing?.kind === "selection") {
         list.setSelectedTitle(existing.selections[0]);
      }
      list.onSubmit = (result) => this.handleSelectionSubmit([result]);
      list.onCancel = () => this.onDone(null);
      list.onEnterFreeform = (draft) => this.showFreeformMode(draft);

      this.singleSelectList = list;
      return list;
   }

   private ensureMultiSelectList(): MultiSelectList {
      if (this.multiSelectList) return this.multiSelectList;

      const question = this.getCurrentQuestion();
      const list = new MultiSelectList(
         question.options,
         question.allowFreeform,
         false,
         this.theme,
         this.keybindings,
      );
      const existing = this.answers.get(question.id);
      if (existing?.kind === "selection") {
         list.setSelections(existing.selections);
      }
      list.onCancel = () => this.onDone(null);
      list.onSubmit = (result) => this.handleSelectionSubmit(result);
      list.onEnterFreeform = (draft) => this.showFreeformMode(draft);

      this.multiSelectList = list;
      return list;
   }

   private ensureEditor(): Editor {
      if (this.editor) return this.editor;
      const editor = new Editor(this.tui, createEditorTheme(this.theme));
      editor.disableSubmit = false;
      editor.onSubmit = (text: string) => {
         this.handleEditorSubmit(text);
      };
      this.editor = editor;
      return editor;
   }

   private saveEditorDraft(): void {
      if (!this.editor) return;
      const getText = (this.editor as any).getText;
      if (typeof getText !== "function") return;

      const question = this.getCurrentQuestion();
      this.freeformDrafts.set(question.id, String(getText.call(this.editor) ?? ""));
   }

   private getCurrentEditorText(): string {
      const question = this.getCurrentQuestion();
      const existing = this.answers.get(question.id);
      if (existing?.kind === "freeform") return existing.text;
      return this.freeformDrafts.get(question.id) ?? "";
   }

   private setEditorText(text: string): void {
      const editor = this.ensureEditor();
      const setText = (editor as any).setText;
      if (typeof setText === "function") {
         setText.call(editor, text);
      }
   }

   private handleSelectionSubmit(selections: string[]): void {
      const question = this.getCurrentQuestion();
      const response = createSelectionResponse(selections);
      if (!response) return;
      this.answers.set(question.id, response);
      this.freeformDrafts.delete(question.id);
      this.afterAnswerSaved();
   }

   private handleEditorSubmit(text: string): void {
      const question = this.getCurrentQuestion();
      const response = createFreeformResponse(text);

      if (response) {
         this.answers.set(question.id, response);
         this.freeformDrafts.set(question.id, response.text);
         this.afterAnswerSaved();
         return;
      }

      this.answers.delete(question.id);
      this.freeformDrafts.set(question.id, text);
      if (question.required) {
         this.tui.requestRender();
         return;
      }
      this.afterAnswerSaved();
   }

   private afterAnswerSaved(): void {
      if (this.currentIndex < this.questions.length - 1) {
         this.goToQuestion(this.currentIndex + 1);
         return;
      }

      this.submitBatch();
   }

   private showFreeformMode(initialDraft?: string): void {
      if (typeof initialDraft === "string") {
         this.freeformDrafts.set(this.getCurrentQuestion().id, initialDraft);
      }

      this.mode = "freeform";
      const editor = this.ensureEditor();
      this.setEditorText(this.getCurrentEditorText());
      (editor as any).focused = this._focused;
      this.invalidate();
      this.tui.requestRender();
   }

   private showSelectMode(): void {
      if (this.mode === "freeform") {
         this.saveEditorDraft();
      }
      this.mode = "select";
      this.invalidate();
      this.tui.requestRender();
   }

   private submitBatch(): void {
      const missingRequiredIndex = this.getMissingRequiredIndex();
      if (missingRequiredIndex >= 0) {
         this.goToQuestion(missingRequiredIndex);
         return;
      }

      this.onDone({
         kind: "batch",
         answers: this.questions.map((question) => createBatchAnswer(question.id, this.answers.get(question.id) ?? null)),
      });
   }

   private buildHelpText(): string {
      const theme = this.theme;
      if (this.mode === "freeform") {
         const isLastQuestion = this.currentIndex === this.questions.length - 1;
         const hints = [
            keybindingHint(theme, this.keybindings, "tui.input.submit", isLastQuestion ? "save & submit" : "save answer"),
            keybindingHint(theme, this.keybindings, "tui.input.newLine", "newline"),
            this.getCurrentQuestion().options.length > 0 ? literalHint(theme, "esc", "back") : null,
            literalHint(theme, "←→", "switch question"),
            literalHint(theme, "ctrl+n", "next"),
            literalHint(theme, "ctrl+p", "prev"),
            literalHint(theme, "ctrl+s", "submit"),
            keybindingHint(theme, this.keybindings, "tui.select.cancel", "cancel"),
         ]
            .filter((hint): hint is string => !!hint)
            .join(" • ");
         return theme.fg("dim", hints);
      }

      const isLastQuestion = this.currentIndex === this.questions.length - 1;
      const hints = [
         literalHint(theme, "↑↓", "navigate"),
         this.getCurrentQuestion().allowMultiple ? literalHint(theme, "space", "toggle") : null,
         keybindingHint(theme, this.keybindings, "tui.select.confirm", isLastQuestion ? "save & submit" : "save answer"),
         literalHint(theme, "←→", "switch question"),
         literalHint(theme, "ctrl+n", "next"),
         literalHint(theme, "ctrl+p", "prev"),
         literalHint(theme, "ctrl+s", "submit"),
         keybindingHint(theme, this.keybindings, "tui.select.cancel", "cancel"),
      ]
         .filter((hint): hint is string => !!hint)
         .join(" • ");
      return theme.fg("dim", hints);
   }

   handleInput(data: string): void {
      if (matchesKey(data, BATCH_SUBMIT_KEY)) {
         this.submitBatch();
         return;
      }

      if (matchesKey(data, BATCH_NEXT_KEY) || matchesAnyKey(data, BATCH_NEXT_ARROW_KEYS)) {
         this.moveNext();
         return;
      }

      if (matchesKey(data, BATCH_PREVIOUS_KEY) || matchesAnyKey(data, BATCH_PREVIOUS_ARROW_KEYS)) {
         this.movePrevious();
         return;
      }

      if (this.mode === "freeform") {
         if (matchesKey(data, Key.escape) && this.getCurrentQuestion().options.length > 0) {
            this.showSelectMode();
            return;
         }

         if (this.keybindings.matches(data, "tui.select.cancel")) {
            this.onDone(null);
            return;
         }

         this.ensureEditor().handleInput(data);
         this.tui.requestRender();
         return;
      }

      if (this.getCurrentQuestion().allowMultiple) {
         this.ensureMultiSelectList().handleInput(data);
         this.tui.requestRender();
         return;
      }

      this.ensureSingleSelectList().handleInput(data);
      this.tui.requestRender();
   }

   render(width: number): string[] {
      const innerWidth = Math.max(1, width - BOX_BORDER_OVERHEAD);
      const body: string[] = [];
      const title = this.title ?? "Clarification batch";
      const currentQuestion = this.getCurrentQuestion();

      body.push(this.theme.fg("accent", this.theme.bold(title)));
      if (this.context) {
         body.push("");
         body.push(this.theme.fg("accent", this.theme.bold("Context:")));
         for (const line of wrapTextWithAnsi(this.context, Math.max(10, innerWidth))) {
            body.push(this.theme.fg("dim", line));
         }
      }

      body.push("");
      body.push(this.theme.fg("accent", this.theme.bold(`Questions (${this.currentIndex + 1}/${this.questions.length})`)));
      for (const [index, question] of this.questions.entries()) {
         body.push(truncateToWidth(this.buildQuestionStatusLabel(question, index), innerWidth, ""));
      }

      body.push("");
      body.push(this.theme.fg("accent", this.theme.bold(`Q${this.currentIndex + 1}. ${currentQuestion.question}`)));
      body.push(this.theme.fg("dim", currentQuestion.required ? "Required" : "Optional"));
      body.push("");

      if (this.mode === "freeform") {
         body.push(this.theme.fg("accent", this.theme.bold("Answer")));
         const editor = this.ensureEditor() as any;
         if (typeof editor.render === "function") {
            body.push(...editor.render(innerWidth));
         } else {
            const draft = this.getCurrentEditorText();
            body.push(this.theme.fg("dim", draft || "Type your answer and press Enter to save."));
         }
      } else if (currentQuestion.allowMultiple) {
         body.push(...this.ensureMultiSelectList().render(innerWidth));
      } else {
         body.push(...this.ensureSingleSelectList().render(innerWidth));
      }

      body.push("");
      body.push(this.buildHelpText());

      const borderColor = (s: string) => this.theme.fg("accent", s);
      const titleColor = (s: string) => this.theme.fg("dim", this.theme.bold(s));
      const top = new BoxBorderTop(
         borderColor,
         `ask_user [batch ${this.currentIndex + 1}/${this.questions.length}]`,
         titleColor,
      ).render(width)[0] ?? "";
      const bottom = new BoxBorderBottom(
         borderColor,
         `v${ASK_USER_VERSION}`,
         (s: string) => this.theme.fg("dim", s),
      ).render(width)[0] ?? "";

      const wrappedBody = body.map((line) => {
         const padded = truncateToWidth(line, innerWidth, "", true);
         return `${borderColor(BOX_BORDER_LEFT)}${padded}${borderColor(BOX_BORDER_RIGHT)}`;
      });
      return [top, ...wrappedBody, bottom];
   }
}

function formatBatchPrompt(
   title: string | undefined,
   context: string | undefined,
   question: BatchQuestion,
   index: number,
   total: number,
): string {
   const titleLine = title ? `${title}\n\n` : "";
   const contextLine = context ? `\n\nContext:\n${context}` : "";
   return `${titleLine}[${index + 1}/${total}] ${question.question}${contextLine}`;
}

/**
 * RPC/headless fallback: use dialog methods (select/input) instead of the rich TUI overlay.
 * ctx.ui.custom() returns undefined in RPC mode, so we degrade gracefully.
 */
async function askSingleViaDialogs(
   ui: { select: Function; input: Function },
   question: string,
   context: string | undefined,
   options: QuestionOption[],
   allowMultiple: boolean,
   allowFreeform: boolean,
   allowComment: boolean,
   timeout?: number,
): Promise<SingleAskResponse | null> {
   const dialogOpts = timeout ? { timeout } : undefined;
   const prompt = context ? `${question}\n\nContext:\n${context}` : question;

   if (allowMultiple) {
      const optionList = formatOptionsForMessage(options);
      const rawSelections = await ui.input(
         `${prompt}\n\nOptions (select one or more):\n${optionList}`,
         "Type your selection(s)...",
         dialogOpts,
      ) as string | undefined;
      if (isCancelledInput(rawSelections)) return null;

      const selections = parseDialogSelections(rawSelections);
      if (selections.length === 0) return null;

      if (!allowComment) {
         return createSelectionResponse(selections);
      }

      const comment = await ui.input(
         buildCommentPrompt(prompt, selections),
         "Optional comment (press Enter to skip)...",
         dialogOpts,
      ) as string | undefined;
      return createSelectionResponse(selections, comment);
   }

   const selectOptions = options.map((o) => o.title);
   if (allowFreeform) selectOptions.push(FREEFORM_SENTINEL);

   const selected = await ui.select(prompt, selectOptions, dialogOpts) as string | undefined;
   if (isCancelledInput(selected)) return null;

   if (selected === FREEFORM_SENTINEL) {
      const answer = await ui.input(prompt, "Type your answer...", dialogOpts) as string | undefined;
      if (isCancelledInput(answer)) return null;
      return createFreeformResponse(answer);
   }

   if (!allowComment) {
      return createSelectionResponse([selected]);
   }

   const comment = await ui.input(
      buildCommentPrompt(prompt, [selected]),
      "Optional comment (press Enter to skip)...",
      dialogOpts,
   ) as string | undefined;
   return createSelectionResponse([selected], comment);
}

async function askBatchQuestionViaDialogs(
   ui: { select: Function; input: Function },
   title: string | undefined,
   context: string | undefined,
   question: BatchQuestion,
   index: number,
   total: number,
   timeout?: number,
): Promise<BatchAnswer | null> {
   const dialogOpts = timeout ? { timeout } : undefined;
   const prompt = formatBatchPrompt(title, context, question, index, total);

   if (question.options.length === 0) {
      while (true) {
         const answer = await ui.input(
            prompt,
            question.required ? "Type your answer..." : "Type your answer (press Enter to skip)...",
            dialogOpts,
         ) as string | undefined;
         if (isCancelledInput(answer)) return null;

         const response = createFreeformResponse(answer);
         if (response) return createBatchAnswer(question.id, response);
         if (!question.required) return createSkippedBatchAnswer(question.id);
      }
   }

   if (question.allowMultiple) {
      const optionList = formatOptionsForMessage(question.options);
      while (true) {
         const rawSelections = await ui.input(
            `${prompt}\n\nOptions (select one or more):\n${optionList}`,
            question.required ? "Type your selection(s)..." : "Type your selection(s) or press Enter to skip...",
            dialogOpts,
         ) as string | undefined;
         if (isCancelledInput(rawSelections)) return null;

         const selections = parseDialogSelections(rawSelections);
         if (selections.length > 0) {
            return createBatchAnswer(question.id, createSelectionResponse(selections));
         }
         if (!question.required) return createSkippedBatchAnswer(question.id);
      }
   }

   const selectOptions = question.options.map((option) => option.title);
   if (question.allowFreeform) selectOptions.push(FREEFORM_SENTINEL);
   if (!question.required) selectOptions.push(BATCH_SKIP_SENTINEL);

   while (true) {
      const selected = await ui.select(prompt, selectOptions, dialogOpts) as string | undefined;
      if (isCancelledInput(selected)) return null;
      if (selected === BATCH_SKIP_SENTINEL) return createSkippedBatchAnswer(question.id);

      if (selected === FREEFORM_SENTINEL) {
         const answer = await ui.input(
            prompt,
            question.required ? "Type your answer..." : "Type your answer (press Enter to skip)...",
            dialogOpts,
         ) as string | undefined;
         if (isCancelledInput(answer)) return null;

         const response = createFreeformResponse(answer);
         if (response) return createBatchAnswer(question.id, response);
         if (!question.required) return createSkippedBatchAnswer(question.id);
         continue;
      }

      return createBatchAnswer(question.id, createSelectionResponse([selected]));
   }
}

async function askBatchViaDialogs(
   ui: { select: Function; input: Function },
   title: string | undefined,
   context: string | undefined,
   questions: BatchQuestion[],
   timeout?: number,
): Promise<AskResponse | null> {
   const answers: BatchAnswer[] = [];
   for (const [index, question] of questions.entries()) {
      const answer = await askBatchQuestionViaDialogs(ui, title, context, question, index, questions.length, timeout);
      if (answer === null) return null;
      answers.push(answer);
   }

   const dialogOpts = timeout ? { timeout } : undefined;
   const submitLabel = await ui.select(
      `${title ?? "Clarification batch"}\n\nSubmit ${answers.length} answer(s)?`,
      ["Submit answers", "Cancel"],
      dialogOpts,
   ) as string | undefined;

   if (isCancelledInput(submitLabel) || submitLabel !== "Submit answers") return null;
   return { kind: "batch", answers };
}

export default function(pi: ExtensionAPI) {
   pi.registerTool({
      name: "ask_user",
      label: "Ask User",
      description:
         "Ask the user a focused question or a small batch of related clarification questions. Use this to gather information interactively. Preserve single-question asks for decision gates; use batch mode only for one related clarification pass after gathering context.",
      promptSnippet:
         "Ask the user a focused question or a small batch of related clarification questions to gather information interactively",
      promptGuidelines: [
         "Before calling ask_user, gather context with tools (read/web/ref) and pass a short summary via the context field.",
         "Use ask_user when the user's intent is ambiguous, when a decision requires explicit user input, or when multiple valid options exist.",
         "Default to a single focused question per ask_user call.",
         "Use batch mode only for 2-7 related clarification questions that are known up front and belong to one topic.",
         "Do not use batch mode for unrelated questions or branching interviews where later questions depend on earlier answers.",
      ],
      parameters: Type.Object({
         mode: Type.Optional(Type.String({ description: "Mode for ask_user. Omit or use 'single' for the default single-question flow. Use 'batch' for a related clarification packet." })),
         question: Type.Optional(Type.String({ description: "The question to ask the user in single-question mode" })),
         title: Type.Optional(Type.String({ description: "Short title shown above the batch questionnaire." })),
         context: Type.Optional(
            Type.String({
               description: "Relevant context to show before the question or batch questions (summary of findings)",
            }),
         ),
         options: Type.Optional(
            Type.Array(
               Type.Union([
                  Type.String({ description: "Short title for this option" }),
                  Type.Object({
                     title: Type.String({ description: "Short title for this option" }),
                     description: Type.Optional(
                        Type.String({ description: "Longer description explaining this option" }),
                     ),
                  }),
               ]),
               { description: "List of options for the user to choose from in single-question mode" },
            ),
         ),
         allowMultiple: Type.Optional(
            Type.Boolean({ description: "Allow selecting multiple options. Default: false" }),
         ),
         allowFreeform: Type.Optional(
            Type.Boolean({ description: "Add a freeform text option. Default: true" }),
         ),
         allowComment: Type.Optional(
            Type.Boolean({ description: "Collect an optional comment after selecting one or more options in single-question mode. Default: false" }),
         ),
         questions: Type.Optional(
            Type.Array(
               Type.Object({
                  id: Type.String({ description: "Stable identifier for this clarification question" }),
                  question: Type.String({ description: "The question to ask the user" }),
                  options: Type.Optional(
                     Type.Array(
                        Type.Union([
                           Type.String({ description: "Short title for this option" }),
                           Type.Object({
                              title: Type.String({ description: "Short title for this option" }),
                              description: Type.Optional(
                                 Type.String({ description: "Longer description explaining this option" }),
                              ),
                           }),
                        ]),
                        { description: "List of options for the user to choose from" },
                     ),
                  ),
                  allowMultiple: Type.Optional(Type.Boolean({ description: "Allow selecting multiple options. Default: false" })),
                  allowFreeform: Type.Optional(Type.Boolean({ description: "Add a freeform text option. Default: true" })),
                  required: Type.Optional(Type.Boolean({ description: "Require this question before final submission. Default: true" })),
               }),
               { description: "A related set of 2-7 clarification questions for batch mode." },
            ),
         ),
         timeout: Type.Optional(
            Type.Number({ description: "Auto-dismiss after N milliseconds. Returns null (cancelled) when expired." }),
         ),
      }),

      async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
         const params = rawParams as AskParams;
         if (signal?.aborted) {
            return {
               content: [{ type: "text", text: "Cancelled" }],
               details: { mode: isBatchParams(params) ? "batch" : "single", response: null, cancelled: true } as AskToolDetails,
            };
         }

         const normalizedContext = params.context?.trim() || undefined;

         try {
            if (isBatchParams(params)) {
               if (!Array.isArray(params.questions)) {
                  throw new Error("Batch mode requires a questions array.");
               }
               const title = params.title?.trim() || undefined;
               const questions = normalizeBatchQuestions(params.questions);
               const timeout = params.timeout;

               if (!ctx.hasUI || !ctx.ui) {
                  const questionText = questions.map((question, index) => `${index + 1}. ${question.question}`).join("\n");
                  const contextText = normalizedContext ? `\n\nContext:\n${normalizedContext}` : "";
                  return {
                     content: [
                        {
                           type: "text",
                           text: `Ask requires interactive mode. Please answer this clarification batch:\n\n${title ?? "Clarification batch"}${contextText}\n\n${questionText}`,
                        },
                     ],
                     isError: true,
                     details: { mode: "batch", title, context: normalizedContext, questions, response: null, cancelled: true } as AskToolDetails,
                  };
               }

               onUpdate?.({
                  content: [{ type: "text", text: "Waiting for user input..." }],
                  details: { mode: "batch", title, context: normalizedContext, questions, response: null, cancelled: false } as AskToolDetails,
               });

               let result: AskUIResult | null;
               const customResult = await ctx.ui.custom<AskUIResult | null>(
                  (tui, theme, keybindings, done) => {
                     if (signal) {
                        const onAbort = () => done(null);
                        signal.addEventListener("abort", onAbort, { once: true });
                     }

                     if (timeout && timeout > 0) {
                        setTimeout(() => done(null), timeout);
                     }

                     return new BatchAskComponent(
                        title,
                        normalizedContext,
                        questions,
                        tui,
                        theme,
                        keybindings,
                        done,
                     );
                  },
                  {
                     overlay: true,
                     overlayOptions: {
                        anchor: "center",
                        width: ASK_OVERLAY_WIDTH,
                        minWidth: ASK_OVERLAY_MIN_WIDTH,
                        maxHeight: "85%",
                        margin: 1,
                     },
                  },
               );

               if (customResult !== undefined) {
                  result = customResult;
               } else {
                  result = await askBatchViaDialogs(ctx.ui, title, normalizedContext, questions, timeout);
               }

               if (result === null) {
                  pi.events.emit("ask:cancelled", { mode: "batch", title, context: normalizedContext, questions });
                  return {
                     content: [{ type: "text", text: "User cancelled the clarification batch" }],
                     details: { mode: "batch", title, context: normalizedContext, questions, response: null, cancelled: true } as AskToolDetails,
                  };
               }

               pi.events.emit("ask:answered", {
                  mode: "batch",
                  title,
                  context: normalizedContext,
                  questions,
                  response: result,
               });
               return {
                  content: [{ type: "text", text: formatSuccessfulResponseContent(result, { title, questions }) }],
                  details: {
                     mode: "batch",
                     title,
                     context: normalizedContext,
                     questions,
                     response: result,
                     cancelled: false,
                  } as AskToolDetails,
               };
            }

            const {
               question,
               options: rawOptions = [],
               allowMultiple = false,
               allowFreeform = true,
               allowComment = false,
               timeout,
            } = params;
            const normalizedQuestion = question?.trim();
            if (!normalizedQuestion) {
               throw new Error("Single-question mode requires a question string.");
            }
            const options = normalizeOptions(rawOptions);

            if (!ctx.hasUI || !ctx.ui) {
               const optionText = options.length > 0 ? `\n\nOptions:\n${formatOptionsForMessage(options)}` : "";
               const freeformHint = allowFreeform ? "\n\nYou can also answer freely." : "";
               const commentHint = allowComment ? "\n\nAfter choosing an option, you may add an optional comment." : "";
               const contextText = normalizedContext ? `\n\nContext:\n${normalizedContext}` : "";
               return {
                  content: [
                     {
                        type: "text",
                        text: `Ask requires interactive mode. Please answer:\n\n${normalizedQuestion}${contextText}${optionText}${freeformHint}${commentHint}`,
                     },
                  ],
                  isError: true,
                  details: { mode: "single", question: normalizedQuestion, context: normalizedContext, options, response: null, cancelled: true } as AskToolDetails,
               };
            }

            if (options.length === 0) {
               const prompt = normalizedContext ? `${normalizedQuestion}\n\nContext:\n${normalizedContext}` : normalizedQuestion;
               const answer = await ctx.ui.input(prompt, "Type your answer...", timeout ? { timeout } : undefined);
               const response = createFreeformResponse(answer);

               if (!response) {
                  return {
                     content: [{ type: "text", text: "User cancelled the question" }],
                     details: { mode: "single", question: normalizedQuestion, context: normalizedContext, options, response: null, cancelled: true } as AskToolDetails,
                  };
               }

               pi.events.emit("ask:answered", { question: normalizedQuestion, context: normalizedContext, response });
               return {
                  content: [{ type: "text", text: formatSuccessfulResponseContent(response) }],
                  details: { mode: "single", question: normalizedQuestion, context: normalizedContext, options, response, cancelled: false } as AskToolDetails,
               };
            }

            onUpdate?.({
               content: [{ type: "text", text: "Waiting for user input..." }],
               details: { mode: "single", question: normalizedQuestion, context: normalizedContext, options, response: null, cancelled: false } as AskToolDetails,
            });

            let result: AskUIResult | null;
            const customResult = await ctx.ui.custom<AskUIResult | null>(
               (tui, theme, keybindings, done) => {
                  if (signal) {
                     const onAbort = () => done(null);
                     signal.addEventListener("abort", onAbort, { once: true });
                  }

                  if (timeout && timeout > 0) {
                     setTimeout(() => done(null), timeout);
                  }

                  return new AskComponent(
                     normalizedQuestion,
                     normalizedContext,
                     options,
                     allowMultiple,
                     allowFreeform,
                     allowComment,
                     tui,
                     theme,
                     keybindings,
                     done,
                  );
               },
               {
                  overlay: true,
                  overlayOptions: {
                     anchor: "center",
                     width: ASK_OVERLAY_WIDTH,
                     minWidth: ASK_OVERLAY_MIN_WIDTH,
                     maxHeight: "85%",
                     margin: 1,
                  },
               },
            );

            if (customResult !== undefined) {
               result = customResult;
            } else {
               result = await askSingleViaDialogs(ctx.ui, normalizedQuestion, normalizedContext, options, allowMultiple, allowFreeform, allowComment, timeout);
            }

            if (result === null) {
               pi.events.emit("ask:cancelled", { question: normalizedQuestion, context: normalizedContext, options });
               return {
                  content: [{ type: "text", text: "User cancelled the question" }],
                  details: { mode: "single", question: normalizedQuestion, context: normalizedContext, options, response: null, cancelled: true } as AskToolDetails,
               };
            }

            pi.events.emit("ask:answered", {
               question: normalizedQuestion,
               context: normalizedContext,
               response: result,
            });
            return {
               content: [{ type: "text", text: formatSuccessfulResponseContent(result) }],
               details: {
                  mode: "single",
                  question: normalizedQuestion,
                  context: normalizedContext,
                  options,
                  response: result,
                  cancelled: false,
               } as AskToolDetails,
            };
         } catch (error) {
            const message =
               error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
            return {
               content: [{ type: "text", text: `Ask tool failed: ${message}` }],
               isError: true,
               details: { error: message },
            };
         }
      },

      renderCall(args, theme) {
         if (args.mode === "batch" || Array.isArray(args.questions)) {
            const rawQuestions = Array.isArray(args.questions) ? args.questions : [];
            const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : "Clarification batch";
            const labels = rawQuestions
               .map((question: unknown) => (question && typeof question === "object" ? (question as { question?: string }).question ?? "" : ""))
               .filter(Boolean);
            let text = theme.fg("toolTitle", theme.bold("ask_user "));
            text += theme.fg("muted", title);
            text += "\n" + theme.fg("dim", `  ${rawQuestions.length} question(s)`);
            if (labels.length > 0) {
               text += "\n" + theme.fg("dim", `  ${labels.slice(0, 3).join(" • ")}`);
               if (labels.length > 3) {
                  text += theme.fg("dim", " …");
               }
            }
            text += theme.fg("dim", " [batch clarification]");
            return new Text(text, 0, 0);
         }

         const question = (args.question as string) || "";
         const rawOptions = Array.isArray(args.options) ? args.options : [];
         let text = theme.fg("toolTitle", theme.bold("ask_user "));
         text += theme.fg("muted", question);
         if (rawOptions.length > 0) {
            const labels = rawOptions.map((o: unknown) =>
               typeof o === "string" ? o : (o as QuestionOption)?.title ?? "",
            );
            text += "\n" + theme.fg("dim", `  ${rawOptions.length} option(s): ${labels.join(", ")}`);
         }
         if (args.allowMultiple) {
            text += theme.fg("dim", " [multi-select]");
         }
         if (args.allowComment) {
            text += theme.fg("dim", " [optional comment]");
         }
         return new Text(text, 0, 0);
      },

      renderResult(result, options, theme) {
         const details = result.details as (AskToolDetails & { error?: string }) | undefined;

         if (details?.error) {
            return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
         }

         if (options.isPartial) {
            const waitingText = result.content
               ?.filter((part: { type?: string; text?: string }) => part?.type === "text")
               .map((part: { text?: string }) => part.text ?? "")
               .join("\n")
               .trim() || "Waiting for user input...";
            return new Text(theme.fg("muted", waitingText), 0, 0);
         }

         if (!details || details.cancelled || !details.response) {
            return new Text(theme.fg("warning", "Cancelled"), 0, 0);
         }

         const response = details.response;
         let text = theme.fg("success", "✓ ");
         if (response.kind === "freeform") {
            text += theme.fg("muted", "(wrote) ");
         }
         text += theme.fg("accent", formatResponseSummary(response));

         if (response.kind === "batch") {
            if (options.expanded) {
               text += "\n" + theme.fg("dim", `Batch: ${details.title ?? "Clarification batch"}`);
               if (details.context) {
                  text += "\n" + theme.fg("dim", details.context);
               }
               const questions = details.questions ?? [];
               for (const [index, answer] of response.answers.entries()) {
                  const question = questions[index];
                  const questionLabel = question?.question ?? answer.id;
                  const marker = answer.kind === "skipped" ? theme.fg("dim", "○") : theme.fg("success", "●");
                  text += `\n${theme.fg("dim", `Q${index + 1}: ${questionLabel}`)}`;
                  text += `\n  ${marker} ${theme.fg("dim", formatBatchAnswerSummary(answer))}`;
               }
            }
            return new Text(text, 0, 0);
         }

         if (options.expanded) {
            text += "\n" + theme.fg("dim", `Q: ${details.question}`);
            if (details.context) {
               text += "\n" + theme.fg("dim", details.context);
            }

            const detailOptions = details.options ?? [];
            if (isSelectionResponse(response) && detailOptions.length > 0) {
               const selectedTitles = new Set(response.selections);
               text += "\n" + theme.fg("dim", "Options:");
               for (const opt of detailOptions) {
                  const desc = opt.description ? ` — ${opt.description}` : "";
                  const marker = selectedTitles.has(opt.title) ? theme.fg("success", "●") : theme.fg("dim", "○");
                  text += `\n  ${marker} ${theme.fg("dim", opt.title)}${theme.fg("dim", desc)}`;
               }
               if (response.comment) {
                  text += `\n${theme.fg("dim", "Comment:")} ${theme.fg("dim", response.comment)}`;
               }
            }
         }

         return new Text(text, 0, 0);
      },
   });
}

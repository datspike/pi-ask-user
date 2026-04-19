import type { Theme } from "@mariozechner/pi-coding-agent";
import {
  type Component,
  Editor,
  Key,
  type KeybindingsManager,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type TUI,
} from "@mariozechner/pi-tui";
import {
  type AskUIResult,
  type BatchQuestion,
  formatSingleResponseSummary,
} from "./ask-user-core";
import { BatchAskController } from "./ask-overlay-controller";
import {
  BATCH_NEXT_ARROW_KEYS,
  BATCH_NEXT_KEY,
  BATCH_PREVIOUS_ARROW_KEYS,
  BATCH_PREVIOUS_KEY,
  BATCH_SUBMIT_KEY,
  BOX_BORDER_LEFT,
  BOX_BORDER_OVERHEAD,
  BOX_BORDER_RIGHT,
  BoxBorderBottom,
  BoxBorderTop,
  createEditorTheme,
  keybindingHint,
  literalHint,
  matchesAnyKey,
  MultiSelectList,
  WrappedSingleSelectList,
} from "./ask-overlay-ui";
import {
  ASK_USER_VERSION,
  readEditorText,
  setEditorFocus,
  writeEditorText,
  writeEditorTextIfNeeded,
} from "./pi-compat";

export class BatchAskComponent implements Component {
  private title?: string;
  private context?: string;
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private onDone: (result: AskUIResult | null) => void;
  private controller: BatchAskController;

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
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.onDone = onDone;
    this.controller = new BatchAskController(questions);
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    if (this.editor && this.controller.mode === "freeform") {
      setEditorFocus(this.editor, value);
    }
  }

  invalidate(): void {
    this.singleSelectList?.invalidate();
    this.multiSelectList?.invalidate();
  }

  private get questions(): BatchQuestion[] {
    return this.controller.getQuestions();
  }

  private getCurrentQuestion(): BatchQuestion {
    return this.controller.getCurrentQuestion();
  }

  private currentEditorText(): string | undefined {
    return readEditorText(this.editor);
  }

  private buildQuestionStatusLabel(question: BatchQuestion, index: number): string {
    const current = index === this.controller.questionIndex;
    const answer = this.controller.getAnswer(question.id);
    const marker = current
      ? this.theme.fg("accent", "●")
      : answer
        ? this.theme.fg("success", "✓")
        : this.theme.fg("dim", question.required ? "○" : "◌");
    const prompt = question.question.replace(/\s+/g, " ").trim();
    const summary = answer ? ` — ${formatSingleResponseSummary(answer)}` : question.required ? " — pending" : " — optional";
    return `${marker} ${index + 1}. ${prompt}${summary}`;
  }

  private goToQuestion(index: number): void {
    this.controller.goToQuestion(index, this.currentEditorText());
    this.singleSelectList = undefined;
    this.multiSelectList = undefined;
    if (this.controller.mode === "freeform") {
      writeEditorText(this.ensureEditor(), this.controller.getCurrentEditorText());
      setEditorFocus(this.editor, this._focused);
    }
    this.invalidate();
    this.tui.requestRender();
  }

  private moveNext(): void {
    if (this.controller.questionIndex < this.questions.length - 1) {
      this.goToQuestion(this.controller.questionIndex + 1);
    }
  }

  private movePrevious(): void {
    if (this.controller.questionIndex > 0) {
      this.goToQuestion(this.controller.questionIndex - 1);
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
    const existing = this.controller.getAnswer(question.id);
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
    const existing = this.controller.getAnswer(question.id);
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
    editor.onSubmit = (text: string) => this.handleEditorSubmit(text);
    this.editor = editor;
    return editor;
  }

  private handleSelectionSubmit(selections: string[]): void {
    const result = this.controller.saveSelectionAnswer(selections);
    if (result) {
      this.onDone(result);
      return;
    }

    this.singleSelectList = undefined;
    this.multiSelectList = undefined;
    if (this.controller.mode === "freeform") {
      writeEditorText(this.ensureEditor(), this.controller.getCurrentEditorText());
      setEditorFocus(this.editor, this._focused);
    }
    this.invalidate();
    this.tui.requestRender();
  }

  private handleEditorSubmit(text: string): void {
    const result = this.controller.saveEditorAnswer(text);
    if (result) {
      this.onDone(result);
      return;
    }

    this.singleSelectList = undefined;
    this.multiSelectList = undefined;
    if (this.controller.mode === "freeform") {
      writeEditorText(this.ensureEditor(), this.controller.getCurrentEditorText());
      setEditorFocus(this.editor, this._focused);
    }
    this.invalidate();
    this.tui.requestRender();
  }

  private showFreeformMode(initialDraft?: string): void {
    const text = this.controller.enterFreeform(initialDraft);
    const hadEditor = Boolean(this.editor);
    const editor = this.ensureEditor();
    writeEditorTextIfNeeded(editor, text, hadEditor || text.length > 0);
    setEditorFocus(editor, this._focused);
    this.invalidate();
    this.tui.requestRender();
  }

  private showSelectMode(): void {
    this.controller.enterSelect(this.currentEditorText());
    this.invalidate();
    this.tui.requestRender();
  }

  private submitBatch(): void {
    const result = this.controller.submitBatch(this.currentEditorText());
    if (result) {
      this.onDone(result);
      return;
    }

    this.singleSelectList = undefined;
    this.multiSelectList = undefined;
    if (this.controller.mode === "freeform") {
      writeEditorText(this.ensureEditor(), this.controller.getCurrentEditorText());
      setEditorFocus(this.editor, this._focused);
    }
    this.invalidate();
    this.tui.requestRender();
  }

  private buildHelpText(): string {
    const theme = this.theme;
    if (this.controller.mode === "freeform") {
      const isLastQuestion = this.controller.questionIndex === this.questions.length - 1;
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

    const isLastQuestion = this.controller.questionIndex === this.questions.length - 1;
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

    if (this.controller.mode === "freeform") {
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
    body.push(this.theme.fg("accent", this.theme.bold(`Questions (${this.controller.questionIndex + 1}/${this.questions.length})`)));
    for (const [index, question] of this.questions.entries()) {
      body.push(truncateToWidth(this.buildQuestionStatusLabel(question, index), innerWidth, ""));
    }

    body.push("");
    body.push(this.theme.fg("accent", this.theme.bold(`Q${this.controller.questionIndex + 1}. ${currentQuestion.question}`)));
    body.push(this.theme.fg("dim", currentQuestion.required ? "Required" : "Optional"));
    body.push("");

    if (this.controller.mode === "freeform") {
      body.push(this.theme.fg("accent", this.theme.bold("Answer")));
      const editor = this.ensureEditor() as any;
      if (typeof editor.render === "function") {
        body.push(...editor.render(innerWidth));
      } else {
        const draft = this.controller.getCurrentEditorText();
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
      `ask_user [batch ${this.controller.questionIndex + 1}/${this.questions.length}]`,
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

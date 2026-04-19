import type { Theme } from "@mariozechner/pi-coding-agent";
import {
  Container,
  type Component,
  Editor,
  Key,
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
import { type AskUIResult, createFreeformResponse, createSelectionResponse } from "./ask-user-core";
import { SingleAskController } from "./ask-overlay-controller";
import {
  ASK_OVERLAY_MAX_HEIGHT_RATIO,
  BOX_BORDER_LEFT,
  BOX_BORDER_OVERHEAD,
  BOX_BORDER_RIGHT,
  BoxBorderBottom,
  BoxBorderTop,
  createEditorTheme,
  keybindingHint,
  literalHint,
  MultiSelectList,
  WrappedSingleSelectList,
} from "./ask-overlay-ui";
import {
  ASK_USER_VERSION,
  getOptionalMarkdownTheme,
  readEditorText,
  setEditorFocus,
  writeEditorText,
  writeEditorTextIfNeeded,
} from "./pi-compat";
import type { QuestionOption } from "./single-select-layout";

export class AskComponent extends Container {
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
  private controller = new SingleAskController();

  private titleText: Text;
  private questionText: Text;
  private contextComponent?: Component;
  private modeContainer: Container;
  private helpText: Text;

  private singleSelectList?: WrappedSingleSelectList;
  private multiSelectList?: MultiSelectList;
  private editor?: Editor;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    if (this.editor && (this.controller.mode === "freeform" || this.controller.mode === "comment")) {
      setEditorFocus(this.editor, value);
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

    this.addChild(
      new BoxBorderTop(
        (s: string) => theme.fg("accent", s),
        "ask_user",
        (s: string) => theme.fg("dim", theme.bold(s)),
      ),
    );
    this.addChild(new Spacer(1));

    this.titleText = new Text("", 1, 0);
    this.addChild(this.titleText);
    this.addChild(new Spacer(1));

    this.questionText = new Text("", 1, 0);
    this.addChild(this.questionText);

    if (this.context) {
      this.addChild(new Spacer(1));
      const mdTheme: MarkdownTheme | undefined = getOptionalMarkdownTheme();
      this.contextComponent = mdTheme ? new Markdown("", 1, 0, mdTheme) : new Text("", 1, 0);
      this.addChild(this.contextComponent);
    }

    this.addChild(new Spacer(1));

    this.modeContainer = new Container();
    this.addChild(this.modeContainer);

    this.addChild(new Spacer(1));
    this.helpText = new Text("", 1, 0);
    this.addChild(this.helpText);

    this.addChild(new Spacer(1));
    this.addChild(
      new BoxBorderBottom(
        (s: string) => theme.fg("accent", s),
        `v${ASK_USER_VERSION}`,
        (s: string) => theme.fg("dim", s),
      ),
    );

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

    if (this.controller.mode === "select" && !this.allowMultiple) {
      const overlayMaxHeight = Math.max(12, Math.floor(this.tui.terminal.rows * ASK_OVERLAY_MAX_HEIGHT_RATIO));
      const staticLines = this.countStaticLines(innerWidth);
      const availableOptionRows = Math.max(4, overlayMaxHeight - staticLines);
      this.ensureSingleSelectList().setMaxVisibleRows(availableOptionRows);
    }

    const rawLines = super.render(innerWidth);
    const borderColor = (s: string) => this.theme.fg("accent", s);
    const titleColor = (s: string) => this.theme.fg("dim", this.theme.bold(s));
    return rawLines.map((line, index) => {
      if (index === 0 || index === rawLines.length - 1) {
        if (index === 0) return new BoxBorderTop(borderColor, "ask_user", titleColor).render(width)[0] ?? "";
        return new BoxBorderBottom(borderColor, `v${ASK_USER_VERSION}`, (s: string) => this.theme.fg("dim", s)).render(width)[0] ?? "";
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
    const title = this.controller.mode === "comment" ? "Optional comment" : "Question";
    this.titleText.setText(this.theme.fg("accent", this.theme.bold(title)));
    this.questionText.setText(this.theme.fg("text", this.theme.bold(this.question)));
    if (this.contextComponent && this.context) {
      if (this.contextComponent instanceof Markdown) {
        (this.contextComponent as Markdown).setText(`**Context:**\n${this.context}`);
      } else {
        (this.contextComponent as Text).setText(
          `${this.theme.fg("accent", this.theme.bold("Context:"))}\n${this.theme.fg("dim", this.context)}`,
        );
      }
    }
  }

  private updateHelpText(): void {
    const theme = this.theme;
    if (this.controller.mode === "freeform" || this.controller.mode === "comment") {
      const alternateCancelKeys = this.keybindings
        .getKeys("tui.select.cancel")
        .filter((key) => key !== "escape" && key !== "esc");
      const hints = [
        keybindingHint(theme, this.keybindings, "tui.input.submit", this.controller.mode === "comment" ? "submit/skip" : "submit"),
        keybindingHint(theme, this.keybindings, "tui.input.newLine", "newline"),
        literalHint(theme, "esc", "back"),
        alternateCancelKeys.length > 0 ? literalHint(theme, alternateCancelKeys.join("/"), "cancel") : null,
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
      return;
    }

    const alternateCancelKeys = this.keybindings
      .getKeys("tui.select.cancel")
      .filter((key) => key !== "escape" && key !== "esc");
    const hints = [
      literalHint(theme, "↑↓", "navigate"),
      this.allowFreeform ? literalHint(theme, "type", "custom answer") : null,
      this.allowComment ? literalHint(theme, "ctrl+g", "toggle context") : null,
      keybindingHint(theme, this.keybindings, "tui.select.confirm", "select"),
      literalHint(theme, "esc", "cancel"),
      alternateCancelKeys.length > 0 ? literalHint(theme, alternateCancelKeys.join("/"), "cancel") : null,
    ]
      .filter((hint): hint is string => !!hint)
      .join(" • ");
    this.helpText.setText(theme.fg("dim", hints));
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
    editor.onSubmit = (text: string) => this.handleEditorSubmit(text);
    this.editor = editor;
    return editor;
  }

  private currentEditorText(): string | undefined {
    return readEditorText(this.editor);
  }

  private handleSelectionSubmit(selections: string[], wantsComment: boolean): void {
    const transition = this.controller.submitSelection(selections, this.allowComment && wantsComment);
    if (transition.kind === "comment") {
      this.showCommentMode();
      return;
    }
    this.onDone(transition.response ?? createSelectionResponse(selections));
  }

  private handleEditorSubmit(text: string): void {
    if (this.controller.mode === "freeform") {
      this.onDone(createFreeformResponse(text));
      return;
    }

    this.onDone(this.controller.submitEditor(text));
  }

  private showSelectMode(): void {
    this.controller.enterSelect(this.currentEditorText());
    this.modeContainer.clear();
    this.modeContainer.addChild(this.allowMultiple ? this.ensureMultiSelectList() : this.ensureSingleSelectList());
    this.updateHelpText();
    this.invalidate();
    this.tui.requestRender();
  }

  private showFreeformMode(initialDraft?: string): void {
    const text = this.controller.enterFreeform(initialDraft, this.currentEditorText());
    this.modeContainer.clear();

    const hadEditor = Boolean(this.editor);
    const editor = this.ensureEditor();
    writeEditorTextIfNeeded(editor, text, hadEditor || text.length > 0);
    setEditorFocus(editor, this._focused);

    this.modeContainer.addChild(new Text(this.theme.fg("accent", this.theme.bold("Custom response")), 1, 0));
    this.modeContainer.addChild(new Spacer(1));
    this.modeContainer.addChild(editor);

    this.updateHelpText();
    this.invalidate();
    this.tui.requestRender();
  }

  private showCommentMode(): void {
    const editor = this.ensureEditor();
    writeEditorText(editor, this.controller.commentDraft);
    setEditorFocus(editor, this._focused);

    this.modeContainer.clear();
    const selections = this.controller.selectedOptionsForComment;
    const selectedLabel = selections.length === 1 ? "Selected option:" : "Selected options:";
    this.modeContainer.addChild(new Text(this.theme.fg("accent", this.theme.bold(selectedLabel)), 1, 0));
    this.modeContainer.addChild(new Text(this.theme.fg("text", selections.join(", ")), 1, 0));
    this.modeContainer.addChild(new Spacer(1));
    this.modeContainer.addChild(editor);

    this.updateHelpText();
    this.invalidate();
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.controller.mode === "freeform" || this.controller.mode === "comment") {
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

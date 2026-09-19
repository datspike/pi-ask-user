import type { Theme } from "@earendil-works/pi-coding-agent";
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
} from "@earendil-works/pi-tui";
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

function wrapPlainText(text: string, width: number): string[] {
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (!line || line.length + 1 + word.length <= width) line = line ? `${line} ${word}` : word;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

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
  private displayMode: "overlay" | "inline";
  private singleSelectLayout: "auto" | "list";
  private preferExpandedContext: boolean;
  private commentToggleKey: string | null;
  private contextToggleKey: string;
  private overlayToggleKey: string | null;
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
  private promptScrollOffset = 0;
  private promptMaxScrollOffset = 0;
  private promptViewportRows = 0;
  private contextExpanded = false;
  private contextCollapsible = false;
  private contextPreferenceApplied = false;

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
    displayMode: "overlay" | "inline",
    singleSelectLayout: "auto" | "list",
    contextExpanded: boolean,
    commentToggleKey: string | null,
    contextToggleKey: string,
    overlayToggleKey: string | null,
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
    this.displayMode = displayMode;
    this.singleSelectLayout = singleSelectLayout;
    this.preferExpandedContext = contextExpanded;
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.commentToggleKey = commentToggleKey;
    this.contextToggleKey = contextToggleKey;
    this.overlayToggleKey = displayMode === "overlay" ? overlayToggleKey : null;
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

    const maxHeight = Math.max(12, Math.floor(this.tui.terminal.rows * ASK_OVERLAY_MAX_HEIGHT_RATIO));
    const bodyCapacity = Math.max(1, maxHeight - 2);
    const helpLines = this.helpText.render(innerWidth);
    const helpBudget = bodyCapacity >= 12 ? Math.min(2, helpLines.length) : Math.min(1, helpLines.length);
    const contentBudget = Math.max(1, bodyCapacity - helpBudget);
    const questionLines = wrapPlainText(this.question, Math.max(10, innerWidth)).map((line) => this.theme.fg("text", this.theme.bold(line)));
    const fullContextLines = this.contextComponent?.render(innerWidth) ?? [];
    const minimumModeRows = this.controller.mode === "select" ? 3 : 5;
    this.contextCollapsible = fullContextLines.length > 0 && questionLines.length + fullContextLines.length + 2 + minimumModeRows > contentBudget;
    if (this.contextCollapsible && !this.contextPreferenceApplied) {
      this.contextExpanded = this.preferExpandedContext;
      this.contextPreferenceApplied = true;
    }
    const contextLines = this.contextCollapsible && !this.contextExpanded
      ? [this.theme.fg("dim", `Context (${fullContextLines.length} lines) — ${this.contextToggleKey} expand`)]
      : fullContextLines;
    const promptLines = [...questionLines, ...(contextLines.length ? ["", ...contextLines] : [])];
    const separatorRows = contentBudget >= 4 ? 1 : 0;
    const modeBudget = Math.max(1, Math.min(this.controller.mode === "select" ? 8 : 10, contentBudget - separatorRows - 1));
    const promptBudget = Math.max(1, contentBudget - separatorRows - modeBudget);
    let modeLines: string[];
    if (this.controller.mode === "select") {
      if (this.allowMultiple) modeLines = this.ensureMultiSelectList().render(innerWidth);
      else { this.ensureSingleSelectList().setMaxVisibleRows(modeBudget); modeLines = this.ensureSingleSelectList().render(innerWidth); }
    } else {
      const editor = this.ensureEditor() as any;
      const editorLines = typeof editor.render === "function" ? editor.render(innerWidth) : [this.theme.fg("dim", this.currentEditorText() || "Type your answer...")];
      modeLines = [this.theme.fg("accent", this.theme.bold(this.controller.mode === "comment" ? "Optional comment" : "Custom response")), ...editorLines];
    }
    modeLines = modeLines.slice(0, modeBudget);
    this.promptViewportRows = promptBudget;
    this.promptMaxScrollOffset = Math.max(0, promptLines.length - promptBudget);
    this.promptScrollOffset = Math.min(this.promptScrollOffset, this.promptMaxScrollOffset);
    const visiblePrompt = promptLines.slice(this.promptScrollOffset, this.promptScrollOffset + promptBudget);
    if (this.promptScrollOffset > 0 && visiblePrompt.length) visiblePrompt[0] = this.theme.fg("dim", "↑ ") + visiblePrompt[0];
    if (this.promptScrollOffset + promptBudget < promptLines.length && visiblePrompt.length) {
      const last = visiblePrompt.length - 1; visiblePrompt[last] = this.theme.fg("dim", "↓ ") + visiblePrompt[last];
    }
    const body = [...visiblePrompt, ...(visiblePrompt.length && modeLines.length && separatorRows ? [""] : []), ...modeLines, ...helpLines.slice(0, helpBudget)];
    const borderColor = (s: string) => this.theme.fg("accent", s);
    const top = new BoxBorderTop(borderColor, "ask_user", (s) => this.theme.fg("dim", this.theme.bold(s))).render(width)[0] ?? "";
    const bottom = new BoxBorderBottom(borderColor, `v${ASK_USER_VERSION}`, (s) => this.theme.fg("dim", s)).render(width)[0] ?? "";
    return [top, ...body.slice(0, bodyCapacity).map((line) => `${borderColor(BOX_BORDER_LEFT)}${truncateToWidth(line, innerWidth, "", true)}${borderColor(BOX_BORDER_RIGHT)}`), bottom];
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
        this.overlayToggleKey ? literalHint(theme, this.overlayToggleKey, "hide") : null,
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
        this.allowComment && this.commentToggleKey ? literalHint(theme, this.commentToggleKey, "toggle context") : null,
        this.contextCollapsible ? literalHint(theme, this.contextToggleKey, this.contextExpanded ? "collapse context" : "expand context") : null,
        this.promptMaxScrollOffset > 0 ? literalHint(theme, "PgUp/PgDn", "prompt") : null,
        this.overlayToggleKey ? literalHint(theme, this.overlayToggleKey, "hide") : null,
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
      this.allowComment && this.commentToggleKey ? literalHint(theme, this.commentToggleKey, "toggle context") : null,
      this.contextCollapsible ? literalHint(theme, this.contextToggleKey, this.contextExpanded ? "collapse context" : "expand context") : null,
      this.promptMaxScrollOffset > 0 ? literalHint(theme, "PgUp/PgDn", "prompt") : null,
      this.overlayToggleKey ? literalHint(theme, this.overlayToggleKey, "hide") : null,
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
      this.commentToggleKey,
      this.singleSelectLayout,
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
      this.commentToggleKey,
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

  private maybeReturnToSelectModeAfterEmptyFreeform(previousText: string | undefined): boolean {
    if (this.controller.mode !== "freeform" || this.options.length === 0) {
      return false;
    }

    if (!previousText || previousText.length === 0) {
      return false;
    }

    const currentText = this.currentEditorText() ?? "";
    if (currentText.length > 0) {
      return false;
    }

    this.showSelectMode();
    return true;
  }

  private showSelectMode(): void {
    this.controller.enterSelect(this.currentEditorText());
    if (this.editor) {
      writeEditorText(this.editor, "");
      setEditorFocus(this.editor, false);
    }
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

  private scrollPrompt(delta: number): void {
    this.promptScrollOffset = Math.max(0, Math.min(this.promptScrollOffset + delta, this.promptMaxScrollOffset));
    this.invalidate();
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.controller.mode === "select") {
      const page = Math.max(1, this.promptViewportRows - 1);
      if (matchesKey(data, Key.pageDown)) { this.scrollPrompt(page); return; }
      if (matchesKey(data, Key.pageUp)) { this.scrollPrompt(-page); return; }
      if (matchesKey(data, Key.home) && this.promptMaxScrollOffset > 0) { this.scrollPrompt(-this.promptMaxScrollOffset); return; }
      if (matchesKey(data, Key.end) && this.promptMaxScrollOffset > 0) { this.scrollPrompt(this.promptMaxScrollOffset); return; }
      if (matchesKey(data, Key.ctrl("d")) && this.promptMaxScrollOffset > 0) { this.scrollPrompt(Math.max(1, Math.floor(this.promptViewportRows / 2))); return; }
      if (matchesKey(data, Key.ctrl("u")) && this.promptMaxScrollOffset > 0) { this.scrollPrompt(-Math.max(1, Math.floor(this.promptViewportRows / 2))); return; }
      if (matchesKey(data, this.contextToggleKey as any) && this.contextCollapsible) {
        this.contextExpanded = !this.contextExpanded; this.promptScrollOffset = 0; this.invalidate(); this.tui.requestRender(); return;
      }
    }
    if (this.controller.mode === "freeform" || this.controller.mode === "comment") {
      if (matchesKey(data, Key.escape)) {
        this.showSelectMode();
        return;
      }

      if (this.keybindings.matches(data, "tui.select.cancel")) {
        this.onDone(null);
        return;
      }

      const previousText = this.controller.mode === "freeform" ? this.currentEditorText() : undefined;
      this.ensureEditor().handleInput(data);
      if (this.maybeReturnToSelectModeAfterEmptyFreeform(previousText)) {
        return;
      }
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

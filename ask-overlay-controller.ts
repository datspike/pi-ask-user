import {
  type AskUIResult,
  type BatchQuestion,
  type SingleAskResponse,
  createBatchAnswer,
  createFreeformResponse,
  createSelectionResponse,
} from "./ask-user-core";

type SelectMode = "select";

type PersistedEditorState<EditorMode extends string> = {
  mode: EditorMode;
  text?: string;
};

class KeyedEditorModeState<Key, EditorMode extends string> {
  private currentMode: SelectMode | EditorMode;
  private drafts = new Map<Key, Map<EditorMode, string>>();

  constructor(initialMode: SelectMode | EditorMode = "select") {
    this.currentMode = initialMode;
  }

  get mode(): SelectMode | EditorMode {
    return this.currentMode;
  }

  public setMode(mode: SelectMode | EditorMode): void {
    this.currentMode = mode;
  }

  public getDraft(key: Key, mode: EditorMode): string {
    return this.drafts.get(key)?.get(mode) ?? "";
  }

  public setDraft(key: Key, mode: EditorMode, text: string): void {
    let keyedDrafts = this.drafts.get(key);
    if (!keyedDrafts) {
      keyedDrafts = new Map<EditorMode, string>();
      this.drafts.set(key, keyedDrafts);
    }
    keyedDrafts.set(mode, text);
  }

  public clearDraft(key: Key, mode: EditorMode): void {
    const keyedDrafts = this.drafts.get(key);
    keyedDrafts?.delete(mode);
    if (keyedDrafts && keyedDrafts.size === 0) {
      this.drafts.delete(key);
    }
  }

  public enterEditor(
    key: Key,
    mode: EditorMode,
    options?: {
      persistCurrent?: PersistedEditorState<EditorMode>;
      initialDraft?: string;
    },
  ): string {
    if (options?.persistCurrent && typeof options.persistCurrent.text === "string") {
      this.setDraft(key, options.persistCurrent.mode, options.persistCurrent.text);
    }
    if (typeof options?.initialDraft === "string") {
      this.setDraft(key, mode, options.initialDraft);
    }
    this.currentMode = mode;
    return this.getDraft(key, mode);
  }

  public enterSelect(
    key: Key,
    options?: {
      persistCurrent?: PersistedEditorState<EditorMode>;
    },
  ): void {
    if (options?.persistCurrent && typeof options.persistCurrent.text === "string") {
      this.setDraft(key, options.persistCurrent.mode, options.persistCurrent.text);
    }
    this.currentMode = "select";
  }
}

export type SingleAskMode = "select" | "freeform" | "comment";
export type BatchAskMode = "select" | "freeform";

export type SingleSelectionTransition =
  | {
      kind: "comment";
    }
  | {
      kind: "submit";
      response: SingleAskResponse | null;
    };

const SINGLE_EDITOR_KEY = "__single__";

export class SingleAskController {
  private readonly editorState = new KeyedEditorModeState<string, "freeform" | "comment">("select");
  private pendingSelections: string[] = [];

  get mode(): SingleAskMode {
    return this.editorState.mode as SingleAskMode;
  }

  get selectedOptionsForComment(): string[] {
    return [...this.pendingSelections];
  }

  get freeformDraft(): string {
    return this.editorState.getDraft(SINGLE_EDITOR_KEY, "freeform");
  }

  get commentDraft(): string {
    return this.editorState.getDraft(SINGLE_EDITOR_KEY, "comment");
  }

  public enterSelect(currentEditorText?: string): void {
    if (this.mode === "freeform" || this.mode === "comment") {
      this.editorState.enterSelect(SINGLE_EDITOR_KEY, {
        persistCurrent: {
          mode: this.mode,
          text: currentEditorText,
        },
      });
    } else {
      this.editorState.setMode("select");
    }
    this.pendingSelections = [];
  }

  public enterFreeform(initialDraft?: string, currentEditorText?: string): string {
    const persistCurrent =
      this.mode === "comment"
        ? {
            mode: "comment" as const,
            text: currentEditorText,
          }
        : this.mode === "freeform"
          ? {
              mode: "freeform" as const,
              text: currentEditorText,
            }
          : undefined;

    return this.editorState.enterEditor(SINGLE_EDITOR_KEY, "freeform", {
      persistCurrent,
      initialDraft,
    });
  }

  public submitSelection(selections: string[], wantsComment: boolean): SingleSelectionTransition {
    if (!wantsComment) {
      return {
        kind: "submit",
        response: createSelectionResponse(selections),
      };
    }

    this.pendingSelections = [...selections];
    this.editorState.enterEditor(SINGLE_EDITOR_KEY, "comment", {
      initialDraft: "",
    });
    return { kind: "comment" };
  }

  public submitEditor(text: string): SingleAskResponse | null {
    if (this.mode === "comment") {
      this.editorState.setDraft(SINGLE_EDITOR_KEY, "comment", text);
      return createSelectionResponse(this.pendingSelections, text);
    }

    this.editorState.setDraft(SINGLE_EDITOR_KEY, "freeform", text);
    return createFreeformResponse(text);
  }
}

export class BatchAskController {
  private currentIndex = 0;
  private readonly answers = new Map<string, SingleAskResponse>();
  private readonly editorState = new KeyedEditorModeState<string, "freeform">("select");

  constructor(private readonly questions: BatchQuestion[]) {
    this.restoreModeForCurrentQuestion();
  }

  get mode(): BatchAskMode {
    return this.editorState.mode as BatchAskMode;
  }

  get questionIndex(): number {
    return this.currentIndex;
  }

  public getQuestions(): BatchQuestion[] {
    return this.questions;
  }

  public getCurrentQuestion(): BatchQuestion {
    return this.questions[this.currentIndex]!;
  }

  public getAnswer(questionId: string): SingleAskResponse | undefined {
    return this.answers.get(questionId);
  }

  public getCurrentEditorText(): string {
    const question = this.getCurrentQuestion();
    const existing = this.answers.get(question.id);
    if (existing?.kind === "freeform") {
      return existing.text;
    }
    return this.editorState.getDraft(question.id, "freeform");
  }

  public moveNext(currentEditorText?: string): void {
    if (this.currentIndex < this.questions.length - 1) {
      this.goToQuestion(this.currentIndex + 1, currentEditorText);
    }
  }

  public movePrevious(currentEditorText?: string): void {
    if (this.currentIndex > 0) {
      this.goToQuestion(this.currentIndex - 1, currentEditorText);
    }
  }

  public goToQuestion(index: number, currentEditorText?: string): void {
    this.commitCurrentFreeformInput(currentEditorText);
    this.currentIndex = Math.max(0, Math.min(index, this.questions.length - 1));
    this.restoreModeForCurrentQuestion();
  }

  public enterFreeform(initialDraft?: string): string {
    const question = this.getCurrentQuestion();
    return this.editorState.enterEditor(question.id, "freeform", {
      initialDraft,
    });
  }

  public enterSelect(currentEditorText?: string): void {
    const question = this.getCurrentQuestion();
    if (this.mode === "freeform") {
      this.editorState.enterSelect(question.id, {
        persistCurrent: {
          mode: "freeform",
          text: currentEditorText,
        },
      });
      return;
    }

    this.editorState.setMode("select");
  }

  public saveSelectionAnswer(selections: string[]): AskUIResult | null {
    const question = this.getCurrentQuestion();
    const response = createSelectionResponse(selections);
    if (!response) return null;

    this.answers.set(question.id, response);
    this.editorState.clearDraft(question.id, "freeform");
    return this.afterAnswerSaved();
  }

  public saveEditorAnswer(text: string): AskUIResult | null {
    const question = this.getCurrentQuestion();
    const response = createFreeformResponse(text);

    if (response) {
      this.answers.set(question.id, response);
      this.editorState.setDraft(question.id, "freeform", response.text);
      return this.afterAnswerSaved();
    }

    this.answers.delete(question.id);
    this.editorState.setDraft(question.id, "freeform", text);
    if (question.required) {
      return null;
    }

    return this.afterAnswerSaved();
  }

  public submitBatch(currentEditorText?: string): AskUIResult | null {
    this.commitCurrentFreeformInput(currentEditorText);

    const missingRequiredIndex = this.getMissingRequiredIndex();
    if (missingRequiredIndex >= 0) {
      this.currentIndex = missingRequiredIndex;
      this.restoreModeForCurrentQuestion();
      return null;
    }

    return {
      kind: "batch",
      answers: this.questions.map((question) => createBatchAnswer(question.id, this.answers.get(question.id) ?? null)),
    };
  }

  private getDefaultMode(question: BatchQuestion): BatchAskMode {
    const existing = this.answers.get(question.id);
    if (existing?.kind === "freeform") {
      return "freeform";
    }
    return question.options.length === 0 ? "freeform" : "select";
  }

  private restoreModeForCurrentQuestion(): void {
    this.editorState.setMode(this.getDefaultMode(this.getCurrentQuestion()));
  }

  private commitCurrentFreeformInput(currentEditorText?: string): void {
    if (this.mode !== "freeform" || typeof currentEditorText !== "string") {
      return;
    }

    const questionId = this.getCurrentQuestion().id;
    const response = createFreeformResponse(currentEditorText);
    if (response) {
      this.answers.set(questionId, response);
      this.editorState.setDraft(questionId, "freeform", response.text);
      return;
    }

    const existingAnswer = this.answers.get(questionId);
    if (existingAnswer?.kind === "freeform") {
      this.answers.delete(questionId);
    }
    this.editorState.clearDraft(questionId, "freeform");
  }

  private getMissingRequiredIndex(): number {
    return this.questions.findIndex((question) => question.required && !this.answers.has(question.id));
  }

  private afterAnswerSaved(): AskUIResult | null {
    if (this.currentIndex < this.questions.length - 1) {
      this.goToQuestion(this.currentIndex + 1);
      return null;
    }

    return this.submitBatch();
  }
}

export function readEditorText(editor: unknown): string | undefined {
  const getText = (editor as { getText?: () => unknown } | undefined)?.getText;
  if (typeof getText !== "function") {
    return undefined;
  }
  return String(getText.call(editor) ?? "");
}

export function writeEditorText(editor: unknown, text: string): void {
  const setText = (editor as { setText?: (value: string) => void } | undefined)?.setText;
  if (typeof setText === "function") {
    setText.call(editor, text);
  }
}

export function writeEditorTextIfNeeded(editor: unknown, text: string, shouldWrite: boolean): void {
  if (!shouldWrite) {
    return;
  }
  writeEditorText(editor, text);
}

export function setEditorFocus(editor: unknown, focused: boolean): void {
  if (editor && typeof editor === "object") {
    (editor as { focused?: boolean }).focused = focused;
  }
}

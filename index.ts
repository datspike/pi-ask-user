/**
 * Ask Tool Extension - Interactive question UI for pi-coding-agent
 *
 * Refactored to keep entrypoint/orchestration separate from overlay components.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { isKeyRelease, isKeyRepeat, matchesKey, Text, type OverlayHandle } from "@earendil-works/pi-tui";
import {
  type AskParams,
  type AskResponse,
  type AskToolDetails,
  type AskUIResult,
  type BatchAnswer,
  type BatchQuestion,
  type SingleAskResponse,
  buildCommentPrompt,
  createBatchAnswer,
  createFreeformResponse,
  createSelectionResponse,
  createSkippedBatchAnswer,
  formatBatchAnswerSummary,
  formatOptionsForMessage,
  formatResponseSummary,
  formatSuccessfulResponseContent,
  isBatchParams,
  isCancelledInput,
  isSelectionResponse,
  normalizeBatchQuestions,
  normalizeOptions,
  parseDialogSelections,
  prepareAskArguments,
} from "./ask-user-core";
import { AskComponent } from "./ask-component";
import { BatchAskComponent } from "./batch-ask-component";
import { FREEFORM_SENTINEL } from "./ask-overlay-ui";
import type { QuestionOption } from "./single-select-layout";
import { createDeadline, getRemainingDialogOptions, getRemainingTimeout, showAskOverlay } from "./pi-compat";

type DisplayMode = "overlay" | "inline";
type SingleSelectLayout = "auto" | "list";

/** Builds a flat string enum while remaining compatible with TypeBox shims. */
export function StringEnum<const T extends readonly string[]>(values: T, options?: { description?: string }): any {
  return Type.String({ type: "string", enum: [...values], ...(options?.description ? { description: options.description } : {}) });
}

function resolveDisplayMode(value: unknown): DisplayMode {
  if (value === "overlay" || value === "inline") return value;
  const configured = process.env.PI_ASK_USER_DISPLAY_MODE?.trim().toLowerCase();
  return configured === "inline" ? "inline" : "overlay";
}

type ResolvedShortcut = { spec: string | null; matches: (data: string) => boolean };

function resolveShortcut(value: unknown, envValue: string | undefined, fallback: string): ResolvedShortcut {
  for (const candidate of [typeof value === "string" ? value : undefined, envValue, fallback]) {
    if (candidate === undefined) continue;
    const normalized = candidate.trim().toLowerCase();
    if (["", "off", "none", "disabled", "false"].includes(normalized)) return { spec: null, matches: () => false };
    if (!normalized.startsWith("+") && !normalized.endsWith("+") && !normalized.includes("++")
      && /^[a-z0-9+_\-!@#$%^&*()|~`'\":;,./<>?[\]{}=\\]+$/i.test(normalized)) {
      return { spec: normalized, matches: (data) => matchesKey(data, normalized as any) };
    }
  }
  return { spec: null, matches: () => false };
}

function resolveOverlayToggleKey(value: unknown): ResolvedShortcut {
  return resolveShortcut(value, process.env.PI_ASK_USER_OVERLAY_TOGGLE_KEY, "alt+o");
}

function resolveAllowComment(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  const configured = process.env.PI_ASK_USER_ALLOW_COMMENT?.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(configured ?? "")) return true;
  if (["0", "false", "no", "off"].includes(configured ?? "")) return false;
  return false;
}

function resolveCommentToggleKey(value: unknown): ResolvedShortcut {
  return resolveShortcut(value, process.env.PI_ASK_USER_COMMENT_TOGGLE_KEY, "ctrl+g");
}

function resolveShortcutSet(overlayValue: unknown, commentValue: unknown): { overlay: ResolvedShortcut; comment: ResolvedShortcut; context: string } {
  const overlay = resolveOverlayToggleKey(overlayValue);
  let comment = resolveCommentToggleKey(commentValue);
  // The global overlay listener wins an exact collision; comment remains reachable through its selectable row.
  if (overlay.spec && comment.spec === overlay.spec) comment = { spec: null, matches: () => false };
  const reserved = new Set([overlay.spec, comment.spec].filter((value): value is string => value !== null));
  const context = ["ctrl+e", "ctrl+x", "ctrl+y"].find((key) => !reserved.has(key)) ?? "ctrl+e";
  return { overlay, comment, context };
}

function resolveSingleSelectLayout(value: unknown): SingleSelectLayout {
  if (value === "list" || value === "auto") return value;
  return process.env.PI_ASK_USER_SINGLE_SELECT_LAYOUT?.trim().toLowerCase() === "list" ? "list" : "auto";
}

function parseBooleanPreference(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (["1", "true", "yes", "on"].includes(value.trim().toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.trim().toLowerCase())) return false;
  return undefined;
}

function cancellationText(subject: "question" | "batch", outcome: "cancelled" | "timeout" | "aborted"): string {
  if (subject === "batch") return outcome === "timeout" ? "The clarification batch timed out" : outcome === "aborted" ? "The clarification batch was aborted" : "User cancelled the clarification batch";
  return outcome === "timeout" ? "The question timed out" : outcome === "aborted" ? "The question was aborted" : "User cancelled the question";
}

function interactionOutcome(signal: AbortSignal | undefined, deadline?: number): "cancelled" | "timeout" | "aborted" {
  if (signal?.aborted) return "aborted";
  if (deadline !== undefined && deadline - Date.now() <= 1) return "timeout";
  return "cancelled";
}

async function whileBlocked<T>(pi: ExtensionAPI, action: () => Promise<T>): Promise<T> {
  pi.events.emit("herdr:blocked", { active: true, label: "Waiting for user response" });
  try {
    return await action();
  } finally {
    pi.events.emit("herdr:blocked", { active: false });
  }
}

async function showInteractiveAsk<Result>(
  ui: any,
  signal: AbortSignal | undefined,
  timeout: number | undefined,
  displayMode: DisplayMode,
  overlayToggleKey: ResolvedShortcut,
  factory: Parameters<typeof showAskOverlay<Result>>[3],
): Promise<Result | null | undefined> {
  let overlayHandle: OverlayHandle | undefined;
  let removeInputListener: (() => void) | undefined;
  if (displayMode === "overlay" && overlayToggleKey.spec && typeof ui.onTerminalInput === "function") {
    removeInputListener = ui.onTerminalInput((data: string) => {
      if (!overlayHandle || !overlayToggleKey.matches(data)) return undefined;
      if (!isKeyRepeat(data) && !isKeyRelease(data)) {
        const hidden = !overlayHandle.isHidden();
        overlayHandle.setHidden(hidden);
        if (hidden) ui.notify?.(`ask_user hidden — press ${overlayToggleKey.spec} to reopen`, "info");
      }
      return { consume: true };
    });
  }
  try {
    return await showAskOverlay(ui.custom.bind(ui), signal, timeout, factory, displayMode, (handle) => {
      overlayHandle = handle;
    });
  } finally {
    removeInputListener?.();
  }
}

const BATCH_SKIP_SENTINEL = "Skip this question";

function interactionWasCancelled(signal: AbortSignal | undefined, deadline?: number): boolean {
  return signal?.aborted === true || getRemainingTimeout(deadline) === 0;
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

async function askSingleViaDialogs(
  ui: { select: Function; input: Function },
  question: string,
  context: string | undefined,
  options: QuestionOption[],
  allowMultiple: boolean,
  allowFreeform: boolean,
  allowComment: boolean,
  timeout: number | undefined,
  signal: AbortSignal | undefined,
): Promise<SingleAskResponse | null> {
  const dialogOpts = timeout && timeout > 0
    ? { timeout, ...(signal ? { signal } : {}) }
    : signal ? { signal } : undefined;
  const prompt = context ? `${question}\n\nContext:\n${context}` : question;

  if (allowMultiple) {
    const optionList = formatOptionsForMessage(options);
    const rawSelections = (await ui.input(
      `${prompt}\n\nOptions (select one or more):\n${optionList}`,
      "Type your selection(s)...",
      dialogOpts,
    )) as string | undefined;
    if (signal?.aborted || isCancelledInput(rawSelections)) return null;

    const selections = parseDialogSelections(rawSelections);
    if (selections.length === 0) return null;

    if (!allowComment) {
      if (signal?.aborted) return null;
      return createSelectionResponse(selections);
    }

    const comment = (await ui.input(
      buildCommentPrompt(prompt, selections),
      "Optional comment (press Enter to skip)...",
      dialogOpts,
    )) as string | undefined;
    if (signal?.aborted) return null;
    return createSelectionResponse(selections, comment);
  }

  const selectOptions = options.map((o) => o.title);
  if (allowFreeform) selectOptions.push(FREEFORM_SENTINEL);

  const selected = (await ui.select(prompt, selectOptions, dialogOpts)) as string | undefined;
  if (signal?.aborted || isCancelledInput(selected)) return null;

  if (selected === FREEFORM_SENTINEL) {
    const answer = (await ui.input(prompt, "Type your answer...", dialogOpts)) as string | undefined;
    if (signal?.aborted || isCancelledInput(answer)) return null;
    return createFreeformResponse(answer);
  }

  if (!allowComment) {
    if (signal?.aborted) return null;
    return createSelectionResponse([selected]);
  }

  const comment = (await ui.input(
    buildCommentPrompt(prompt, [selected]),
    "Optional comment (press Enter to skip)...",
    dialogOpts,
  )) as string | undefined;
  if (signal?.aborted) return null;
  return createSelectionResponse([selected], comment);
}

async function askBatchQuestionViaDialogs(
  ui: { select: Function; input: Function },
  title: string | undefined,
  context: string | undefined,
  question: BatchQuestion,
  index: number,
  total: number,
  deadline: number | undefined,
  signal: AbortSignal | undefined,
): Promise<BatchAnswer | null> {
  const prompt = formatBatchPrompt(title, context, question, index, total);

  if (question.options.length === 0) {
    while (true) {
      const dialogOpts = getRemainingDialogOptions(deadline, signal);
      if (dialogOpts === null) return null;
      const answer = (await ui.input(
        prompt,
        question.required ? "Type your answer..." : "Type your answer (press Enter to skip)...",
        dialogOpts,
      )) as string | undefined;
      if (interactionWasCancelled(signal, deadline) || isCancelledInput(answer)) return null;

      const response = createFreeformResponse(answer);
      if (response) return createBatchAnswer(question.id, response);
      if (!question.required) return createSkippedBatchAnswer(question.id);
    }
  }

  if (question.allowMultiple) {
    const optionList = formatOptionsForMessage(question.options);
    while (true) {
      const dialogOpts = getRemainingDialogOptions(deadline, signal);
      if (dialogOpts === null) return null;
      const rawSelections = (await ui.input(
        `${prompt}\n\nOptions (select one or more):\n${optionList}`,
        question.required ? "Type your selection(s)..." : "Type your selection(s) or press Enter to skip...",
        dialogOpts,
      )) as string | undefined;
      if (interactionWasCancelled(signal, deadline) || isCancelledInput(rawSelections)) return null;

      const selections = parseDialogSelections(rawSelections);
      if (interactionWasCancelled(signal, deadline)) return null;
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
    const selectDialogOpts = getRemainingDialogOptions(deadline, signal);
    if (selectDialogOpts === null) return null;
    const selected = (await ui.select(prompt, selectOptions, selectDialogOpts)) as string | undefined;
    if (interactionWasCancelled(signal, deadline) || isCancelledInput(selected)) return null;
    if (selected === BATCH_SKIP_SENTINEL) return createSkippedBatchAnswer(question.id);

    if (selected === FREEFORM_SENTINEL) {
      const inputDialogOpts = getRemainingDialogOptions(deadline, signal);
      if (inputDialogOpts === null) return null;
      const answer = (await ui.input(
        prompt,
        question.required ? "Type your answer..." : "Type your answer (press Enter to skip)...",
        inputDialogOpts,
      )) as string | undefined;
      if (interactionWasCancelled(signal, deadline) || isCancelledInput(answer)) return null;

      const response = createFreeformResponse(answer);
      if (response) return createBatchAnswer(question.id, response);
      if (!question.required) return createSkippedBatchAnswer(question.id);
      continue;
    }

    if (interactionWasCancelled(signal, deadline)) return null;
    return createBatchAnswer(question.id, createSelectionResponse([selected]));
  }
}

async function askBatchViaDialogs(
  ui: { select: Function; input: Function },
  title: string | undefined,
  context: string | undefined,
  questions: BatchQuestion[],
  deadline: number | undefined,
  signal: AbortSignal | undefined,
): Promise<AskResponse | null> {
  const answers: BatchAnswer[] = [];
  for (const [index, question] of questions.entries()) {
    const answer = await askBatchQuestionViaDialogs(ui, title, context, question, index, questions.length, deadline, signal);
    if (interactionWasCancelled(signal, deadline) || answer === null) return null;
    answers.push(answer);
  }

  const dialogOpts = getRemainingDialogOptions(deadline, signal);
  if (dialogOpts === null) return null;
  const submitLabel = (await ui.select(
    `${title ?? "Clarification batch"}\n\nSubmit ${answers.length} answer(s)?`,
    ["Submit answers", "Cancel"],
    dialogOpts,
  )) as string | undefined;

  if (interactionWasCancelled(signal, deadline) || isCancelledInput(submitLabel) || submitLabel !== "Submit answers") return null;
  if (interactionWasCancelled(signal, deadline)) return null;
  return { kind: "batch", answers };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description:
      "Ask the user one focused question or one batch of 2-7 related clarifications after gathering context. Use single mode for one decision gate; use batch mode when several related clarifications are already known up front.",
    promptSnippet:
      "Ask the user one focused question or one batch of related clarifications after gathering context",
    executionMode: "sequential",
    promptGuidelines: [
      "Before calling ask_user, gather evidence with tools and pass a short neutral summary via the context field.",
      "Use single mode for one high-stakes, preference-sensitive, or ambiguous decision boundary.",
      "If several related clarifications are already known up front, prefer one batch call instead of repeated single-question pauses.",
      "Keep batch mode to one topic, 2-7 questions, and non-branching questions whose later answers do not depend on earlier ones.",
      "After ask_user returns, use the answer text in content to restate the outcome and proceed or report blocked status.",
    ],
    parameters: Type.Object({
      mode: Type.Optional(StringEnum(["single", "batch"] as const, { description: "Mode for ask_user. Omit or use 'single' for the default single-question flow. Use 'batch' for a related clarification packet." })),
      question: Type.Optional(Type.String({ description: "The question to ask the user in single-question mode" })),
      title: Type.Optional(Type.String({ description: "Short title shown above the batch questionnaire." })),
      context: Type.Optional(
        Type.String({
          description: "Relevant context to show before the question or batch questions (summary of findings)",
        }),
      ),
      options: Type.Optional(
        Type.Array(
          Type.Object({
            title: Type.String({ description: "Short title for this option" }),
            description: Type.Optional(Type.String({ description: "Longer description explaining this option" })),
          }),
          { description: "List of options for the user to choose from in single-question mode" },
        ),
      ),
      allowMultiple: Type.Optional(Type.Boolean({ description: "Allow selecting multiple options. Default: false" })),
      allowFreeform: Type.Optional(Type.Boolean({ description: "Add a freeform text option. Default: true" })),
      allowComment: Type.Optional(
        Type.Boolean({ description: "Collect an optional comment after selecting one or more options in single-question mode. Default: false" }),
      ),
      displayMode: Type.Optional(StringEnum(["overlay", "inline"] as const, { description: "UI mode. Parameter overrides PI_ASK_USER_DISPLAY_MODE; default: overlay." })),
      singleSelectLayout: Type.Optional(StringEnum(["auto", "list"] as const, { description: "Single-select layout. Parameter overrides PI_ASK_USER_SINGLE_SELECT_LAYOUT; default: auto." })),
      contextExpanded: Type.Optional(Type.Boolean({ description: "Start oversized context expanded. Parameter overrides PI_ASK_USER_CONTEXT_EXPANDED; default: false." })),
      overlayToggleKey: Type.Optional(Type.String({ description: "Overlay hide/show shortcut. Defaults to PI_ASK_USER_OVERLAY_TOGGLE_KEY, then alt+o; use off to disable." })),
      commentToggleKey: Type.Optional(Type.String({ description: "Comment toggle shortcut. Defaults to PI_ASK_USER_COMMENT_TOGGLE_KEY, then ctrl+g." })),
      questions: Type.Optional(
        Type.Array(
          Type.Object({
            id: Type.String({ description: "Stable identifier for this clarification question" }),
            question: Type.String({ description: "The question to ask the user" }),
            options: Type.Optional(
              Type.Array(
                Type.Object({
                  title: Type.String({ description: "Short title for this option" }),
                  description: Type.Optional(Type.String({ description: "Longer description explaining this option" })),
                }),
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
      timeout: Type.Optional(Type.Number({ description: "Auto-dismiss after N milliseconds. The result keeps cancelled=true and reports outcome=timeout." })),
    }),
    prepareArguments: prepareAskArguments,

    async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
      const startedAt = Date.now();
      const params = rawParams as AskParams;
      if ((rawParams as any).mode !== undefined && (rawParams as any).mode !== "single" && (rawParams as any).mode !== "batch") {
        throw new Error(`Unsupported ask_user mode: ${String((rawParams as any).mode)}`);
      }
      const batchDeadline = isBatchParams(params) ? createDeadline(params.timeout, startedAt) : undefined;
      const singleDeadline = !isBatchParams(params) ? createDeadline(params.timeout, startedAt) : undefined;
      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: "Cancelled" }],
          details: { mode: isBatchParams(params) ? "batch" : "single", response: null, cancelled: true, outcome: "aborted" } as AskToolDetails,
        };
      }

      const normalizedContext = params.context?.trim() || undefined;
      const emitFullEvents = parseBooleanPreference(process.env.PI_ASK_USER_EMIT_FULL_EVENTS) ?? false;
      const emitCancelled = (full: Record<string, unknown>, minimal: Record<string, unknown>) =>
        pi.events.emit("ask:cancelled", emitFullEvents ? full : minimal);
      const emitAnswered = (full: Record<string, unknown>, minimal: Record<string, unknown>) =>
        pi.events.emit("ask:answered", emitFullEvents ? full : minimal);

      try {
        if (isBatchParams(params)) {
          if (!Array.isArray(params.questions)) {
            throw new Error("Batch mode requires a questions array.");
          }
          const title = params.title?.trim() || undefined;
          const questions = normalizeBatchQuestions(params.questions);
          if (!ctx.hasUI || !ctx.ui) {
            throw new Error("Ask requires interactive mode.");
          }

          onUpdate?.({
            content: [{ type: "text", text: "Waiting for user input..." }],
            details: { mode: "batch", title, context: normalizedContext, questions, response: null, cancelled: false, outcome: "answered" } as AskToolDetails,
          });

          let result: AskUIResult | null;
          const overlayTimeout = getRemainingTimeout(batchDeadline);
          const customResult = overlayTimeout === 0
            ? null
            : await whileBlocked(pi, () => showInteractiveAsk<AskUIResult>(
                ctx.ui,
                signal,
                overlayTimeout,
                resolveDisplayMode(params.displayMode),
                resolveOverlayToggleKey(params.overlayToggleKey),
                (tui, theme, keybindings, done) => new BatchAskComponent(title, normalizedContext, questions, tui, theme, keybindings, done),
              ));

          if (interactionWasCancelled(signal, batchDeadline)) {
            result = null;
          } else if (customResult !== undefined) {
            result = customResult;
          } else {
            result = await whileBlocked(pi, () => askBatchViaDialogs(ctx.ui, title, normalizedContext, questions, batchDeadline, signal));
          }

          if (interactionWasCancelled(signal, batchDeadline)) {
            result = null;
          }
          if (result === null) {
            emitCancelled({ mode: "batch", title, context: normalizedContext, questions }, { mode: "batch", title });
            return {
              content: [{ type: "text", text: interactionOutcome(signal, batchDeadline) === "timeout" ? "The clarification batch timed out" : interactionOutcome(signal, batchDeadline) === "aborted" ? "The clarification batch was aborted" : "User cancelled the clarification batch" }],
              details: { mode: "batch", title, context: normalizedContext, questions, response: null, cancelled: true, outcome: interactionOutcome(signal, batchDeadline) } as AskToolDetails,
            };
          }

          if (interactionWasCancelled(signal, batchDeadline)) {
            emitCancelled({ mode: "batch", title, context: normalizedContext, questions }, { mode: "batch", title });
            return {
              content: [{ type: "text", text: interactionOutcome(signal, batchDeadline) === "timeout" ? "The clarification batch timed out" : "The clarification batch was aborted" }],
              details: { mode: "batch", title, context: normalizedContext, questions, response: null, cancelled: true, outcome: interactionOutcome(signal, batchDeadline) } as AskToolDetails,
            };
          }
          emitAnswered(
            { mode: "batch", title, context: normalizedContext, questions, response: result },
            { mode: "batch", title, response: { kind: result.kind } },
          );
          return {
            content: [{ type: "text", text: formatSuccessfulResponseContent(result, { title, questions }) }],
            details: {
              mode: "batch",
              title,
              context: normalizedContext,
              questions,
              response: result,
              cancelled: false,
              outcome: "answered",
            } as AskToolDetails,
          };
        }

        const {
          question,
          options: rawOptions = [],
          allowMultiple = false,
          allowFreeform = true,
          allowComment: rawAllowComment,
          displayMode,
          singleSelectLayout,
          contextExpanded: requestedContextExpanded,
          overlayToggleKey,
          commentToggleKey,
          timeout,
        } = params;
        const allowComment = resolveAllowComment(rawAllowComment);
        const shortcuts = resolveShortcutSet(overlayToggleKey, commentToggleKey);
        const normalizedQuestion = question?.trim();
        if (!normalizedQuestion) {
          throw new Error("Single-question mode requires a question string.");
        }
        const options = normalizeOptions(rawOptions);

        if (!ctx.hasUI || !ctx.ui) {
          throw new Error("Ask requires interactive mode.");
        }

        if (options.length === 0) {
          const prompt = normalizedContext ? `${normalizedQuestion}\n\nContext:\n${normalizedContext}` : normalizedQuestion;
          const dialogOpts = timeout && timeout > 0
            ? { timeout, ...(signal ? { signal } : {}) }
            : signal ? { signal } : undefined;
          const answer = await whileBlocked(pi, () => ctx.ui.input(prompt, "Type your answer...", dialogOpts));
          const response = signal?.aborted ? null : createFreeformResponse(answer);

          if (!response) {
            const outcome = interactionOutcome(signal, singleDeadline);
            return {
              content: [{ type: "text", text: cancellationText("question", outcome) }],
              details: { mode: "single", question: normalizedQuestion, context: normalizedContext, options, response: null, cancelled: true, outcome } as AskToolDetails,
            };
          }

          if (signal?.aborted) {
            return {
              content: [{ type: "text", text: "The question was aborted" }],
              details: { mode: "single", question: normalizedQuestion, context: normalizedContext, options, response: null, cancelled: true, outcome: "aborted" } as AskToolDetails,
            };
          }
          emitAnswered(
            { question: normalizedQuestion, context: normalizedContext, response },
            { question: normalizedQuestion, response: { kind: response.kind } },
          );
          return {
            content: [{ type: "text", text: formatSuccessfulResponseContent(response) }],
            details: { mode: "single", question: normalizedQuestion, context: normalizedContext, options, response, cancelled: false, outcome: "answered" } as AskToolDetails,
          };
        }

        onUpdate?.({
          content: [{ type: "text", text: "Waiting for user input..." }],
          details: { mode: "single", question: normalizedQuestion, context: normalizedContext, options, response: null, cancelled: false, outcome: "answered" } as AskToolDetails,
        });

        let result: AskUIResult | null;
        const customResult = await whileBlocked(pi, () => showInteractiveAsk<AskUIResult>(
          ctx.ui,
          signal,
          timeout,
          resolveDisplayMode(displayMode),
          shortcuts.overlay,
          (tui, theme, keybindings, done) => new AskComponent(
            normalizedQuestion,
            normalizedContext,
            options,
            allowMultiple,
            allowFreeform,
            allowComment,
            resolveDisplayMode(displayMode),
            resolveSingleSelectLayout(singleSelectLayout),
            requestedContextExpanded ?? parseBooleanPreference(process.env.PI_ASK_USER_CONTEXT_EXPANDED) ?? false,
            shortcuts.comment.spec,
            shortcuts.context,
            shortcuts.overlay.spec,
            tui,
            theme,
            keybindings,
            done,
          ),
        ));

        if (signal?.aborted) {
          result = null;
        } else if (customResult !== undefined) {
          result = customResult;
        } else {
          result = await askSingleViaDialogs(ctx.ui, normalizedQuestion, normalizedContext, options, allowMultiple, allowFreeform, allowComment, timeout, signal);
        }

        if (signal?.aborted) {
          result = null;
        }
        if (result === null) {
          emitCancelled({ question: normalizedQuestion, context: normalizedContext, options }, { question: normalizedQuestion });
          return {
            content: [{ type: "text", text: interactionOutcome(signal, singleDeadline) === "timeout" ? "The question timed out" : interactionOutcome(signal, singleDeadline) === "aborted" ? "The question was aborted" : "User cancelled the question" }],
            details: { mode: "single", question: normalizedQuestion, context: normalizedContext, options, response: null, cancelled: true, outcome: interactionOutcome(signal, singleDeadline) } as AskToolDetails,
          };
        }

        if (signal?.aborted) {
          emitCancelled({ question: normalizedQuestion, context: normalizedContext, options }, { question: normalizedQuestion });
          return {
            content: [{ type: "text", text: "The question was aborted" }],
            details: { mode: "single", question: normalizedQuestion, context: normalizedContext, options, response: null, cancelled: true, outcome: "aborted" } as AskToolDetails,
          };
        }
        emitAnswered(
          { question: normalizedQuestion, context: normalizedContext, response: result },
          { question: normalizedQuestion, response: { kind: result.kind } },
        );
        return {
          content: [{ type: "text", text: formatSuccessfulResponseContent(result) }],
          details: {
            mode: "single",
            question: normalizedQuestion,
            context: normalizedContext,
            options,
            response: result,
            cancelled: false,
            outcome: "answered",
          } as AskToolDetails,
        };
      } catch (error) {
        if (!signal?.aborted) {
          throw error;
        }
        return {
          content: [{ type: "text", text: "Cancelled" }],
          details: { mode: isBatchParams(params) ? "batch" : "single", response: null, cancelled: true, outcome: "aborted" } as AskToolDetails,
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
        const labels = rawOptions.map((o: unknown) => (typeof o === "string" ? o : (o as QuestionOption)?.title ?? ""));
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

    renderResult(result, options, theme, context) {
      const details = result.details as (AskToolDetails & { error?: string }) | undefined;
      const contentText = result.content
        ?.filter((part: { type?: string; text?: string }) => part?.type === "text")
        .map((part: { text?: string }) => part.text ?? "")
        .join("\n")
        .trim();
      const errorText = details?.error || (context?.isError ? contentText : undefined);

      if (errorText) {
        return new Text(theme.fg("error", `✗ ${errorText}`), 0, 0);
      }

      if (options.isPartial) {
        const waitingText =
          result.content
            ?.filter((part: { type?: string; text?: string }) => part?.type === "text")
            .map((part: { text?: string }) => part.text ?? "")
            .join("\n")
            .trim() || "Waiting for user input...";
        return new Text(theme.fg("muted", waitingText), 0, 0);
      }

      if (!details || details.cancelled || !details.response) {
        const label = details?.outcome === "timeout" ? "Timed out" : details?.outcome === "aborted" ? "Aborted" : "Cancelled";
        return new Text(theme.fg("warning", label), 0, 0);
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

/**
 * Ask Tool Extension - Interactive question UI for pi-coding-agent
 *
 * Refactored to keep entrypoint/orchestration separate from overlay components.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
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
} from "./ask-user-core";
import { AskComponent } from "./ask-component";
import { BatchAskComponent } from "./batch-ask-component";
import { FREEFORM_SENTINEL } from "./ask-overlay-ui";
import type { QuestionOption } from "./single-select-layout";
import { showAskOverlay } from "./pi-compat";

const BATCH_SKIP_SENTINEL = "Skip this question";

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
  timeout?: number,
): Promise<SingleAskResponse | null> {
  const dialogOpts = timeout ? { timeout } : undefined;
  const prompt = context ? `${question}\n\nContext:\n${context}` : question;

  if (allowMultiple) {
    const optionList = formatOptionsForMessage(options);
    const rawSelections = (await ui.input(
      `${prompt}\n\nOptions (select one or more):\n${optionList}`,
      "Type your selection(s)...",
      dialogOpts,
    )) as string | undefined;
    if (isCancelledInput(rawSelections)) return null;

    const selections = parseDialogSelections(rawSelections);
    if (selections.length === 0) return null;

    if (!allowComment) {
      return createSelectionResponse(selections);
    }

    const comment = (await ui.input(
      buildCommentPrompt(prompt, selections),
      "Optional comment (press Enter to skip)...",
      dialogOpts,
    )) as string | undefined;
    return createSelectionResponse(selections, comment);
  }

  const selectOptions = options.map((o) => o.title);
  if (allowFreeform) selectOptions.push(FREEFORM_SENTINEL);

  const selected = (await ui.select(prompt, selectOptions, dialogOpts)) as string | undefined;
  if (isCancelledInput(selected)) return null;

  if (selected === FREEFORM_SENTINEL) {
    const answer = (await ui.input(prompt, "Type your answer...", dialogOpts)) as string | undefined;
    if (isCancelledInput(answer)) return null;
    return createFreeformResponse(answer);
  }

  if (!allowComment) {
    return createSelectionResponse([selected]);
  }

  const comment = (await ui.input(
    buildCommentPrompt(prompt, [selected]),
    "Optional comment (press Enter to skip)...",
    dialogOpts,
  )) as string | undefined;
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
      const answer = (await ui.input(
        prompt,
        question.required ? "Type your answer..." : "Type your answer (press Enter to skip)...",
        dialogOpts,
      )) as string | undefined;
      if (isCancelledInput(answer)) return null;

      const response = createFreeformResponse(answer);
      if (response) return createBatchAnswer(question.id, response);
      if (!question.required) return createSkippedBatchAnswer(question.id);
    }
  }

  if (question.allowMultiple) {
    const optionList = formatOptionsForMessage(question.options);
    while (true) {
      const rawSelections = (await ui.input(
        `${prompt}\n\nOptions (select one or more):\n${optionList}`,
        question.required ? "Type your selection(s)..." : "Type your selection(s) or press Enter to skip...",
        dialogOpts,
      )) as string | undefined;
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
    const selected = (await ui.select(prompt, selectOptions, dialogOpts)) as string | undefined;
    if (isCancelledInput(selected)) return null;
    if (selected === BATCH_SKIP_SENTINEL) return createSkippedBatchAnswer(question.id);

    if (selected === FREEFORM_SENTINEL) {
      const answer = (await ui.input(
        prompt,
        question.required ? "Type your answer..." : "Type your answer (press Enter to skip)...",
        dialogOpts,
      )) as string | undefined;
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
  const submitLabel = (await ui.select(
    `${title ?? "Clarification batch"}\n\nSubmit ${answers.length} answer(s)?`,
    ["Submit answers", "Cancel"],
    dialogOpts,
  )) as string | undefined;

  if (isCancelledInput(submitLabel) || submitLabel !== "Submit answers") return null;
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
    promptGuidelines: [
      "Before calling ask_user, gather evidence with tools and pass a short neutral summary via the context field.",
      "Use single mode for one high-stakes, preference-sensitive, or ambiguous decision boundary.",
      "If several related clarifications are already known up front, prefer one batch call instead of repeated single-question pauses.",
      "Keep batch mode to one topic, 2-7 questions, and non-branching questions whose later answers do not depend on earlier ones.",
      "After ask_user returns, use the answer text in content to restate the outcome and proceed or report blocked status.",
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
              description: Type.Optional(Type.String({ description: "Longer description explaining this option" })),
            }),
          ]),
          { description: "List of options for the user to choose from in single-question mode" },
        ),
      ),
      allowMultiple: Type.Optional(Type.Boolean({ description: "Allow selecting multiple options. Default: false" })),
      allowFreeform: Type.Optional(Type.Boolean({ description: "Add a freeform text option. Default: true" })),
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
                    description: Type.Optional(Type.String({ description: "Longer description explaining this option" })),
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
      timeout: Type.Optional(Type.Number({ description: "Auto-dismiss after N milliseconds. Returns null (cancelled) when expired." })),
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
          const customResult = await showAskOverlay<AskUIResult>(
            ctx.ui.custom.bind(ctx.ui),
            signal,
            timeout,
            (tui, theme, keybindings, done) => new BatchAskComponent(title, normalizedContext, questions, tui, theme, keybindings, done),
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
        const customResult = await showAskOverlay<AskUIResult>(
          ctx.ui.custom.bind(ctx.ui),
          signal,
          timeout,
          (tui, theme, keybindings, done) => new AskComponent(
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
          ),
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
        const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
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

    renderResult(result, options, theme) {
      const details = result.details as (AskToolDetails & { error?: string }) | undefined;

      if (details?.error) {
        return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
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

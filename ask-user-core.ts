import type { QuestionOption } from "./single-select-layout";

export type AskOptionInput = QuestionOption | string;

export interface SingleAskParams {
  mode?: "single";
  question: string;
  context?: string;
  options?: AskOptionInput[];
  allowMultiple?: boolean;
  allowFreeform?: boolean;
  allowComment?: boolean;
  timeout?: number;
}

export interface BatchQuestionInput {
  id: string;
  question: string;
  options?: AskOptionInput[];
  allowMultiple?: boolean;
  allowFreeform?: boolean;
  required?: boolean;
}

export interface BatchAskParams {
  mode: "batch";
  title?: string;
  context?: string;
  questions: BatchQuestionInput[];
  timeout?: number;
}

export type AskParams = SingleAskParams | BatchAskParams;

export type SingleAskResponse =
  | {
      kind: "selection";
      selections: string[];
      comment?: string;
    }
  | {
      kind: "freeform";
      text: string;
    };

export type BatchAnswer =
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

export type AskResponse =
  | SingleAskResponse
  | {
      kind: "batch";
      answers: BatchAnswer[];
    };

export interface BatchQuestion {
  id: string;
  question: string;
  options: QuestionOption[];
  allowMultiple: boolean;
  allowFreeform: boolean;
  required: boolean;
}

export interface AskToolDetails {
  mode: "single" | "batch";
  question?: string;
  title?: string;
  context?: string;
  options?: QuestionOption[];
  questions?: BatchQuestion[];
  response: AskResponse | null;
  cancelled: boolean;
}

export type AskUIResult = AskResponse;

export function normalizeOptions(options: AskOptionInput[]): QuestionOption[] {
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

export function formatOptionsForMessage(options: QuestionOption[]): string {
  return options
    .map((option, index) => {
      const desc = option.description ? ` — ${option.description}` : "";
      return `${index + 1}. ${option.title}${desc}`;
    })
    .join("\n");
}

export function normalizeOptionalComment(text: string | null | undefined): string | undefined {
  const trimmed = text?.trim();
  return trimmed ? trimmed : undefined;
}

export function isBatchParams(params: AskParams): params is BatchAskParams {
  return (params as BatchAskParams).mode === "batch";
}

export function createFreeformResponse(text: string | null | undefined): SingleAskResponse | null {
  const trimmed = text?.trim();
  return trimmed ? { kind: "freeform", text: trimmed } : null;
}

export function createSelectionResponse(selections: string[], comment?: string | null): SingleAskResponse | null {
  const normalizedSelections = selections.map((selection) => selection.trim()).filter(Boolean);
  if (normalizedSelections.length === 0) return null;

  const normalizedComment = normalizeOptionalComment(comment);
  return normalizedComment
    ? { kind: "selection", selections: normalizedSelections, comment: normalizedComment }
    : { kind: "selection", selections: normalizedSelections };
}

export function createSkippedBatchAnswer(id: string): BatchAnswer {
  return { id, kind: "skipped" };
}

export function createBatchAnswer(id: string, response: SingleAskResponse | null): BatchAnswer {
  if (!response) return createSkippedBatchAnswer(id);
  if (response.kind === "freeform") {
    return { id, kind: "freeform", text: response.text };
  }
  return { id, kind: "selection", selections: response.selections };
}

export function formatSingleResponseSummary(response: SingleAskResponse): string {
  if (response.kind === "freeform") return response.text;

  const selections = response.selections.join(", ");
  return response.comment ? `${selections} — ${response.comment}` : selections;
}

export function formatBatchAnswerSummary(answer: BatchAnswer): string {
  if (answer.kind === "skipped") return "Skipped";
  if (answer.kind === "freeform") return answer.text;
  return answer.selections.join(", ");
}

export function formatSuccessfulResponseContent(
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

export function formatResponseSummary(response: AskResponse): string {
  if (response.kind === "batch") {
    return `${response.answers.length} answer(s)`;
  }
  return formatSingleResponseSummary(response);
}

export function normalizeBatchQuestions(rawQuestions: BatchQuestionInput[]): BatchQuestion[] {
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

export function buildCommentPrompt(prompt: string, selections: string[]): string {
  const label = selections.length === 1 ? "Selected option" : "Selected options";
  const lines = selections.map((selection) => `- ${selection}`).join("\n");
  return `${prompt}\n\n${label}:\n${lines}`;
}

export function parseDialogSelections(input: string): string[] {
  return input
    .split(",")
    .map((selection) => selection.trim())
    .filter(Boolean);
}

export function isCancelledInput(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

export function isSelectionResponse(response: AskResponse): response is Extract<AskResponse, { kind: "selection" }> {
  return response.kind === "selection";
}

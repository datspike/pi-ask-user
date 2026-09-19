import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component, KeybindingsManager, MarkdownTheme, OverlayHandle, TUI } from "@earendil-works/pi-tui";

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const ASK_USER_VERSION: string = (require("./package.json") as { version: string }).version;

const ASK_OVERLAY_WIDTH = "92%";
const ASK_OVERLAY_MIN_WIDTH = 40;
const ASK_OVERLAY_OPTIONS = {
  overlay: true,
  overlayOptions: {
    anchor: "center",
    width: ASK_OVERLAY_WIDTH,
    minWidth: ASK_OVERLAY_MIN_WIDTH,
    maxHeight: "85%",
    margin: 1,
  },
} as const;

export function isUsableMarkdownTheme(theme: unknown): theme is MarkdownTheme {
  try {
    const bold = (theme as { bold?: (text: string) => string } | undefined)?.bold;
    return typeof bold === "function" && typeof bold.call(theme, "") === "string";
  } catch {
    return false;
  }
}

export function getOptionalMarkdownTheme(): MarkdownTheme | undefined {
  try {
    const theme = getMarkdownTheme();
    return isUsableMarkdownTheme(theme) ? theme : undefined;
  } catch {
    return undefined;
  }
}

export function createDeadline(timeout: number | undefined, startedAt = Date.now()): number | undefined {
  return timeout && timeout > 0 ? startedAt + timeout : undefined;
}

export function getRemainingTimeout(deadline: number | undefined, now = Date.now()): number | undefined {
  return deadline === undefined ? undefined : Math.max(0, deadline - now);
}

export function getRemainingDialogOptions(
  deadline: number | undefined,
  signal: AbortSignal | undefined,
): { timeout?: number; signal?: AbortSignal } | null | undefined {
  if (signal?.aborted) {
    return null;
  }
  const timeout = getRemainingTimeout(deadline);
  if (timeout === 0) {
    return null;
  }
  if (timeout === undefined && !signal) {
    return undefined;
  }
  return { ...(timeout === undefined ? {} : { timeout }), ...(signal ? { signal } : {}) };
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

function bindOverlayLifecycle<Result>(
  signal: AbortSignal | undefined,
  timeout: number | undefined,
  done: (result: Result | null) => void,
): () => void {
  let cleanedUp = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const onAbort = () => done(null);
  if (signal) {
    signal.addEventListener("abort", onAbort, { once: true });
  }
  if (timeout && timeout > 0) {
    timeoutId = setTimeout(() => done(null), timeout);
  }

  return () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    if (signal) {
      signal.removeEventListener("abort", onAbort);
    }
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  };
}

export async function showAskOverlay<Result>(
  custom: Function,
  signal: AbortSignal | undefined,
  timeout: number | undefined,
  factory: (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: Result | null) => void) => Component,
  displayMode: "overlay" | "inline" = "overlay",
  onHandle?: (handle: OverlayHandle) => void,
): Promise<Result | null | undefined> {
  return custom<Result | null>(
    (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: Result | null) => void) => {
      let cleanup = () => {};
      const finish = (result: Result | null) => {
        cleanup();
        done(result);
      };
      cleanup = bindOverlayLifecycle(signal, timeout, finish);
      return factory(tui, theme, keybindings, finish);
    },
    displayMode === "inline" ? undefined : { ...ASK_OVERLAY_OPTIONS, ...(onHandle ? { onHandle } : {}) },
  );
}

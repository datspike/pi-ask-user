import { getMarkdownTheme, type Theme } from "@mariozechner/pi-coding-agent";
import type { Component, KeybindingsManager, MarkdownTheme, TUI } from "@mariozechner/pi-tui";

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

export function getOptionalMarkdownTheme(): MarkdownTheme | undefined {
  try {
    return getMarkdownTheme();
  } catch {
    return undefined;
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
    ASK_OVERLAY_OPTIONS,
  );
}

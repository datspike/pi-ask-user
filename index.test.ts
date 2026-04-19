import { beforeAll, describe, expect, mock, test } from "bun:test";

let editorInputs: string[] = [];
let editorText = "";
let emittedEvents: Array<{ name: string; payload: any }> = [];

class MockText {
   constructor(private text: string) { }
   render() {
      return [this.text];
   }
   setText(text: string) {
      this.text = text;
   }
}

class MockContainer {
   addChild() { }
   clear() { }
   invalidate() { }
   render() {
      return [];
   }
}

class MockEditor {
   disableSubmit = false;
   onSubmit?: (text: string) => void;

   constructor(_tui: any, theme: any) {
      if (!theme?.borderColor) {
         throw new TypeError("Cannot read properties of undefined (reading 'borderColor')");
      }
   }

   handleInput(data?: string) {
      if (typeof data === "string") {
         editorInputs.push(data);
      }
      if (data === "enter") {
         this.onSubmit?.(editorText);
      }
   }
   getText() {
      return editorText;
   }
   setText(text = "") {
      editorText = text;
   }
}

function createKeybindings(overrides: Partial<Record<string, string[]>> = {}) {
   const bindings: Record<string, string[]> = {
      "tui.input.submit": ["enter"],
      "tui.input.newLine": ["shift+enter"],
      "tui.select.confirm": ["enter"],
      "tui.select.cancel": ["escape", "ctrl+c"],
      "tui.select.up": ["up"],
      "tui.select.down": ["down"],
      "tui.editor.deleteCharBackward": ["backspace"],
      ...overrides,
   };

   return {
      matches(data: string, keybinding: string) {
         return (bindings[keybinding] ?? []).includes(data);
      },
      getKeys(keybinding: string) {
         return bindings[keybinding] ?? [];
      },
   };
}

beforeAll(() => {
   mock.module("@mariozechner/pi-coding-agent", () => ({
      DynamicBorder: class { },
      getMarkdownTheme: () => undefined,
      rawKeyHint: (key: string, description: string) => `${key} ${description}`,
   }));

   mock.module("@mariozechner/pi-tui", () => ({
      Container: MockContainer,
      Editor: MockEditor,
      Key: {
         escape: "escape",
         enter: "enter",
         up: "up",
         down: "down",
         left: "left",
         right: "right",
         space: "space",
         backspace: "backspace",
         ctrl: (key: string) => `ctrl+${key}`,
         shift: (key: string) => `shift+${key}`,
         tab: "tab",
      },
      Markdown: class extends MockText { },
      matchesKey: (data: string, key: string) => data === key,
      Spacer: class { },
      Text: MockText,
      truncateToWidth: (text: string) => text,
      wrapTextWithAnsi: (text: string) => [text],
      decodeKittyPrintable: (data: string) => (data.length === 1 ? data : undefined),
      fuzzyFilter: <T>(items: T[], query: string, getText: (item: T) => string) => {
         const normalized = query.trim().toLowerCase();
         if (!normalized) return items;
         return items.filter((item) => getText(item).toLowerCase().includes(normalized));
      },
   }));

   mock.module("@sinclair/typebox", () => ({
      Type: {
         Object: (value: unknown) => value,
         String: (value?: unknown) => value,
         Optional: (value: unknown) => value,
         Array: (value: unknown) => value,
         Union: (value: unknown) => value,
         Boolean: (value?: unknown) => value,
         Number: (value?: unknown) => value,
      },
   }));
});

type RegisteredTool = {
   execute: (...args: any[]) => Promise<any>;
   renderCall?: (args: any, theme: any) => any;
   renderResult: (result: any, options: any, theme: any) => any;
};

async function setupTool(): Promise<RegisteredTool> {
   const { default: askUserExtension } = await import("./index");
   let registeredTool: RegisteredTool | undefined;
   emittedEvents = [];
   const pi = {
      registerTool(tool: RegisteredTool) {
         registeredTool = tool;
      },
      events: {
         emit(name: string, payload: any) {
            emittedEvents.push({ name, payload });
         },
      },
   } as any;

   askUserExtension(pi);

   if (!registeredTool) {
      throw new Error("Tool was not registered");
   }

   return registeredTool;
}

function createTheme() {
   return {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
   };
}

describe("ask_user", () => {
   test("does not hide the overlay on narrow terminals", async () => {
      const tool = await setupTool();
      let capturedOptions: any;

      await tool.execute(
         "tool-call-id",
         {
            question: "Which option should we use?",
            options: ["A", "B"],
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (_factory: any, options: any) => {
                  capturedOptions = options;
                  return null;
               },
            },
         },
      );

      expect(capturedOptions.overlay).toBe(true);
      expect(capturedOptions.overlayOptions.visible).toBeUndefined();
   });

   test("renders partial updates as waiting state instead of a successful empty answer", async () => {
      const tool = await setupTool();
      let partialUpdate: any;

      await tool.execute(
         "tool-call-id",
         {
            question: "Which option should we use?",
            options: ["A", "B"],
         },
         undefined,
         (update: any) => {
            partialUpdate = update;
         },
         {
            hasUI: true,
            ui: {
               custom: async () => null,
            },
         },
      );

      const component = tool.renderResult(partialUpdate, { expanded: false, isPartial: true }, createTheme()) as any;
      const rendered = component.render(120).join("\n");

      expect(rendered).toContain("Waiting for user input...");
      expect(rendered).not.toContain("✓");
   });

   test("marks each selected option in expanded multi-select results", async () => {
      const tool = await setupTool();
      const component = tool.renderResult(
         {
            content: [{ type: "text", text: "User answered: A, B" }],
            details: {
               question: "Choose one or more",
               options: [{ title: "A" }, { title: "B" }, { title: "C" }],
               response: { kind: "selection", selections: ["A", "B"] },
               cancelled: false,
            },
         },
         { expanded: true, isPartial: false },
         createTheme(),
      ) as any;

      const rendered = component.render(120).join("\n");

      expect(rendered).toContain("● A");
      expect(rendered).toContain("● B");
      expect(rendered).toContain("○ C");
   });

   test("renders selection comments separately in expanded results", async () => {
      const tool = await setupTool();
      const component = tool.renderResult(
         {
            content: [{ type: "text", text: "User answered: Blue" }],
            details: {
               question: "Pick a color",
               options: [{ title: "Red" }, { title: "Blue" }, { title: "Green" }],
               response: { kind: "selection", selections: ["Blue"], comment: "Match the current brand palette." },
               cancelled: false,
            },
         },
         { expanded: true, isPartial: false },
         createTheme(),
      ) as any;

      const rendered = component.render(120).join("\n");

      expect(rendered).toContain("● Blue");
      expect(rendered).toContain("Comment:");
      expect(rendered).toContain("Match the current brand palette.");
   });


   test("enters freeform mode without editor theme crashes", async () => {
      const tool = await setupTool();

      const result = await tool.execute(
         "tool-call-id",
         {
            question: "Which option should we use?",
            options: ["A", "B"],
            allowFreeform: true,
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     () => { },
                  );

                  component.handleInput("down");
                  component.handleInput("down");
                  component.handleInput("enter");

                  return null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(result.details.cancelled).toBe(true);
   });

   test("uses shared confirm keybinding in single-select mode", async () => {
      const tool = await setupTool();

      const result = await tool.execute(
         "tool-call-id",
         {
            question: "Which option should we use?",
            options: ["A", "B"],
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  let resolved: string | null | undefined;
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings({ "tui.select.confirm": ["x"] }),
                     (value: string | null) => {
                        resolved = value;
                     },
                  );

                  component.handleInput("x");
                  return resolved ?? null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(result.details.response).toEqual({ kind: "selection", selections: ["A"] });
      expect(result.details.cancelled).toBe(false);
   });

   test("forwards ctrl+enter to the editor instead of submitting freeform mode", async () => {
      const tool = await setupTool();
      editorInputs = [];
      editorText = "draft answer";

      const result = await tool.execute(
         "tool-call-id",
         {
            question: "Which option should we use?",
            options: ["A", "B"],
            allowFreeform: true,
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  let resolved: string | null | undefined;
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     (value: string | null) => {
                        resolved = value;
                     },
                  );

                  component.handleInput("down");
                  component.handleInput("down");
                  component.handleInput("enter");
                  component.handleInput("ctrl+enter");

                  return resolved ?? null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(result.details.cancelled).toBe(true);
      expect(editorInputs).toEqual(["ctrl+enter"]);
   });

   test("starts direct freeform entry from typed input in single-select mode", async () => {
      const tool = await setupTool();
      editorText = "";

      const result = await tool.execute(
         "tool-call-id",
         {
            question: "Which option should we use?",
            options: ["Alpha", "Beta", "Gamma"],
            allowFreeform: true,
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  let resolved: string | null | undefined;
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     (value: string | null) => {
                        resolved = value;
                     },
                  );

                  component.handleInput("b");
                  expect(editorText).toBe("b");
                  component.handleInput("enter");
                  return resolved ?? null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(result.details.response).toEqual({ kind: "freeform", text: "b" });
      expect(result.details.cancelled).toBe(false);
   });

   test("does not advertise type-to-filter in single-select help text", async () => {
      const tool = await setupTool();
      let helpText = "";

      await tool.execute(
         "tool-call-id",
         {
            question: "Which option should we use?",
            options: ["Chrome", "Firefox", "Safari"],
            allowFreeform: true,
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     () => { },
                  );

                  helpText = (component as any).helpText.render().join("\n");
                  expect(component.render(100).join("\n")).not.toContain("type to filter");
                  return null;
               },
            },
         },
      );

      expect(helpText).toContain("type custom answer");
      expect(helpText).not.toContain("type filter");
   });

   test("keeps non-freeform single-select option-driven when printable input is typed", async () => {
      const tool = await setupTool();

      const result = await tool.execute(
         "tool-call-id",
         {
            question: "Which option should we use?",
            options: ["Alpha", "Beta 7", "Gamma"],
            allowFreeform: false,
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  let resolved: string | null | undefined;
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     (value: string | null) => {
                        resolved = value;
                     },
                  );

                  component.handleInput("7");
                  component.handleInput("b");
                  component.handleInput("enter");
                  return resolved ?? null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(result.details.response).toEqual({ kind: "selection", selections: ["Alpha"] });
      expect(result.details.cancelled).toBe(false);
   });

   test("still supports explicit freeform selection from the option list", async () => {
      const tool = await setupTool();
      editorText = "custom from editor";
      editorInputs = [];

      const result = await tool.execute(
         "tool-call-id",
         {
            question: "Which option should we use?",
            options: ["Alpha", "Beta"],
            allowFreeform: true,
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  let resolved: string | null | undefined;
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     (value: string | null) => {
                        resolved = value;
                     },
                  );

                  component.handleInput("down");
                  component.handleInput("down");
                  component.handleInput("enter");
                  component.handleInput("enter");
                  return resolved ?? null;
               },
            },
         },
      );

      const answeredEvent = emittedEvents.find((event) => event.name === "ask:answered");

      expect(result.isError).not.toBe(true);
      expect(result.details.response).toEqual({ kind: "freeform", text: "custom from editor" });
      expect(result.details.cancelled).toBe(false);
      expect(answeredEvent?.payload.response).toEqual({ kind: "freeform", text: "custom from editor" });
      expect(editorInputs).toEqual(["enter"]);
   });

   test("preserves typed digits when starting from the explicit freeform row in single-select", async () => {
      const tool = await setupTool();
      editorText = "";

      const result = await tool.execute(
         "tool-call-id",
         {
            question: "Which option should we use?",
            options: ["Alpha", "Beta"],
            allowFreeform: true,
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  let resolved: string | null | undefined;
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     (value: string | null) => {
                        resolved = value;
                     },
                  );

                  component.handleInput("down");
                  component.handleInput("down");
                  component.handleInput("1");
                  expect(editorText).toBe("1");
                  component.handleInput("enter");
                  return resolved ?? null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(result.details.response).toEqual({ kind: "freeform", text: "1" });
      expect(result.details.cancelled).toBe(false);
   });

   test("preserves typed input when starting from the explicit freeform row in multi-select", async () => {
      const tool = await setupTool();
      editorText = "";

      const result = await tool.execute(
         "tool-call-id",
         {
            question: "Which options should we use?",
            options: ["Alpha", "Beta"],
            allowMultiple: true,
            allowFreeform: true,
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  let resolved: string | null | undefined;
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     (value: string | null) => {
                        resolved = value;
                     },
                  );

                  component.handleInput("down");
                  component.handleInput("down");
                  component.handleInput("x");
                  expect(editorText).toBe("x");
                  component.handleInput("enter");
                  return resolved ?? null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(result.details.response).toEqual({ kind: "freeform", text: "x" });
      expect(result.details.cancelled).toBe(false);
   });

   test("shows the remapped cancel key in freeform help text", async () => {
      const tool = await setupTool();
      let helpText = "";

      const result = await tool.execute(
         "tool-call-id",
         {
            question: "Which option should we use?",
            options: ["Alpha", "Beta"],
            allowFreeform: true,
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings({ "tui.select.cancel": ["q"] }),
                     () => { },
                  );

                  component.handleInput("down");
                  component.handleInput("down");
                  component.handleInput("enter");
                  helpText = (component as any).helpText.render().join("\n");
                  return null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(helpText).toContain("q cancel");
      expect(helpText).not.toContain("ctrl+c cancel");
   });

   test("renders a details pane for wide single-select layouts", async () => {
      const tool = await setupTool();
      let rendered = "";

      const result = await tool.execute(
         "tool-call-id",
         {
            question: "Which option should we use?",
            options: [
               { title: "Alpha", description: "The alpha option keeps the rollout conservative." },
               { title: "Beta", description: "The beta option favors faster iteration." },
            ],
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     () => { },
                  );
                  rendered = ((component as any).singleSelectList as any).render(120).join("\n");
                  return null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(rendered).toContain("## Alpha");
      expect(rendered).toContain("The alpha option keeps the rollout conservative.");
   });

   test("shows a custom response preview in the wide details pane", async () => {
      const tool = await setupTool();
      let rendered = "";

      const result = await tool.execute(
         "tool-call-id",
         {
            question: "Which option should we use?",
            options: ["Alpha", "Beta"],
            allowFreeform: true,
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     () => { },
                  );
                  component.handleInput("down");
                  component.handleInput("down");
                  rendered = ((component as any).singleSelectList as any).render(120).join("\n");
                  return null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(rendered).toContain("Custom response");
      expect(rendered).toContain("Open the editor to write **any** answer.");
   });

   test("falls back to the single-column list on narrow widths", async () => {
      const tool = await setupTool();
      let rendered = "";

      const result = await tool.execute(
         "tool-call-id",
         {
            question: "Which option should we use?",
            options: [
               { title: "Alpha", description: "The alpha option keeps the rollout conservative." },
               { title: "Beta", description: "The beta option favors faster iteration." },
            ],
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     () => { },
                  );
                  rendered = ((component as any).singleSelectList as any).render(60).join("\n");
                  return null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(rendered).not.toContain("Details");
      expect(rendered).not.toContain(" │ ");
      expect(rendered).toContain("The alpha option keeps the rollout conservative.");
   });
   test("submits immediately when the comment toggle is off", async () => {
      const tool = await setupTool();

      const result = await tool.execute(
         "tool-call-id",
         {
            question: "Which option should we use?",
            options: ["Alpha", "Beta"],
            allowComment: true,
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  let resolved: any;
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     (value: any) => {
                        resolved = value;
                     },
                  );

                  component.handleInput("enter");
                  return resolved ?? null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(result.details.response).toEqual({ kind: "selection", selections: ["Alpha"] });
      expect(result.details.cancelled).toBe(false);
   });

   test("toggles extra context with the ctrl+g key and shows it in help text", async () => {
      const tool = await setupTool();
      let renderedBefore = "";
      let renderedAfter = "";
      let helpText = "";

      const result = await tool.execute(
         "tool-call-id",
         {
            question: "Which option should we use?",
            options: ["Alpha", "Beta"],
            allowComment: true,
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     () => { },
                  );

                  renderedBefore = ((component as any).singleSelectList as any).render(80).join("\n");
                  helpText = (component as any).helpText.render().join("\n");
                  component.handleInput("ctrl+g");
                  renderedAfter = ((component as any).singleSelectList as any).render(80).join("\n");
                  return null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(renderedBefore).toContain("[ ] Add extra context after selection");
      expect(renderedAfter).toContain("[✓] Add extra context after selection");
      expect(helpText).toContain("ctrl+g toggle context");
   });


   test("collects an optional comment after a single selection before resolving", async () => {
      const tool = await setupTool();

      const result = await tool.execute(
         "tool-call-id",
         {
            question: "Which option should we use?",
            options: ["Alpha", "Beta"],
            allowComment: true,
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  let resolved: any;
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     (value: any) => {
                        resolved = value;
                     },
                  );

                  component.handleInput("ctrl+g");
                  component.handleInput("enter");
                  expect(resolved).toBeUndefined();
                  editorText = "Needs audit logging before rollout.";
                  component.handleInput("enter");
                  return resolved ?? null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(result.details.response).toEqual({
         kind: "selection",
         selections: ["Alpha"],
         comment: "Needs audit logging before rollout.",
      });
      expect(result.details.cancelled).toBe(false);
   });

   test("collects an optional comment for multi-select answers", async () => {
      const tool = await setupTool();

      const result = await tool.execute(
         "tool-call-id",
         {
            question: "Which options should we use?",
            options: ["Alpha", "Beta", "Gamma"],
            allowMultiple: true,
            allowComment: true,
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  let resolved: any;
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     (value: any) => {
                        resolved = value;
                     },
                  );

                  component.handleInput("space");
                  component.handleInput("down");
                  component.handleInput("down");
                  component.handleInput("space");
                  component.handleInput("ctrl+g");
                  component.handleInput("enter");
                  expect(resolved).toBeUndefined();
                  editorText = "Roll out both behind the same flag.";
                  component.handleInput("enter");
                  return resolved ?? null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(result.details.response).toEqual({
         kind: "selection",
         selections: ["Alpha", "Gamma"],
         comment: "Roll out both behind the same flag.",
      });
      expect(result.details.cancelled).toBe(false);
   });

   test("rejects invalid batch requests before starting interaction", async () => {
      const tool = await setupTool();

      const result = await tool.execute(
         "tool-call-id",
         {
            mode: "batch",
            title: "Clarify scope",
            questions: [{ id: "only", question: "Just one question" }],
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async () => {
                  throw new Error("custom() should not be called for invalid batch payloads");
               },
            },
         },
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Batch mode requires between 2 and 7 questions");
   });

   test("completes a batch clarification flow in the overlay", async () => {
      const tool = await setupTool();
      let rendered = "";

      const result = await tool.execute(
         "tool-call-id",
         {
            mode: "batch",
            title: "Clarify scope",
            context: "Need a few details before implementation.",
            questions: [
               { id: "surface", question: "Which surface is in scope?", options: ["Overlay", "Fallback"] },
               { id: "compat", question: "Must the current behavior stay exact?", options: ["Yes", "No"] },
            ],
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  let resolved: any;
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     (value: any) => {
                        resolved = value;
                     },
                  );

                  component.handleInput("enter");
                  rendered = component.render(100).join("\n");
                  component.handleInput("enter");
                  component.handleInput("ctrl+s");
                  return resolved ?? null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(result.details.mode).toBe("batch");
      expect(result.details.response).toEqual({
         kind: "batch",
         answers: [
            { id: "surface", kind: "selection", selections: ["Overlay"] },
            { id: "compat", kind: "selection", selections: ["Yes"] },
         ],
      });
      expect(rendered).toContain("Questions (2/2)");
      expect(rendered).toContain("1. Which surface is in scope?");
      expect(rendered).toContain("2. Must the current behavior stay exact?");
   });

   test("pressing enter on the last batch multi-select question saves and submits the batch", async () => {
      const tool = await setupTool();

      const result = await tool.execute(
         "tool-call-id",
         {
            mode: "batch",
            title: "Clarify scope",
            questions: [
               { id: "surface", question: "Which surface is in scope?", options: ["Overlay", "Fallback"] },
               { id: "targets", question: "Which targets are in scope?", options: ["One", "Two", "Three", "Four"], allowMultiple: true },
            ],
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  let resolved: any;
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     (value: any) => {
                        resolved = value;
                     },
                  );

                  component.handleInput("enter");
                  component.handleInput("down");
                  component.handleInput("down");
                  component.handleInput("down");
                  component.handleInput("space");
                  component.handleInput("enter");
                  return resolved ?? null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(result.details.response).toEqual({
         kind: "batch",
         answers: [
            { id: "surface", kind: "selection", selections: ["Overlay"] },
            { id: "targets", kind: "selection", selections: ["Four"] },
         ],
      });
   });

   test("supports left and right arrow navigation between batch questions without losing saved answers", async () => {
      const tool = await setupTool();
      let renderedOnReturn = "";

      const result = await tool.execute(
         "tool-call-id",
         {
            mode: "batch",
            title: "Clarify scope",
            questions: [
               { id: "surface", question: "Which surface is in scope?", options: ["Overlay", "Fallback"] },
               { id: "compat", question: "Must the current behavior stay exact?", options: ["Yes", "No"] },
            ],
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  let resolved: any;
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     (value: any) => {
                        resolved = value;
                     },
                  );

                  component.handleInput("enter");
                  component.handleInput("left");
                  renderedOnReturn = component.render(100).join("\n");
                  component.handleInput("right");
                  component.handleInput("enter");
                  component.handleInput("ctrl+s");
                  return resolved ?? null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(result.details.response).toEqual({
         kind: "batch",
         answers: [
            { id: "surface", kind: "selection", selections: ["Overlay"] },
            { id: "compat", kind: "selection", selections: ["Yes"] },
         ],
      });
      expect(renderedOnReturn).toContain("Questions (1/2)");
      expect(renderedOnReturn).toContain("Q1. Which surface is in scope?");
      expect(renderedOnReturn).toContain("Overlay");
   });

   test("commits a non-empty batch freeform draft when arrow navigation leaves the question", async () => {
      const tool = await setupTool();
      let renderedOnReturn = "";

      const result = await tool.execute(
         "tool-call-id",
         {
            mode: "batch",
            title: "Clarify scope",
            questions: [
               { id: "notes", question: "Anything else I should optimize for?", options: [], allowMultiple: false, allowFreeform: true, required: false },
               { id: "compat", question: "Must the current behavior stay exact?", options: [], allowMultiple: false, allowFreeform: true, required: false },
            ],
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  let resolved: any;
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     (value: any) => {
                        resolved = value;
                     },
                  );

                  component.render(100);
                  editorText = "Keep the existing keyboard flow.";
                  component.handleInput("right");
                  component.handleInput("left");
                  renderedOnReturn = component.render(100).join("\n");
                  component.handleInput("ctrl+s");
                  return resolved ?? null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(result.details.response).toEqual({
         kind: "batch",
         answers: [
            { id: "notes", kind: "freeform", text: "Keep the existing keyboard flow." },
            { id: "compat", kind: "skipped" },
         ],
      });
      expect(renderedOnReturn).toContain("Questions (1/2)");
      expect(renderedOnReturn).toContain("Anything else I should optimize for? — Keep the existing keyboard flow.");
   });

   test("does not create a batch freeform answer when arrow navigation leaves an empty editor", async () => {
      const tool = await setupTool();
      let renderedOnReturn = "";

      const result = await tool.execute(
         "tool-call-id",
         {
            mode: "batch",
            title: "Clarify scope",
            questions: [
               { id: "notes", question: "Anything else I should optimize for?", options: [], allowMultiple: false, allowFreeform: true, required: false },
               { id: "compat", question: "Must the current behavior stay exact?", options: [], allowMultiple: false, allowFreeform: true, required: false },
            ],
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  let resolved: any;
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     (value: any) => {
                        resolved = value;
                     },
                  );

                  component.render(100);
                  editorText = "";
                  component.handleInput("right");
                  component.handleInput("left");
                  renderedOnReturn = component.render(100).join("\n");
                  component.handleInput("ctrl+s");
                  return resolved ?? null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(result.details.response).toEqual({
         kind: "batch",
         answers: [
            { id: "notes", kind: "skipped" },
            { id: "compat", kind: "skipped" },
         ],
      });
      expect(renderedOnReturn).toContain("Questions (1/2)");
      expect(renderedOnReturn).toContain("Anything else I should optimize for? — optional");
      expect(renderedOnReturn).not.toContain("Keep the existing keyboard flow.");
   });

   test("keeps an existing batch selection answer when an empty freeform draft is abandoned", async () => {
      const tool = await setupTool();
      let renderedOnReturn = "";

      const result = await tool.execute(
         "tool-call-id",
         {
            mode: "batch",
            title: "Clarify scope",
            questions: [
               { id: "surface", question: "Which surface is in scope?", options: ["Overlay", "Fallback"], allowFreeform: true, required: true },
               { id: "compat", question: "Must the current behavior stay exact?", options: ["Yes", "No"], required: false },
            ],
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  let resolved: any;
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     (value: any) => {
                        resolved = value;
                     },
                  );

                  component.handleInput("enter");
                  component.handleInput("right");
                  component.handleInput("left");
                  component.handleInput("x");
                  expect(editorText).toBe("x");
                  editorText = "";
                  component.handleInput("right");
                  component.handleInput("left");
                  renderedOnReturn = component.render(100).join("\n");
                  component.handleInput("ctrl+s");
                  return resolved ?? null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(result.details.response).toEqual({
         kind: "batch",
         answers: [
            { id: "surface", kind: "selection", selections: ["Overlay"] },
            { id: "compat", kind: "skipped" },
         ],
      });
      expect(renderedOnReturn).toContain("Which surface is in scope? — Overlay");
      expect(renderedOnReturn).not.toContain("Which surface is in scope? — pending");
   });

   test("shows arrow-key hints in the batch overlay help text", async () => {
      const tool = await setupTool();
      let rendered = "";

      await tool.execute(
         "tool-call-id",
         {
            mode: "batch",
            title: "Clarify scope",
            questions: [
               { id: "surface", question: "Which surface is in scope?", options: ["Overlay", "Fallback"] },
               { id: "compat", question: "Must the current behavior stay exact?", options: ["Yes", "No"] },
            ],
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     () => null,
                  );

                  rendered = component.render(100).join("\n");
                  return null;
               },
            },
         },
      );

      expect(rendered).toContain("←→ switch question");
      expect(rendered).toContain("ctrl+n next");
      expect(rendered).toContain("ctrl+p prev");
   });

   test("keeps the unanswered required batch question active when submit is attempted early", async () => {
      const tool = await setupTool();
      let rendered = "";

      const result = await tool.execute(
         "tool-call-id",
         {
            mode: "batch",
            title: "Clarify scope",
            questions: [
               { id: "surface", question: "Which surface is in scope?", options: ["Overlay", "Fallback"] },
               { id: "compat", question: "Must the current behavior stay exact?", options: ["Yes", "No"] },
            ],
         },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     () => { },
                  );

                  component.handleInput("enter");
                  component.handleInput("ctrl+s");
                  rendered = component.render(100).join("\n");
                  return null;
               },
            },
         },
      );

      expect(result.details.cancelled).toBe(true);
      expect(rendered).toContain("Q2. Must the current behavior stay exact?");
      expect(rendered).toContain("pending");
   });

   test("renders expanded batch results with explicit skipped answers", async () => {
      const tool = await setupTool();
      const component = tool.renderResult(
         {
            content: [{ type: "text", text: "User answered: 3 answer(s)" }],
            details: {
               mode: "batch",
               title: "Clarify scope",
               context: "Need a few details before implementation.",
               questions: [
                  { id: "surface", question: "Which surface is in scope?", options: [], allowMultiple: false, allowFreeform: true, required: true },
                  { id: "compat", question: "Must the current behavior stay exact?", options: [], allowMultiple: false, allowFreeform: true, required: true },
                  { id: "notes", question: "Anything else?", options: [], allowMultiple: false, allowFreeform: true, required: false },
               ],
               response: {
                  kind: "batch",
                  answers: [
                     { id: "surface", kind: "selection", selections: ["Overlay"] },
                     { id: "compat", kind: "freeform", text: "Mostly yes" },
                     { id: "notes", kind: "skipped" },
                  ],
               },
               cancelled: false,
            },
         },
         { expanded: true, isPartial: false },
         createTheme(),
      ) as any;

      const rendered = component.render(120).join("\n");

      expect(rendered).toContain("Batch: Clarify scope");
      expect(rendered).toContain("Q1: Which surface is in scope?");
      expect(rendered).toContain("Overlay");
      expect(rendered).toContain("Q3: Anything else?");
      expect(rendered).toContain("Skipped");
   });


   describe("RPC fallback (custom() returns undefined)", () => {
      test("single-select falls back to ctx.ui.select()", async () => {
         const tool = await setupTool();
         let selectTitle = "";
         let selectOptions: string[] = [];

         const result = await tool.execute(
            "tool-call-id",
            {
               question: "Pick a color",
               options: ["Red", "Blue"],
               allowFreeform: false,
            },
            undefined,
            undefined,
            {
               hasUI: true,
               ui: {
                  custom: async () => undefined,
                  select: async (title: string, opts: string[]) => {
                     selectTitle = title;
                     selectOptions = opts;
                     return "Blue";
                  },
                  input: async () => undefined,
               },
            },
         );

         expect(result.isError).not.toBe(true);
         expect(result.details.response).toEqual({ kind: "selection", selections: ["Blue"] });
         expect(result.details.cancelled).toBe(false);
         expect(result.content[0].text).toBe("User answered: Blue");
         expect(selectTitle).toContain("Pick a color");
         expect(selectOptions).toEqual(["Red", "Blue"]);
      });

      test("freeform-only result content includes the typed answer", async () => {
         const tool = await setupTool();

         const result = await tool.execute(
            "tool-call-id",
            {
               question: "What color should we use?",
            },
            undefined,
            undefined,
            {
               hasUI: true,
               ui: {
                  input: async () => "Purple",
               },
            },
         );

         expect(result.isError).not.toBe(true);
         expect(result.details.response).toEqual({ kind: "freeform", text: "Purple" });
         expect(result.details.cancelled).toBe(false);
         expect(result.content[0].text).toBe("User answered: Purple");
      });

      test("single-select with freeform appends sentinel option", async () => {
         const tool = await setupTool();
         let selectOptions: string[] = [];

         const result = await tool.execute(
            "tool-call-id",
            {
               question: "Pick a color",
               options: ["Red", "Blue"],
               allowFreeform: true,
            },
            undefined,
            undefined,
            {
               hasUI: true,
               ui: {
                  custom: async () => undefined,
                  select: async (_title: string, opts: string[]) => {
                     selectOptions = opts;
                     return "Red";
                  },
                  input: async () => undefined,
               },
            },
         );

         expect(result.isError).not.toBe(true);
         expect(result.details.response).toEqual({ kind: "selection", selections: ["Red"] });
         // Last option should be the freeform sentinel
         expect(selectOptions).toHaveLength(3);
         expect(selectOptions[2]).toContain("Type custom response");
      });

      test("selecting freeform sentinel follows up with input()", async () => {
         const tool = await setupTool();
         let inputCalled = false;
         const sentinel = "\u270f\ufe0f Type custom response...";

         const result = await tool.execute(
            "tool-call-id",
            {
               question: "Pick a color",
               options: ["Red", "Blue"],
               allowFreeform: true,
            },
            undefined,
            undefined,
            {
               hasUI: true,
               ui: {
                  custom: async () => undefined,
                  select: async () => sentinel,
                  input: async () => {
                     inputCalled = true;
                     return "Purple";
                  },
               },
            },
         );

         expect(result.isError).not.toBe(true);
         expect(inputCalled).toBe(true);
         expect(result.details.response).toEqual({ kind: "freeform", text: "Purple" });
      });

      test("multi-select degrades to input() with options in prompt", async () => {
         const tool = await setupTool();
         let inputTitle = "";

         const result = await tool.execute(
            "tool-call-id",
            {
               question: "Pick colors",
               options: ["Red", "Blue", "Green"],
               allowMultiple: true,
            },
            undefined,
            undefined,
            {
               hasUI: true,
               ui: {
                  custom: async () => undefined,
                  select: async () => undefined,
                  input: async (title: string) => {
                     inputTitle = title;
                     return "Red, Green";
                  },
               },
            },
         );

         expect(result.isError).not.toBe(true);
         expect(result.details.response).toEqual({ kind: "selection", selections: ["Red", "Green"] });
         // Prompt should list the options for the user
         expect(inputTitle).toContain("1. Red");
         expect(inputTitle).toContain("2. Blue");
         expect(inputTitle).toContain("3. Green");
      });

      test("single-select can collect an optional comment after choosing an option", async () => {
         const tool = await setupTool();
         let inputCalls = 0;

         const result = await tool.execute(
            "tool-call-id",
            {
               question: "Pick a color",
               options: ["Red", "Blue"],
               allowComment: true,
            },
            undefined,
            undefined,
            {
               hasUI: true,
               ui: {
                  custom: async () => undefined,
                  select: async () => "Blue",
                  input: async () => {
                     inputCalls += 1;
                     return "Keep it aligned with the settings screen.";
                  },
               },
            },
         );

         expect(inputCalls).toBe(1);
         expect(result.isError).not.toBe(true);
         expect(result.details.response).toEqual({
            kind: "selection",
            selections: ["Blue"],
            comment: "Keep it aligned with the settings screen.",
         });
         expect(result.details.cancelled).toBe(false);
      });


      test("batch mode falls back to a single tool-owned clarification loop", async () => {
         const tool = await setupTool();
         let selectCalls = 0;
         let inputCalls = 0;

         const result = await tool.execute(
            "tool-call-id",
            {
               mode: "batch",
               title: "Clarify scope",
               context: "Need a few details before implementation.",
               questions: [
                  { id: "surface", question: "Which surface is in scope?", options: ["Overlay", "Fallback"] },
                  { id: "notes", question: "Anything else I should optimize for?", required: false },
               ],
            },
            undefined,
            undefined,
            {
               hasUI: true,
               ui: {
                  custom: async () => undefined,
                  select: async (_title: string, opts: string[]) => {
                     selectCalls += 1;
                     if (selectCalls === 1) return "Fallback";
                     expect(opts).toEqual(["Submit answers", "Cancel"]);
                     return "Submit answers";
                  },
                  input: async (title: string) => {
                     inputCalls += 1;
                     expect(title).toContain("[2/2] Anything else I should optimize for?");
                     return "";
                  },
               },
            },
         );

         expect(result.isError).not.toBe(true);
         expect(inputCalls).toBe(1);
         expect(result.details.mode).toBe("batch");
         expect(result.details.response).toEqual({
            kind: "batch",
            answers: [
               { id: "surface", kind: "selection", selections: ["Fallback"] },
               { id: "notes", kind: "skipped" },
            ],
         });
         expect(result.content[0].text).toBe(
            "User answered the clarification batch (Clarify scope):\n- Which surface is in scope?: Fallback\n- Anything else I should optimize for?: Skipped",
         );
      });

      test("emits batch cancellation metadata when fallback batch mode is cancelled", async () => {
         const tool = await setupTool();

         const result = await tool.execute(
            "tool-call-id",
            {
               mode: "batch",
               title: "Clarify scope",
               questions: [
                  { id: "surface", question: "Which surface is in scope?", options: ["Overlay", "Fallback"] },
                  { id: "compat", question: "Must the current behavior stay exact?", options: ["Yes", "No"] },
               ],
            },
            undefined,
            undefined,
            {
               hasUI: true,
               ui: {
                  custom: async () => undefined,
                  select: async () => undefined,
                  input: async () => undefined,
               },
            },
         );

         const cancelledEvent = emittedEvents.find((event) => event.name === "ask:cancelled");

         expect(result.details.cancelled).toBe(true);
         expect(result.details.response).toBeNull();
         expect(cancelledEvent?.payload.mode).toBe("batch");
         expect(cancelledEvent?.payload.questions).toHaveLength(2);
      });

      test("single-question overlay behavior is unchanged when arrow keys are pressed", async () => {
         const tool = await setupTool();

         const result = await tool.execute(
            "tool-call-id",
            {
               question: "Pick a color",
               options: ["Red", "Blue"],
               allowFreeform: false,
            },
            undefined,
            undefined,
            {
               hasUI: true,
               ui: {
                  custom: async (factory: any) => {
                     let resolved: any;
                     const component = factory(
                        { requestRender() { }, terminal: { rows: 24 } },
                        createTheme(),
                        createKeybindings(),
                        (value: any) => {
                           resolved = value;
                        },
                     );

                     component.handleInput("right");
                     component.handleInput("left");
                     component.handleInput("enter");
                     return resolved ?? null;
                  },
               },
            },
         );

         expect(result.isError).not.toBe(true);
         expect(result.details.response).toEqual({ kind: "selection", selections: ["Red"] });
         expect(result.details.cancelled).toBe(false);
      });

      test("returns cancelled when select() returns undefined", async () => {
         const tool = await setupTool();

         const result = await tool.execute(
            "tool-call-id",
            {
               question: "Pick a color",
               options: ["Red", "Blue"],
            },
            undefined,
            undefined,
            {
               hasUI: true,
               ui: {
                  custom: async () => undefined,
                  select: async () => undefined,
                  input: async () => undefined,
               },
            },
         );

         expect(result.details.cancelled).toBe(true);
         expect(result.details.response).toBeNull();
      });

      test("passes context into the dialog prompt", async () => {
         const tool = await setupTool();
         let selectTitle = "";

         await tool.execute(
            "tool-call-id",
            {
               question: "Pick a color",
               context: "The sky is blue today.",
               options: ["Red", "Blue"],
               allowFreeform: false,
            },
            undefined,
            undefined,
            {
               hasUI: true,
               ui: {
                  custom: async () => undefined,
                  select: async (title: string) => {
                     selectTitle = title;
                     return "Blue";
                  },
                  input: async () => undefined,
               },
            },
         );

         expect(selectTitle).toContain("Pick a color");
         expect(selectTitle).toContain("The sky is blue today.");
      });

      test("passes timeout to dialog methods", async () => {
         const tool = await setupTool();
         let capturedOpts: any;

         await tool.execute(
            "tool-call-id",
            {
               question: "Pick a color",
               options: ["Red", "Blue"],
               allowFreeform: false,
               timeout: 5000,
            },
            undefined,
            undefined,
            {
               hasUI: true,
               ui: {
                  custom: async () => undefined,
                  select: async (_title: string, _opts: string[], opts: any) => {
                     capturedOpts = opts;
                     return "Red";
                  },
                  input: async () => undefined,
               },
            },
         );

         expect(capturedOpts).toEqual({ timeout: 5000 });
      });
   });
});
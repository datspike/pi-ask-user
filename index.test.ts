import { beforeAll, describe, expect, mock, test } from "bun:test";

let editorInputs: string[] = [];
let editorText = "";
let emittedEvents: Array<{ name: string; payload: any }> = [];
let markdownTheme: any;

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
         return;
      }
      if (data === "backspace") {
         editorText = editorText.slice(0, -1);
         return;
      }
      if (typeof data === "string" && data.length === 1 && data.charCodeAt(0) >= 32) {
         editorText += data;
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
   mock.module("@earendil-works/pi-coding-agent", () => ({
      DynamicBorder: class { },
      getMarkdownTheme: () => markdownTheme,
      rawKeyHint: (key: string, description: string) => `${key} ${description}`,
   }));

   mock.module("@earendil-works/pi-tui", () => ({
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
         pageUp: "pageUp",
         pageDown: "pageDown",
         home: "home",
         end: "end",
      },
      Markdown: class extends MockText { },
      matchesKey: (data: string, key: string) => data === key,
      isKeyRelease: () => false,
      isKeyRepeat: () => false,
      Spacer: class { render() { return []; } },
      Text: MockText,
      truncateToWidth: (text: string) => text,
      wrapTextWithAnsi: (text: string) => [text],
      decodeKittyPrintable: (data: string) => {
         if (data === "kitty-backspace") {
            return "\x7f";
         }
         return data.length === 1 ? data : undefined;
      },
      fuzzyFilter: <T>(items: T[], query: string, getText: (item: T) => string) => {
         const normalized = query.trim().toLowerCase();
         if (!normalized) return items;
         return items.filter((item) => getText(item).toLowerCase().includes(normalized));
      },
   }));

   mock.module("@sinclair/typebox", () => ({
      Type: {
         Object: (properties: unknown, options?: unknown) => ({ kind: "object", properties, options }),
         String: (options?: unknown) => ({ kind: "string", options }),
         Optional: (item: unknown) => ({ kind: "optional", item }),
         Array: (items: unknown, options?: unknown) => ({ kind: "array", items, options }),
         Union: (items: unknown) => ({ kind: "union", items }),
         Boolean: (options?: unknown) => ({ kind: "boolean", options }),
         Number: (options?: unknown) => ({ kind: "number", options }),
      },
   }));
});

type RegisteredTool = {
   executionMode?: string;
   parameters?: any;
   prepareArguments?: (args: unknown) => any;
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
   test("registers sequential execution with flat model-facing option schemas", async () => {
      const tool = await setupTool();
      const topLevelOptions = tool.parameters.properties.options.item;
      const nestedOptions = tool.parameters.properties.questions.item.items.properties.options.item;

      expect(tool.executionMode).toBe("sequential");
      expect(topLevelOptions.items.kind).toBe("object");
      expect(topLevelOptions.items.properties.title.kind).toBe("string");
      expect(topLevelOptions.items.properties.description.kind).toBe("optional");
      expect(nestedOptions.items.kind).toBe("object");
      expect(nestedOptions.items.properties.title.kind).toBe("string");
      expect(tool.parameters.properties).not.toHaveProperty("allowFreeform");
      expect(tool.parameters.properties.questions.item.items.properties).not.toHaveProperty("allowFreeform");
   });

   test("publishes and enforces the single/batch mode enum", async () => {
      const tool = await setupTool();
      const serialized = JSON.stringify(tool.parameters.properties.mode);
      expect(serialized).toContain("single");
      expect(serialized).toContain("batch");
      await expect(tool.execute("id", { mode: "other", question: "No" }, undefined, undefined, {})).rejects.toThrow("Unsupported ask_user mode");
   });

   test("prepares legacy strings and defensive aliases before schema validation", async () => {
      const tool = await setupTool();
      const prepared = tool.prepareArguments?.({
         question: "Choose",
         options: [" Alpha ", { label: " Beta ", description: " Second " }, { value: 42 }, null],
         questions: [
            {
               id: "nested",
               question: "Nested",
               options: [{ text: " Gamma " }, { option: " Delta ", description: 12 }],
            },
         ],
      });

      expect(prepared.options).toEqual([
         { title: "Alpha" },
         { title: "Beta", description: "Second" },
         { title: "" },
         { title: "" },
      ]);
      expect(prepared.questions[0].options).toEqual([
         { title: "Gamma" },
         { title: "Delta" },
      ]);
   });

   test("rejects a lazy markdown theme proxy that fails its safe probe", async () => {
      const { isUsableMarkdownTheme } = await import("./pi-compat");
      const lazyTheme = {
         bold() {
            throw new Error("theme is not initialized");
         },
      };

      expect(isUsableMarkdownTheme(lazyTheme)).toBe(false);
   });

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

   test("renders the current Pi error result shape from content instead of cancellation", async () => {
      const tool = await setupTool();
      const component = tool.renderResult(
         {
            content: [{ type: "text", text: "Ask requires interactive mode." }],
            details: {},
         },
         { expanded: false, isPartial: false },
         createTheme(),
         { isError: true } as any,
      ) as any;

      const rendered = component.render(120).join("\n");

      expect(rendered).toContain("✗ Ask requires interactive mode.");
      expect(rendered).not.toContain("Cancelled");

      const legacyComponent = tool.renderResult(
         { content: [], details: { error: "Legacy error" } },
         { expanded: false, isPartial: false },
         createTheme(),
         { isError: false } as any,
      ) as any;
      expect(legacyComponent.render(120).join("\n")).toContain("✗ Legacy error");
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

   test("filters searchable single-select options from typed input", async () => {
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
                  expect(component.render(60).join("\n")).toContain("Filter: b");
                  expect(component.render(60).join("\n")).toContain("Beta");
                  expect(component.render(60).join("\n")).not.toContain("Alpha");
                  component.handleInput("enter");
                  return resolved ?? null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(result.details.response).toEqual({ kind: "selection", selections: ["Beta"] });
      expect(result.details.cancelled).toBe(false);
   });

   test("renders the single-select filter affordance", async () => {
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
                  expect(component.render(100).join("\n")).toContain("Filter: type to filter");
                  return null;
               },
            },
         },
      );

      expect(helpText).toContain("type custom answer");
      expect(helpText).not.toContain("type filter");
   });

   test("legacy allowFreeform=false still shows custom answers in single overlay", async () => {
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

                  expect(component.render(80).join("\n")).toContain("Type something");
                  component.handleInput("b");
                  component.handleInput("enter");
                  return resolved ?? null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(result.details.response).toEqual({ kind: "selection", selections: ["Beta 7"] });
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
      expect(answeredEvent?.payload.response).toEqual({ kind: "freeform" });
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
                  component.handleInput("enter");
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

   test("does not open freeform for kitty-style backspace in single-select mode", async () => {
      const tool = await setupTool();
      let controllerMode = "";
      let hasSingleSelectList = false;

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

                  component.handleInput("kitty-backspace");
                  controllerMode = (component as any).controller.mode;
                  hasSingleSelectList = Boolean((component as any).singleSelectList);
                  return null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(controllerMode).toBe("select");
      expect(hasSingleSelectList).toBe(true);
   });

   test("returns to the option list when a selectable single-question freeform draft becomes empty", async () => {
      const tool = await setupTool();
      editorText = "";
      let controllerMode = "";
      let hasSingleSelectList = false;

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
                  component.handleInput("enter");
                  component.handleInput("x");
                  expect(editorText).toBe("x");
                  component.handleInput("backspace");
                  component.handleInput("backspace");
                  controllerMode = (component as any).controller.mode;
                  hasSingleSelectList = Boolean((component as any).singleSelectList);
                  return null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(controllerMode).toBe("select");
      expect(hasSingleSelectList).toBe(true);
      expect(editorText).toBe("");
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

      await expect(tool.execute(
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
      )).rejects.toThrow("Batch mode requires between 2 and 7 questions");
   });

   test("rejects fully malformed options before any UI callback", async () => {
      const tool = await setupTool();
      let customCalled = false;

      await expect(tool.execute(
         "tool-call-id",
         { question: "Choose", options: [{ label: 42 }, null] },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async () => {
                  customCalled = true;
                  return null;
               },
            },
         },
      )).rejects.toThrow("Options must include at least one non-empty title");
      expect(customCalled).toBe(false);
   });

   test("rejects malformed batch options before updates or UI callbacks", async () => {
      const tool = await setupTool();
      let updated = false;
      let customCalled = false;

      await expect(tool.execute(
         "tool-call-id",
         {
            mode: "batch",
            questions: [
               { id: "first", question: "First?", options: [{ name: 7 }] },
               { id: "second", question: "Second?", options: ["Valid"] },
            ],
         },
         undefined,
         () => { updated = true; },
         {
            hasUI: true,
            ui: {
               custom: async () => {
                  customCalled = true;
                  return null;
               },
            },
         },
      )).rejects.toThrow("Options must include at least one non-empty title");
      expect(updated).toBe(false);
      expect(customCalled).toBe(false);
   });

   test("throws when interactive UI is unavailable", async () => {
      const tool = await setupTool();

      await expect(tool.execute(
         "tool-call-id",
         { question: "Choose", options: ["A"] },
         undefined,
         undefined,
         { hasUI: false },
      )).rejects.toThrow("Ask requires interactive mode");
   });

   test("propagates real overlay and dialog errors", async () => {
      const tool = await setupTool();

      await expect(tool.execute(
         "tool-call-id",
         { question: "Choose", options: ["A"] },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: { custom: async () => { throw new Error("overlay failed"); } },
         },
      )).rejects.toThrow("overlay failed");

      await expect(tool.execute(
         "tool-call-id",
         { question: "Choose", options: ["A"] },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async () => undefined,
               select: async () => { throw new Error("select failed"); },
               input: async () => undefined,
            },
         },
      )).rejects.toThrow("select failed");

      await expect(tool.execute(
         "tool-call-id",
         { question: "Write an answer" },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: { input: async () => { throw new Error("input failed"); } },
         },
      )).rejects.toThrow("input failed");
   });

   test("keeps overlay timeout as a cancelled result", async () => {
      const tool = await setupTool();

      const result = await tool.execute(
         "tool-call-id",
         { question: "Choose", options: ["A"], timeout: 1 },
         undefined,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: (factory: any) => new Promise((resolve) => {
                  factory(
                     { requestRender() {}, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     resolve,
                  );
               }),
            },
         },
      );

      expect(result.details.cancelled).toBe(true);
      expect(result.details.response).toBeNull();
      expect(result.details.outcome).toBe("timeout");
      expect(result.content[0].text).toContain("timed out");
   });

   test("keeps pre-abort and confirmed mid-flight abort as cancelled results", async () => {
      const tool = await setupTool();
      const preAborted = new AbortController();
      preAborted.abort();

      const preResult = await tool.execute("tool-call-id", { question: "Choose" }, preAborted.signal, undefined, {});
      expect(preResult.details).toEqual({ mode: "single", response: null, cancelled: true, outcome: "aborted" });

      const midFlight = new AbortController();
      const midResult = await tool.execute(
         "tool-call-id",
         { question: "Choose", options: ["A"] },
         midFlight.signal,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async () => {
                  midFlight.abort();
                  throw new Error("dismissed by abort");
               },
            },
         },
      );
      expect(midResult.details.cancelled).toBe(true);
      expect(midResult.details.response).toBeNull();
      expect(midResult.details.outcome).toBe("aborted");
   });

   test("returns cancellation when single fallback aborts before returning a value", async () => {
      const tool = await setupTool();
      const controller = new AbortController();

      const result = await tool.execute(
         "tool-call-id",
         { question: "Choose", options: ["A"] },
         controller.signal,
         undefined,
         {
            hasUI: true,
            ui: {
               custom: async () => undefined,
               select: async () => {
                  controller.abort();
                  return "A";
               },
               input: async () => undefined,
            },
         },
      );

      expect(result.details.cancelled).toBe(true);
      expect(result.details.response).toBeNull();
      expect(emittedEvents.some((event) => event.name === "ask:answered")).toBe(false);
   });

   test("completes a batch clarification flow in the overlay", async () => {
      const tool = await setupTool();
      let rendered = "";
      const originalDateNow = Date.now;
      let now = 1_000;
      Date.now = () => now;

      try {
         const result = await tool.execute(
            "tool-call-id",
            {
               mode: "batch",
               title: "Clarify scope",
               context: "Need a few details before implementation.",
               questions: [
                  { id: "surface", question: "Which surface is in scope?", options: ["Overlay", "Fallback"], allowFreeform: false },
                  { id: "compat", question: "Must the current behavior stay exact?", options: ["Yes", "No"], allowFreeform: false }
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
                     now = 1_300;
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
         expect(rendered).toContain("custom response");
      } finally {
         Date.now = originalDateNow;
      }
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

   test("ignores immediate enter autorepeat between consecutive batch select questions", async () => {
      const tool = await setupTool();
      let renderedAfterRepeatedEnter = "";
      const originalDateNow = Date.now;
      let now = 1_000;
      Date.now = () => now;

      try {
         const result = await tool.execute(
            "tool-call-id",
            {
               mode: "batch",
               title: "Clarify scope",
               questions: [
                  { id: "surface", question: "Which surface is in scope?", options: ["Overlay", "Fallback"] },
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
                     now = 1_100;
                     component.handleInput("enter");
                     renderedAfterRepeatedEnter = component.render(100).join("\n");
                     component.handleInput("down");
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
               { id: "compat", kind: "selection", selections: ["No"] },
            ],
         });
         expect(renderedAfterRepeatedEnter).toContain("Questions (2/2)");
         expect(renderedAfterRepeatedEnter).toContain("2. Must the current behavior stay exact? — optional");
      } finally {
         Date.now = originalDateNow;
      }
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

   test("does not open freeform for kitty-style backspace in batch select mode", async () => {
      const tool = await setupTool();
      let controllerMode = "";
      let rendered = "";

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
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     () => { },
                  );

                  component.handleInput("kitty-backspace");
                  controllerMode = (component as any).controller.mode;
                  rendered = component.render(100).join("\n");
                  return null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(controllerMode).toBe("select");
      expect(rendered).toContain("Q1. Which surface is in scope?");
      expect(rendered).toContain("Overlay");
      expect(rendered).toContain("Fallback");
   });

   test("returns to the option list when a selectable batch freeform draft becomes empty", async () => {
      const tool = await setupTool();
      let rendered = "";
      editorText = "";
      let controllerMode = "";

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
                  const component = factory(
                     { requestRender() { }, terminal: { rows: 24 } },
                     createTheme(),
                     createKeybindings(),
                     () => { },
                  );

                  component.handleInput("down");
                  component.handleInput("down");
                  component.handleInput("enter");
                  component.handleInput("x");
                  expect(editorText).toBe("x");
                  component.handleInput("backspace");
                  component.handleInput("backspace");
                  controllerMode = (component as any).controller.mode;
                  rendered = component.render(100).join("\n");
                  return null;
               },
            },
         },
      );

      expect(result.isError).not.toBe(true);
      expect(controllerMode).toBe("select");
      expect(rendered).not.toContain("Answer");
      expect(rendered).toContain("Q1. Which surface is in scope?");
      expect(rendered).toContain("Overlay");
      expect(rendered).toContain("Fallback");
      expect(editorText).toBe("");
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
                  component.handleInput("down");
                  component.handleInput("down");
                  component.handleInput("enter");
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

   test("shows the overlay shortcut without transition-navigation hints in the batch footer", async () => {
      const tool = await setupTool();
      let rendered = "";

      await tool.execute(
         "tool-call-id",
         {
            mode: "batch",
            title: "Clarify scope",
            overlayToggleKey: "alt+h",
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

      expect(rendered).toContain("alt+h hide");
      expect(rendered).not.toContain("switch question");
      expect(rendered).not.toContain("ctrl+n");
      expect(rendered).not.toContain("ctrl+p");

   });

   test("batch inline footer does not show an overlay hide shortcut", async () => {
      const tool = await setupTool();
      let rendered = "";
      await tool.execute("id", { mode: "batch", displayMode: "inline", overlayToggleKey: "alt+h", questions: [
         { id: "one", question: "First?", options: ["A"] },
         { id: "two", question: "Second?", options: ["B"] },
      ] }, undefined, undefined, {
         hasUI: true,
         ui: { custom: async (factory: any) => {
            const component = factory({ requestRender() {}, terminal: { rows: 24 } }, createTheme(), createKeybindings(), () => null);
            rendered = component.render(100).join("\n");
            return null;
         } },
      });
      expect(rendered).not.toContain("hide");
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
      test("legacy allowFreeform=false still permits a custom fallback answer", async () => {
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
                     return "✏️ Type custom response...";
                  },
                  input: async () => "Turquoise",
               },
            },
         );

         expect(result.isError).not.toBe(true);
         expect(result.details.response).toEqual({ kind: "freeform", text: "Turquoise" });
         expect(result.details.cancelled).toBe(false);
         expect(result.content[0].text).toBe("User answered: Turquoise");
         expect(selectTitle).toContain("Pick a color");
         expect(selectOptions).toEqual(["Red", "Blue", "✏️ Type custom response..."]);
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


      test("uses one decreasing batch deadline across overlay, fallback questions, and submit", async () => {
         const tool = await setupTool();
         const originalDateNow = Date.now;
         let now = 1_000;
         const observedTimeouts: number[] = [];
         Date.now = () => now;

         try {
            const result = await tool.execute(
               "tool-call-id",
               {
                  mode: "batch",
                  title: "Clarify scope",
                  timeout: 1_000,
                  questions: [
                     { id: "surface", question: "Which surface?", options: ["Overlay", "Fallback"] },
                     { id: "notes", question: "Anything else?", required: false },
                  ],
               },
               undefined,
               undefined,
               {
                  hasUI: true,
                  ui: {
                     custom: async () => {
                        now = 1_200;
                        return undefined;
                     },
                     select: async (_title: string, opts: string[], dialogOpts: any) => {
                        observedTimeouts.push(dialogOpts.timeout);
                        if (opts[0] === "Submit answers") return "Submit answers";
                        now += 300;
                        return "Fallback";
                     },
                     input: async (_title: string, _placeholder: string, dialogOpts: any) => {
                        observedTimeouts.push(dialogOpts.timeout);
                        now += 200;
                        return "";
                     },
                  },
               },
            );

            expect(result.details.cancelled).toBe(false);
            expect(observedTimeouts).toEqual([800, 500, 300]);
         } finally {
            Date.now = originalDateNow;
         }
      });

      test("returns cancellation when batch submit arrives after the shared deadline", async () => {
         const tool = await setupTool();
         const originalDateNow = Date.now;
         let now = 1_000;
         let selectCalls = 0;
         Date.now = () => now;

         try {
            const result = await tool.execute(
               "tool-call-id",
               {
                  mode: "batch",
                  timeout: 1_000,
                  questions: [
                     { id: "surface", question: "Which surface?", options: ["Fallback"] },
                     { id: "compat", question: "Keep compatibility?", options: ["Yes"] },
                  ],
               },
               undefined,
               undefined,
               {
                  hasUI: true,
                  ui: {
                     custom: async () => undefined,
                     select: async (_title: string, options: string[]) => {
                        selectCalls += 1;
                        if (options[0] === "Submit answers") {
                           now = 2_001;
                           return "Submit answers";
                        }
                        return options[0];
                     },
                     input: async () => undefined,
                  },
               },
            );

            expect(selectCalls).toBe(3);
            expect(result.details.cancelled).toBe(true);
            expect(result.details.response).toBeNull();
            expect(emittedEvents.some((event) => event.name === "ask:answered")).toBe(false);
         } finally {
            Date.now = originalDateNow;
         }
      });

      test("does not start batch fallback after the shared deadline expires in custom UI", async () => {
         const tool = await setupTool();
         const originalDateNow = Date.now;
         let now = 1_000;
         let fallbackCalls = 0;
         Date.now = () => now;

         try {
            const result = await tool.execute(
               "tool-call-id",
               {
                  mode: "batch",
                  timeout: 1_000,
                  questions: [
                     { id: "surface", question: "Which surface?", options: ["Overlay", "Fallback"] },
                     { id: "compat", question: "Keep compatibility?", options: ["Yes", "No"] },
                  ],
               },
               undefined,
               undefined,
               {
                  hasUI: true,
                  ui: {
                     custom: async () => {
                        now = 2_000;
                        return undefined;
                     },
                     select: async () => {
                        fallbackCalls += 1;
                        return "Yes";
                     },
                     input: async () => {
                        fallbackCalls += 1;
                        return "answer";
                     },
                  },
               },
            );

            expect(result.details.cancelled).toBe(true);
            expect(result.details.response).toBeNull();
            expect(fallbackCalls).toBe(0);
         } finally {
            Date.now = originalDateNow;
         }
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
         expect(cancelledEvent?.payload.questions).toBeUndefined();
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

   test("uses inline custom UI when requested", async () => {
      const tool = await setupTool();
      let capturedOptions: any = "unset";
      await tool.execute(
         "tool-call-id",
         { question: "Choose", options: ["A"], displayMode: "inline" },
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
      expect(capturedOptions).toBeUndefined();
   });

   test("uses f7 by default for single and batch overlays while allowing per-call overrides", async () => {
      const tool = await setupTool();
      for (const { params, shortcut } of [
         { params: { question: "Choose", options: ["A"] }, shortcut: "f7" },
         { params: { mode: "batch", questions: [
            { id: "first", question: "Choose", options: ["A"] },
            { id: "second", question: "Confirm", options: ["Yes"] },
         ] }, shortcut: "f7" },
         { params: { question: "Choose", options: ["A"], overlayToggleKey: "alt+h" }, shortcut: "alt+h" },
      ]) {
         let inputListener: ((data: string) => any) | undefined;
         let hidden = false;
         let removed = false;
         let factoryCalls = 0;
         const handle = {
            hide() {},
            setHidden(value: boolean) { hidden = value; },
            isHidden() { return hidden; },
            focus() {},
            unfocus() {},
            isFocused() { return true; },
         };

         await tool.execute(
            "tool-call-id",
            params,
            undefined,
            undefined,
            {
               hasUI: true,
               ui: {
                  onTerminalInput(listener: (data: string) => any) {
                     inputListener = listener;
                     return () => { removed = true; };
                  },
                  custom: async (_factory: any, options: any) => {
                     factoryCalls += 1;
                     options.onHandle(handle);
                     inputListener?.(shortcut);
                     expect(hidden).toBe(true);
                     inputListener?.(shortcut);
                     expect(hidden).toBe(false);
                     return null;
                  },
               },
            },
         );

         expect(factoryCalls).toBe(1);
         expect(removed).toBe(true);
      }
   });
   test("keeps choices and help visible for long single and batch prompts and scrolls only select prompts", async () => {
      const tool = await setupTool();
      const longQuestion = Array.from({ length: 30 }, (_, index) => `segment-${index}`).join(" ");
      const renders: string[] = [];
      for (const params of [
         { question: longQuestion, options: ["Visible choice"] },
         { mode: "batch", questions: [
            { id: "one", question: longQuestion, options: ["Visible choice"] },
            { id: "two", question: "Second", options: ["Yes"] },
         ] },
      ]) {
         await tool.execute("id", params, undefined, undefined, {
            hasUI: true,
            ui: {
               custom: async (factory: any) => {
                  const tui = { terminal: { rows: 12 }, requestRender() {} };
                  const component = factory(tui, createTheme(), createKeybindings(), () => {});
                  const before = component.render(56).join("\n");
                  const { Key } = await import("@earendil-works/pi-tui");
                  component.handleInput(Key.pageDown);
                  const after = component.render(56).join("\n");
                  renders.push(before, after);
                  return null;
               },
            },
         });
      }
      expect(renders[0]).toContain("Visible choice");
      expect(renders[0]).toContain("navigate");
      expect(renders[1]).not.toBe(renders[0]);
      expect(renders[2]).toContain("Visible choice");
      expect(renders[2]).toContain("navigate");
      expect(renders[3]).not.toBe(renders[2]);
   });

   test("reports timeout content consistently for a freeform-only single question", async () => {
      const tool = await setupTool();
      const result = await tool.execute("id", { question: "Answer", timeout: 1 }, undefined, undefined, {
         hasUI: true,
         ui: { input: async () => { await Bun.sleep(2); return undefined; } },
      });
      expect(result.details.outcome).toBe("timeout");
      expect(result.content[0].text).toBe("The question timed out");
   });

   test("emits balanced herdr blocked lifecycle events without prompt contents", async () => {
      const tool = await setupTool();
      await tool.execute("id", { question: "Private question" }, undefined, undefined, {
         hasUI: true,
         ui: { input: async () => "answer" },
      });
      const blocked = emittedEvents.filter((event) => event.name === "herdr:blocked").map((event) => event.payload);
      expect(blocked).toEqual([
         { active: true, label: "Waiting for user response" },
         { active: false },
      ]);
      expect(JSON.stringify(blocked)).not.toContain("Private question");
   });

});
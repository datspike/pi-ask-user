import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT_DIR = path.resolve(import.meta.dir);
const PACKAGE_JSON_PATH = path.join(ROOT_DIR, "package.json");
const packageJson = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")) as {
  files?: string[];
  peerDependencies?: Record<string, string>;
  pi?: {
    extensions?: string[];
    skills?: string[];
  };
};

function collectTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    if (entry === "node_modules" || entry === ".git" || entry === ".runtime") return [];
    const absolutePath = path.join(directory, entry);
    return statSync(absolutePath).isDirectory() ? collectTypeScriptFiles(absolutePath) : absolutePath.endsWith(".ts") ? [absolutePath] : [];
  });
}

describe("package contract", () => {
  test("declares the expected Pi package entrypoints", () => {
    expect(packageJson.pi?.extensions).toEqual(["./index.ts"]);
    expect(packageJson.pi?.skills).toEqual(["./skills"]);
  });

  test("uses the current Pi peer packages with the supported compatibility floor", () => {
    expect(packageJson.peerDependencies).toEqual({
      "@earendil-works/pi-coding-agent": ">=0.85.1",
      "@earendil-works/pi-tui": ">=0.85.1",
      "@sinclair/typebox": "*",
    });
  });

  test("contains no legacy Pi scope in runtime or test TypeScript imports", () => {
    for (const filePath of collectTypeScriptFiles(ROOT_DIR)) {
      expect(readFileSync(filePath, "utf8")).not.toContain("@mario" + "zechner/");
    }
  });

  test("publishes all runtime source files referenced by the package", () => {
    const runtimeFiles = [
      "index.ts",
      "ask-user-core.ts",
      "ask-overlay-controller.ts",
      "ask-overlay-ui.ts",
      "pi-compat.ts",
      "ask-component.ts",
      "batch-ask-component.ts",
      "single-select-layout.ts",
      "skills",
      "README.md",
      "CHANGELOG.md",
      "LICENSE",
      "NOTICE",
    ];

    expect(packageJson.files).toEqual(runtimeFiles);
    for (const relativePath of runtimeFiles) {
      expect(existsSync(path.join(ROOT_DIR, relativePath))).toBe(true);
    }
  });

  test("keeps runtime helper exports in pi-compat instead of internal re-exports", async () => {
    const compatModule = await import("./pi-compat");
    const controllerModule = await import("./ask-overlay-controller");
    const uiModule = await import("./ask-overlay-ui");

    expect(typeof compatModule.readEditorText).toBe("function");
    expect(typeof compatModule.writeEditorText).toBe("function");
    expect(typeof compatModule.writeEditorTextIfNeeded).toBe("function");
    expect(typeof compatModule.setEditorFocus).toBe("function");

    expect("readEditorText" in controllerModule).toBe(false);
    expect("writeEditorText" in controllerModule).toBe(false);
    expect("writeEditorTextIfNeeded" in controllerModule).toBe(false);
    expect("setEditorFocus" in controllerModule).toBe(false);
    expect("ASK_USER_VERSION" in uiModule).toBe(false);
  });

  test("registers the ask_user tool from the package entrypoint", async () => {
    const { default: extension } = await import("./index");
    let registeredTool: { name?: string; renderCall?: unknown; renderResult?: unknown; execute?: unknown } | undefined;

    extension({
      registerTool(tool: typeof registeredTool) {
        registeredTool = tool;
      },
      events: {
        emit() {},
      },
    } as never);

    expect(registeredTool?.name).toBe("ask_user");
    expect(typeof registeredTool?.execute).toBe("function");
    expect(typeof registeredTool?.renderCall).toBe("function");
    expect(typeof registeredTool?.renderResult).toBe("function");
  });
});

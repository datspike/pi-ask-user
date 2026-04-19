import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT_DIR = path.resolve(import.meta.dir);
const PACKAGE_JSON_PATH = path.join(ROOT_DIR, "package.json");
const packageJson = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")) as {
  files?: string[];
  pi?: {
    extensions?: string[];
    skills?: string[];
  };
};

describe("package contract", () => {
  test("declares the expected Pi package entrypoints", () => {
    expect(packageJson.pi?.extensions).toEqual(["./index.ts"]);
    expect(packageJson.pi?.skills).toEqual(["./skills"]);
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
      "LICENSE",
    ];

    expect(packageJson.files).toEqual(runtimeFiles);
    for (const relativePath of runtimeFiles) {
      expect(existsSync(path.join(ROOT_DIR, relativePath))).toBe(true);
    }
  });

  test("preserves compatibility exports for published internal modules", async () => {
    const controllerModule = await import("./ask-overlay-controller");

    expect(typeof controllerModule.readEditorText).toBe("function");
    expect(typeof controllerModule.writeEditorText).toBe("function");
    expect(typeof controllerModule.writeEditorTextIfNeeded).toBe("function");
    expect(typeof controllerModule.setEditorFocus).toBe("function");
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

import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { resolveWorkspacePath } from "../src/storage/workspace.js";

describe("Workspace boundary", () => {
  it("rejects absolute, drive-relative and traversal paths", () => {
    for (const path of [
      "../secret",
      "files/../../secret",
      "..\\secret",
      "/tmp/secret",
      "C:\\secret",
      "C:secret",
      "\\\\server\\secret",
      "",
      ".",
    ]) {
      expect(() => resolveWorkspacePath("D:/workspace", path)).toThrow();
    }
  });
  it("resolves nested relative filenames", () => {
    expect(resolveWorkspacePath("D:/workspace", "files/design.md")).toBe(
      resolve("D:/workspace", "files/design.md"),
    );
  });
});

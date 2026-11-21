import { describe, expect, it } from "vitest";
import { createContentRevision } from "../src/features/requirements/content-revision";

describe("引用解析与本地正文修订", () => {
  it("迟到引用响应不能覆盖请求期间输入的正文", async () => {
    const content = createContentRevision();
    let release!: (html: string) => void;
    let html = "原正文";
    const resolving = content.resolve(
      "原正文",
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
      (value) => {
        html = value;
      },
    );
    content.invalidate();
    html = "原正文与最新输入";
    release("原正文与最新引用名");
    expect(await resolving).toBe(false);
    expect(html).toBe("原正文与最新输入");
  });

  it("只允许最新外部正文解析回填，卸载失效后也不回填", async () => {
    const content = createContentRevision();
    let release!: (html: string) => void;
    let html = "旧";
    const first = content.resolve(
      "旧",
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
      (value) => {
        html = value;
      },
    );
    expect(
      await content.resolve(
        "新",
        async () => "新引用",
        (value) => {
          html = value;
        },
      ),
    ).toBe(true);
    release("旧引用");
    expect(await first).toBe(false);
    expect(html).toBe("新引用");
    const pending = content.resolve(
      "卸载",
      async () => "不回填",
      (value) => {
        html = value;
      },
    );
    content.invalidate();
    expect(await pending).toBe(false);
    expect(html).toBe("新引用");
  });
});

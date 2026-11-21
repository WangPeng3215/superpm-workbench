import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { contentVersion } from "../src/features/requirements/content-version";

it("保存后基准哈希与服务端UTF-8正文哈希一致", async () => {
  const content = "正文🌏\n第二行\r\n";
  expect(await contentVersion(content)).toBe(
    createHash("sha256").update(content, "utf8").digest("hex"),
  );
});

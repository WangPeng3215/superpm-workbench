import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/client";
import { resolveResourceAccessFailure } from "../src/features/requirements/resource-access";

describe("资源缺失与需求失权区分", () => {
  const missing = new ApiError("文件不存在", "NOT_FOUND", 404);
  it("资源404且需求可读只使当前资源不可用", async () => {
    expect(await resolveResourceAccessFailure(missing, async () => ({}))).toBe(
      "resource-missing",
    );
  });
  it.each([403, 404])("资源404且父需求%s清理整个需求", async (status) => {
    expect(
      await resolveResourceAccessFailure(missing, async () => {
        throw new ApiError("已失权", "DENIED", status);
      }),
    ).toBe("requirement-lost");
  });
  it("明确资源403立即使需求失效，不等待复核", async () => {
    const recheck = vi.fn();
    expect(
      await resolveResourceAccessFailure(
        new ApiError("已失权", "FORBIDDEN", 403),
        recheck,
      ),
    ).toBe("requirement-lost");
    expect(recheck).not.toHaveBeenCalled();
  });
  it.each([401, 503, 0])(
    "父鉴权%s暂不能确认时保留草稿并暂停",
    async (status) => {
      expect(
        await resolveResourceAccessFailure(missing, async () => {
          throw new ApiError("鉴权暂不可用", "TEMPORARY", status);
        }),
      ).toBe("unverified");
    },
  );
  it("其他错误继续原有错误处理", async () => {
    const recheck = vi.fn();
    expect(
      await resolveResourceAccessFailure(
        new ApiError("保存失败", "TEMPORARY", 500),
        recheck,
      ),
    ).toBe("unrelated");
    expect(recheck).not.toHaveBeenCalled();
  });
});

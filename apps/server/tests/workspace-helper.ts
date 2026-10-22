import type { FastifyInstance } from "fastify";
import { join } from "node:path";

/**
 * 测试辅助：按需求目录映射（迁移 0010）取需求物理根目录的绝对路径。
 * 物理目录名是「需求编号 + 需求名称」，不能再假设为 requirements/{id}。
 */
export async function requirementRootPath(
  app: FastifyInstance,
  workspacePath: string,
  requirementId: number,
): Promise<string> {
  return join(
    workspacePath,
    ...(await requirementRootRelative(app, requirementId)).split("/"),
  );
}

/** 同上，但返回相对工作区根的路径（正斜杠分隔），供断言入库的相对路径使用 */
export async function requirementRootRelative(
  app: FastifyInstance,
  requirementId: number,
): Promise<string> {
  const state = (
    await app.inject({
      method: "GET",
      url: `/api/requirements/${requirementId}/directory`,
    })
  ).json() as { relativePath: string };
  return state.relativePath;
}

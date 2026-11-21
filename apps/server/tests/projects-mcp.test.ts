import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createServiceContainer,
  type ServiceContainer,
} from "../src/services/container";
import { runAsUser, runAsSystem } from "../src/db/scope";
import { buildMcpTools } from "../src/services/mcp-gateway";
import { McpWriteService } from "../src/services/mcp-writes";
describe("无可信账号的MCP默认拒绝项目域", () => {
  let c: ServiceContainer;
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "superpm-project-mcp-"));
    c = createServiceContainer({
      databasePath: join(dir, "test.sqlite"),
      workspacePath: join(dir, "workspace"),
    });
  });
  afterEach(() => {
    c.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  it("list/get/references/prepare/execute和公开executor均不能借用HTTP身份读取共享需求", () => {
    const { user } = c.auth.register({
      username: "project_owner",
      displayName: "owner",
      password: "secret123",
    });
    const scope = { userId: user.id, isAdmin: false };
    const { shared, privateReq } = runAsUser(scope, () => {
      const p = c.projects.create({ name: "团队项目" }).project;
      const shared = c.requirements.create({
        name: "共享敏感名",
        projectId: p.id,
        proposedAt: "2026-11-19",
      });
      const privateReq = c.requirements.create({
        name: "原有私人需求",
        proposedAt: "2026-11-19",
      });
      return { shared, privateReq };
    });
    const gateway = buildMcpTools({
      ...c,
      writes: new McpWriteService(c.db, { enabled: true }),
    });
    for (const run of [
      (fn: () => unknown) => runAsSystem(fn),
      (fn: () => unknown) => runAsUser(scope, fn),
    ]) {
      expect(
        run(() => gateway.call("requirement.get", { id: shared.id })),
      ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
      const list = run(() => gateway.call("requirement.list", {}));
      expect(JSON.stringify(list)).not.toContain("共享敏感名");
      expect(JSON.stringify(list)).toContain("原有私人需求");
      const prepared = run(() =>
        gateway.call("write.prepare", {
          tool: "issue.comment",
          input: { requirementId: shared.id, issueId: 1, content: "overwrite" },
          idempotencyKey: "blocked-prepare",
        }),
      );
      expect(prepared).toMatchObject({
        ok: false,
        error: { code: "NOT_FOUND" },
      });
      expect(
        run(() =>
          gateway.call("issue.comment", {
            requirementId: shared.id,
            issueId: 1,
            content: "hi",
            idempotencyKey: "blocked-write",
          }),
        ),
      ).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
      expect(
        run(() =>
          gateway.call("requirement.memory.update", {
            requirementId: shared.id,
            mode: "append",
            content: "hi",
            idempotencyKey: "blocked-auto-write",
          }),
        ),
      ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
      expect(() =>
        run(() =>
          gateway.tools.get("requirement.get")!.execute({ id: shared.id }),
        ),
      ).toThrow("需求不存在");
    }
    expect(
      runAsSystem(() => c.requirements.references([shared.id, privateReq.id])),
    ).toEqual(
      expect.arrayContaining([
        { id: shared.id, requirementNo: null, name: null, exists: false },
      ]),
    );
    expect(
      (
        c.db
          .prepare("SELECT count(*) AS n FROM mcp_write_confirmations")
          .get() as { n: number }
      ).n,
    ).toBe(0);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/db/migrate.js";
import { runAsUser } from "../src/db/scope.js";
import { RequirementService } from "../src/services/requirements.js";
import { RequirementDirectoryResolver } from "../src/services/requirement-directory.js";
import { ArtifactService } from "../src/services/artifacts.js";
import { RequirementFileService } from "../src/services/requirement-files.js";
import { IssueService } from "../src/services/issues.js";
import { StageWorkspaceService } from "../src/services/stage-workspace.js";

describe("需求资源使用原生连接时的授权边界", () => {
  let db: Database.Database;
  let root: string;
  let workspace: string;
  let requirements: RequirementService;
  let directories: RequirementDirectoryResolver;
  let artifacts: ArtifactService;
  let files: RequirementFileService;
  let issues: IssueService;
  let stages: StageWorkspaceService;
  const as = <T>(userId: number, action: () => T) =>
    runAsUser({ userId, isAdmin: false }, action);
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "superpm-resource-access-"));
    workspace = join(root, "workspace");
    mkdirSync(workspace);
    db = new Database(":memory:");
    migrate(db);
    for (const id of [1, 2, 3, 4, 5])
      db.prepare(
        "INSERT INTO users(id,username,display_name,password_hash,password_salt,created_at,updated_at) VALUES (?,?,?,'x','x','now','now')",
      ).run(id, `user${id}`, `User ${id}`);
    directories = new RequirementDirectoryResolver(db, workspace);
    requirements = new RequirementService(db, directories);
    artifacts = new ArtifactService(db, workspace, requirements, directories);
    files = new RequirementFileService(
      db,
      workspace,
      requirements,
      directories,
    );
    issues = new IssueService(db, requirements, workspace, directories);
    stages = new StageWorkspaceService(
      db,
      workspace,
      requirements,
      directories,
    );
  });
  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  function createRequirement(userId = 1) {
    return as(userId, () => {
      const requirement = requirements.create({
        name: "资源需求",
        proposedAt: "2026-11-19",
      });
      directories.initialize(requirement.id);
      return requirement;
    });
  }
  function share(requirementId: number) {
    db.prepare(
      "INSERT INTO projects(id,project_no,name,owner_user_id,product_owner_user_id,created_by,created_at,updated_at) VALUES (1,'P1','项目',1,1,1,'now','now')",
    ).run();
    for (const [id, role] of [
      [1, "owner"],
      [2, "contributor"],
      [3, "viewer"],
      [4, "contributor"],
    ] as const) {
      db.prepare(
        "INSERT INTO project_members(project_id,user_id,joined_at) VALUES (1,?,'now')",
      ).run(id);
      db.prepare(
        "INSERT INTO project_member_roles(project_id,user_id,role) VALUES (1,?,?)",
      ).run(id, role);
    }
    db.prepare(
      "UPDATE requirements SET project_id=1, assignee_user_id=2 WHERE id=?",
    ).run(requirementId);
  }
  const hash = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  it("仅凭节点或链接ID不能读取或改动其他账号的私有资料", () => {
    const req = createRequirement();
    const node = as(1, () =>
      artifacts.createFile(req.id, {
        name: "private.md",
        initialContent: "secret",
      }),
    );
    const link = as(1, () =>
      artifacts.createLink(req.id, {
        name: "private link",
        url: "https://example.com",
      }),
    );
    const nodePath = as(1, () =>
      directories.resolveReadOnly(req.id, node.relativePath),
    );
    for (const action of [
      () => artifacts.getNodeDetails(node.id),
      () => artifacts.readText(node.id),
      () => artifacts.raw(node.id),
      () => artifacts.renameNode(node.id, { name: "hijacked.md" }),
      () => artifacts.saveText(node.id, { content: "hijacked", force: true }),
      () => artifacts.setNodeFinal(node.id, { isFinal: true }),
      () => artifacts.deleteNode(node.id, true),
      () => artifacts.updateLink(link.id, { name: "hijacked" }),
      () => artifacts.setLinkFinal(link.id, { isFinal: true }),
      () => artifacts.deleteLink(link.id),
    ])
      expect(() => as<unknown>(2, action)).toThrowError(
        expect.objectContaining({ code: "NOT_FOUND" }),
      );
    expect(readFileSync(nodePath, "utf8")).toBe("secret");
  });
  it("目录映射入口不能泄露或初始化其他账号的私有需求", () => {
    const req = createRequirement();
    for (const action of [
      () => directories.row(req.id),
      () => directories.state(req.id),
      () => directories.stateReadOnly(req.id),
      () => directories.ensureMapping(req.id),
      () => directories.initialize(req.id),
      () => directories.repair(req.id),
      () => directories.resolve(req.id, "new-folder", true),
    ])
      expect(() => as<unknown>(2, action)).toThrowError(
        expect.objectContaining({ code: "NOT_FOUND" }),
      );
  });
  it("共享需求的只读成员读取资源不会写索引或补建目录", () => {
    const req = createRequirement();
    const node = as(1, () =>
      artifacts.createFile(req.id, {
        name: "shared.md",
        initialContent: "old",
      }),
    );
    const path = as(1, () =>
      directories.resolveReadOnly(req.id, node.relativePath),
    );
    share(req.id);
    writeFileSync(path, "external change");
    const before = db.prepare("SELECT total_changes() n").get();
    const rows = db.prepare("SELECT * FROM artifact_nodes").all();
    as(3, () => {
      expect(artifacts.readText(node.id).content).toBe("external change");
      artifacts.listNodes(req.id, null);
      artifacts.raw(node.id);
      files.list(req.id, "analysis", true);
      directories.state(req.id);
    });
    expect(db.prepare("SELECT * FROM artifact_nodes").all()).toEqual(rows);
    expect(
      db.prepare("SELECT COUNT(*) n FROM requirement_files").get(),
    ).toEqual({ n: 0 });
    expect(db.prepare("SELECT total_changes() n").get()).toEqual(before);
  });
  it("共享写入按编辑、贡献和资料管理能力分别授权", () => {
    const req = createRequirement();
    const node = as(1, () =>
      artifacts.createFile(req.id, {
        name: "shared.md",
        initialContent: "old",
      }),
    );
    const issue = as(1, () => issues.create(req.id, { title: "问题" }));
    share(req.id);
    for (const userId of [3, 4]) {
      for (const action of [
        () => artifacts.createFile(req.id, { name: "denied.md" }),
        () =>
          artifacts.saveText(node.id, {
            content: "denied",
            expectedVersion: hash("old"),
          }),
        () => stages.upload(req.id, { data: "eA==", mime: "image/png" }),
      ])
        expect(() => as<unknown>(userId, action)).toThrowError(
          expect.objectContaining({ code: "FORBIDDEN" }),
        );
    }
    expect(() =>
      as(2, () =>
        artifacts.renameNode(node.id, {
          name: "denied.md",
          expectedVersion: 1,
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(() =>
      as(3, () => issues.comment(req.id, issue.id, { content: "denied" })),
    ).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
    as(4, () =>
      issues.comment(
        req.id,
        issue.id,
        { content: "allowed" },
        undefined,
        "allow-comment",
      ),
    );
    as(2, () => artifacts.createFile(req.id, { name: "allowed.md" }));
  });
  it("共享正文写入必须匹配全文hash，force不能绕过", () => {
    const req = createRequirement();
    const node = as(1, () =>
      artifacts.createFile(req.id, {
        name: "shared.md",
        initialContent: "old",
      }),
    );
    share(req.id);
    expect(() =>
      as(1, () => artifacts.saveText(node.id, { content: "new", force: true })),
    ).toThrowError(
      expect.objectContaining({ code: "VERSION_REQUIRED", status: 428 }),
    );
    expect(() =>
      as(1, () =>
        artifacts.saveText(node.id, {
          content: "new",
          force: true,
          expectedVersion: hash("wrong"),
        }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "VERSION_CONFLICT", status: 409 }),
    );
    expect(as(1, () => artifacts.readText(node.id))).toHaveProperty(
      "version",
      hash("old"),
    );
    as(1, () =>
      artifacts.saveText(node.id, {
        content: "new",
        expectedVersion: hash("old"),
      }),
    );
    expect(as(3, () => artifacts.readText(node.id)).content).toBe("new");
  });
  it("共享可变元数据有整数版本且旧版本不产生改动", () => {
    const req = createRequirement();
    const node = as(1, () =>
      artifacts.createFile(req.id, { name: "shared.md" }),
    );
    const file = as(1, () =>
      files.create(req.id, {
        phase: "analysis",
        category: "record",
        name: "text",
        resourceType: "text",
        textContent: "old",
      }),
    );
    const issue = as(1, () => issues.create(req.id, { title: "问题" }));
    share(req.id);
    for (const action of [
      () => artifacts.setNodeFinal(node.id, { isFinal: true }),
      () => files.update(req.id, file.id, { name: "new" }),
      () => issues.update(req.id, issue.id, { title: "new" }),
    ])
      expect(() => as<unknown>(1, action)).toThrowError(
        expect.objectContaining({ code: "VERSION_REQUIRED" }),
      );
    expect(
      as(1, () =>
        artifacts.setNodeFinal(node.id, { isFinal: true, expectedVersion: 1 }),
      ),
    ).toHaveProperty("version", 2);
    expect(() =>
      as(1, () =>
        artifacts.setNodeFinal(node.id, { isFinal: false, expectedVersion: 1 }),
      ),
    ).toThrowError(expect.objectContaining({ code: "VERSION_CONFLICT" }));
    expect(
      as(1, () =>
        files.update(req.id, file.id, { name: "new", expectedVersion: 1 }),
      ),
    ).toHaveProperty("version", 2);
    expect(
      as(1, () =>
        issues.update(req.id, issue.id, { title: "new", expectedVersion: 1 }),
      ),
    ).toHaveProperty("version", 2);
  });
  it("共享需求记忆使用一致的版本错误码且失败不改正文", () => {
    const req = createRequirement();
    as(1, () => artifacts.ensureMemory(req.id));
    const memory = as(1, () => artifacts.readMemory(req.id));
    share(req.id);
    expect(() =>
      as(1, () =>
        artifacts.updateMemory(req.id, { mode: "replace", content: "new" }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "VERSION_REQUIRED", status: 428 }),
    );
    expect(() =>
      as(1, () =>
        artifacts.updateMemory(req.id, {
          mode: "replace",
          content: "new",
          expectedVersion: hash("stale"),
        }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "VERSION_CONFLICT", status: 409 }),
    );
    expect(as(1, () => artifacts.readMemory(req.id)).content).toBe(
      memory.content,
    );
  });
  it("正文索引保存失败时恢复产出物和旧文件的磁盘正文", () => {
    const req = createRequirement();
    const node = as(1, () =>
      artifacts.createFile(req.id, {
        name: "shared.md",
        initialContent: "old node",
      }),
    );
    const file = as(1, () =>
      files.create(req.id, {
        phase: "analysis",
        category: "record",
        name: "legacy.md",
        resourceType: "file",
        data: Buffer.from("old file").toString("base64"),
        mime: "text/markdown",
      }),
    );
    share(req.id);
    db.exec(
      "CREATE TRIGGER fail_node_update BEFORE UPDATE ON artifact_nodes BEGIN SELECT RAISE(ABORT, 'forced index failure'); END",
    );
    expect(() =>
      as(1, () =>
        artifacts.saveText(node.id, {
          content: "new node",
          expectedVersion: hash("old node"),
        }),
      ),
    ).toThrow();
    expect(as(3, () => artifacts.readText(node.id)).content).toBe("old node");
    db.exec(
      "CREATE TRIGGER fail_file_update BEFORE UPDATE ON requirement_files BEGIN SELECT RAISE(ABORT, 'forced index failure'); END",
    );
    expect(() =>
      as(1, () =>
        files.saveContent(req.id, file.id, {
          content: "new file",
          expectedVersion: hash("old file"),
        }),
      ),
    ).toThrow();
    expect(as(3, () => files.content(req.id, file.id)).content).toBe(
      "old file",
    );
  });
  it("问题正文索引保存失败时恢复磁盘正文", () => {
    const req = createRequirement();
    const issue = as(1, () =>
      issues.create(req.id, { title: "问题", description: "old description" }),
    );
    share(req.id);
    db.exec(
      "CREATE TRIGGER fail_issue_update BEFORE UPDATE ON issues BEGIN SELECT RAISE(ABORT, 'forced index failure'); END",
    );
    expect(() =>
      as(1, () =>
        issues.saveDescription(req.id, issue.id, {
          content: "new description",
          expectedVersion: hash("old description"),
        }),
      ),
    ).toThrow();
    expect(as(3, () => issues.getDescription(req.id, issue.id)).content).toBe(
      "old description",
    );
  });
  it("共享讨论必须幂等且权限撤销后的重放仍被拒绝", () => {
    const req = createRequirement();
    const issue = as(1, () => issues.create(req.id, { title: "问题" }));
    share(req.id);
    expect(() =>
      as(2, () => issues.comment(req.id, issue.id, { content: "讨论" })),
    ).toThrowError(
      expect.objectContaining({ code: "IDEMPOTENCY_KEY_REQUIRED" }),
    );
    const add = () =>
      issues.comment(
        req.id,
        issue.id,
        { content: "讨论" },
        undefined,
        "comment-replay",
      );
    as(2, add);
    as(2, add);
    expect(
      as(3, () => issues.detail(req.id, issue.id)).activities.filter(
        (item) => item.activityType === "comment",
      ),
    ).toHaveLength(1);
    expect(() =>
      as(2, () =>
        issues.comment(
          req.id,
          issue.id,
          { content: "不同" },
          undefined,
          "comment-replay",
        ),
      ),
    ).toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
    db.prepare(
      "UPDATE project_members SET status='removed' WHERE user_id=2",
    ).run();
    expect(() => as(2, add)).toThrowError(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
  });
  it("问题活动与关联使用真实操作者且共享历史不能伪造署名", () => {
    const req = createRequirement();
    share(req.id);
    const issue = as(2, () => issues.create(req.id, { title: "问题" }));
    const node = as(2, () =>
      artifacts.createFile(req.id, { name: "evidence.md" }),
    );
    as(2, () =>
      issues.linkAsset(req.id, issue.id, {
        assetId: node.id,
        relationType: "evidence",
      }),
    );
    as(1, () =>
      issues.update(
        req.id,
        issue.id,
        { status: "processing", solution: "investigate", expectedVersion: 1 },
        { actorType: "ai", actorName: "forged actor" },
      ),
    );
    expect(
      db
        .prepare(
          "SELECT user_id, actor_name FROM issue_activities WHERE issue_id=? ORDER BY id",
        )
        .all(issue.id),
    ).toEqual([
      { user_id: 2, actor_name: "User 2" },
      { user_id: 1, actor_name: "User 1" },
      { user_id: 1, actor_name: "User 1" },
    ]);
    expect(
      db
        .prepare("SELECT user_id FROM issue_artifact_links WHERE issue_id=?")
        .get(issue.id),
    ).toEqual({ user_id: 2 });
  });
  it("执行成员只能编辑自己未确认的产物且资源拼接必须同需求", () => {
    const req = createRequirement();
    const other = createRequirement();
    const foreign = as(1, () =>
      artifacts.createFolder(other.id, { name: "foreign" }),
    );
    const ownerFile = as(1, () =>
      artifacts.createFile(req.id, { name: "owner.md", initialContent: "old" }),
    );
    share(req.id);
    expect(() =>
      as(2, () =>
        artifacts.saveText(ownerFile.id, {
          content: "no",
          expectedVersion: hash("old"),
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
    const own = as(2, () =>
      artifacts.createFile(req.id, { name: "own.md", initialContent: "old" }),
    );
    as(2, () =>
      artifacts.saveText(own.id, {
        content: "new",
        expectedVersion: hash("old"),
      }),
    );
    const current = as(1, () => artifacts.getNodeDetails(own.id)).node;
    as(1, () =>
      artifacts.setNodeFinal(own.id, {
        isFinal: true,
        expectedVersion: current.version,
      }),
    );
    expect(() =>
      as(2, () =>
        artifacts.saveText(own.id, {
          content: "no",
          expectedVersion: hash("new"),
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(() =>
      as(1, () =>
        artifacts.moveNode(own.id, {
          targetParentId: foreign.id,
          expectedVersion: current.version + 1,
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
  });
  it("执行成员不能借旧文件创建接口直接确认最终版或改写他人需求记忆", () => {
    const req = createRequirement();
    as(1, () => artifacts.ensureMemory(req.id));
    const memory = as(1, () => artifacts.readMemory(req.id));
    share(req.id);
    expect(() =>
      as(2, () =>
        files.create(req.id, {
          phase: "analysis",
          category: "record",
          name: "final",
          resourceType: "text",
          textContent: "x",
          isFinal: true,
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(() =>
      as(2, () =>
        artifacts.updateMemory(req.id, {
          mode: "replace",
          content: "x",
          expectedVersion: memory.version,
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
  });
});

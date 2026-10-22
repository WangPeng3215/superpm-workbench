import type Database from "better-sqlite3";
import { stageWorkspaceSchema, type StageWorkspace } from "@superpm/shared";
import { existsSync, lstatSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DomainError, RequirementService } from "./requirements.js";
import { RequirementDirectoryResolver } from "./requirement-directory.js";

/**
 * @deprecated 旧阶段工作区 JSON（`requirement_workspaces`）的读写实现，仅为
 * `GET/PUT /api/requirements/:id/workspace` 的旧客户端兼容保留。进度语义以需求字段、
 * 阶段历史与问题/产出物统计（`RequirementProgressService`）为准。图片上传与读取方法
 * （`/api/requirements/:id/images`）仍在使用，不要随旧接口一并删除。
 */
export class StageWorkspaceService {
  private readonly directories: RequirementDirectoryResolver;
  constructor(
    private db: Database.Database,
    private root: string,
    private requirements: RequirementService,
    directories?: RequirementDirectoryResolver,
  ) {
    this.directories =
      directories ?? new RequirementDirectoryResolver(db, root);
  }
  get(id: number): StageWorkspace {
    this.requirements.get(id);
    const row = this.db
      .prepare(
        "SELECT content, version FROM requirement_workspaces WHERE requirement_id=?",
      )
      .get(id) as { content: string; version: number } | undefined;
    return row
      ? { ...JSON.parse(row.content), version: row.version }
      : {
          version: 0,
          designUrl: "",
          analysis: { analysisText: "", prdText: "" },
          design: [],
          development: [],
          testing: [],
        };
  }
  private directory(id: number, folder: string) {
    // 需求根目录统一解析（可读目录名 + 越界/符号链接防护）
    return this.directories.resolve(id, folder, true);
  }
  save(id: number, input: unknown) {
    const data = stageWorkspaceSchema.parse(input);
    return this.db
      .transaction(() => {
        const current = this.get(id);
        if (current.version !== data.version)
          throw new DomainError(
            "CONFLICT",
            "记录已被其他页面修改，请重新打开详情后编辑",
            409,
          );
        const directory = this.directory(id, "analysis");
        for (const [name, content] of [
          ["analysis.md", data.analysis.analysisText],
          ["prd.md", data.analysis.prdText],
        ]) {
          const path = join(directory, name);
          if (existsSync(path) && lstatSync(path).isSymbolicLink())
            throw new DomainError("INVALID_PATH", "产物文件不能是符号链接");
          writeFileSync(path, content, "utf8");
        }
        const result = { ...data, version: current.version + 1 };
        this.db
          .prepare(
            "INSERT INTO requirement_workspaces(requirement_id, content, version, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(requirement_id) DO UPDATE SET content=excluded.content, version=excluded.version, updated_at=excluded.updated_at",
          )
          .run(
            id,
            JSON.stringify(result),
            result.version,
            new Date().toISOString(),
          );
        return result;
      })
      .immediate();
  }
  upload(id: number, input: { data: string; mime: string }) {
    this.requirements.get(id);
    const buffer = Buffer.from(input.data, "base64");
    if (!buffer.length || buffer.length > 5 * 1024 * 1024)
      throw new DomainError("VALIDATION_ERROR", "图片大小应为 1 字节至 5 MB");
    const extensions: Record<string, string> = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/gif": "gif",
      "image/webp": "webp",
    };
    const extension = extensions[input.mime];
    const valid =
      extension === "png"
        ? buffer
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : extension === "jpg"
          ? buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255
          : extension === "gif"
            ? /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString())
            : extension === "webp"
              ? buffer.subarray(0, 4).toString() === "RIFF" &&
                buffer.subarray(8, 12).toString() === "WEBP"
              : false;
    if (!valid)
      throw new DomainError(
        "VALIDATION_ERROR",
        "仅支持 PNG、JPEG、GIF 或 WebP 图片",
      );
    const filename = `${randomUUID()}.${extension}`;
    writeFileSync(join(this.directory(id, "images"), filename), buffer, {
      flag: "wx",
    });
    return { url: `/api/requirements/${id}/images/${filename}` };
  }
  image(id: number, filename: string) {
    this.requirements.get(id);
    if (!/^[a-f0-9-]{36}\.(png|jpg|gif|webp)$/.test(filename))
      throw new DomainError("NOT_FOUND", "图片不存在", 404);
    const path = join(this.directory(id, "images"), filename);
    if (!existsSync(path) || lstatSync(path).isSymbolicLink())
      throw new DomainError("NOT_FOUND", "图片不存在", 404);
    return {
      data: readFileSync(path),
      mime: {
        png: "image/png",
        jpg: "image/jpeg",
        gif: "image/gif",
        webp: "image/webp",
      }[filename.split(".").pop()!]!,
    };
  }
}

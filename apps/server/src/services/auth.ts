import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import type Database from "better-sqlite3";
import { DomainError } from "./requirements.js";

// 会话有效期：7 天（毫秒）
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// scrypt 派生密钥长度（字节）
const SCRYPT_KEYLEN = 64;
export const AUTH_COOKIE_NAME = "superpm_token";

export interface AuthUser {
  id: number;
  username: string;
  displayName: string;
}

interface UserRow {
  id: number;
  username: string;
  display_name: string;
  password_hash: string;
  password_salt: string;
}

export class AuthService {
  private readonly db: Database.Database;
  // HMAC 签名密钥：首次启动随机生成并写入 app_meta，重启后保持不变
  private secret = "";

  constructor(db: Database.Database) {
    this.db = db;
  }

  /** 初始化：确保签名密钥与种子账号 admin 存在（幂等，可在每次启动时调用） */
  ensureSeed(): void {
    const meta = this.db
      .prepare("SELECT value FROM app_meta WHERE key = 'auth_secret'")
      .get() as { value: string } | undefined;
    if (meta) {
      this.secret = meta.value;
    } else {
      this.secret = randomBytes(32).toString("hex");
      this.db
        .prepare("INSERT INTO app_meta(key, value) VALUES ('auth_secret', ?)")
        .run(this.secret);
    }
    const admin = this.db
      .prepare("SELECT id FROM users WHERE username = 'admin'")
      .get();
    if (!admin) {
      const now = new Date().toISOString();
      this.createUser("admin", "管理员", "admin123", now);
    }
  }

  private createUser(
    username: string,
    displayName: string,
    password: string,
    now: string,
  ): number {
    const salt = randomBytes(16).toString("hex");
    const hash = this.hashPassword(password, salt);
    const result = this.db
      .prepare(
        "INSERT INTO users(username, display_name, password_hash, password_salt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(username, displayName, hash, salt, now, now);
    return Number(result.lastInsertRowid);
  }

  private hashPassword(password: string, salt: string): string {
    return scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  }

  private toUser(row: UserRow): AuthUser {
    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
    };
  }

  private findByUsername(username: string): UserRow | undefined {
    return this.db
      .prepare("SELECT * FROM users WHERE username = ?")
      .get(username) as UserRow | undefined;
  }

  private verifyPassword(row: UserRow, password: string): boolean {
    const expected = Buffer.from(row.password_hash, "hex");
    const actual = scryptSync(password, row.password_salt, SCRYPT_KEYLEN);
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  }

  /** 校验账号密码；成功返回用户与签名 Token，失败抛 401 */
  login(username: string, password: string): { user: AuthUser; token: string } {
    const row = this.findByUsername(username);
    // 用户不存在时同样执行一次 scrypt，避免响应时间差暴露账号是否存在
    if (!row) {
      scryptSync(password, "timing-equalize", SCRYPT_KEYLEN);
      throw new DomainError("AUTH_FAILED", "账号或密码错误", 401);
    }
    if (!this.verifyPassword(row, password))
      throw new DomainError("AUTH_FAILED", "账号或密码错误", 401);
    return { user: this.toUser(row), token: this.signToken(row.id) };
  }

  /** 按用户 ID 读取用户信息（会话内使用） */
  getUser(id: number): AuthUser {
    const row = this.db
      .prepare("SELECT * FROM users WHERE id = ?")
      .get(id) as UserRow | undefined;
    if (!row)
      throw new DomainError("UNAUTHORIZED", "登录已失效，请重新登录", 401);
    return this.toUser(row);
  }

  /** 修改密码：校验旧密码后更新派生密钥 */
  changePassword(userId: number, oldPassword: string, newPassword: string): void {
    const row = this.db
      .prepare("SELECT * FROM users WHERE id = ?")
      .get(userId) as UserRow | undefined;
    if (!row)
      throw new DomainError("UNAUTHORIZED", "登录已失效，请重新登录", 401);
    if (!this.verifyPassword(row, oldPassword))
      throw new DomainError("AUTH_FAILED", "原密码不正确", 400);
    const salt = randomBytes(16).toString("hex");
    const hash = this.hashPassword(newPassword, salt);
    this.db
      .prepare(
        "UPDATE users SET password_hash = ?, password_salt = ?, updated_at = ? WHERE id = ?",
      )
      .run(hash, salt, new Date().toISOString(), userId);
  }

  /** 签发会话 Token：payload 为 "userId.过期时间戳"，HMAC-SHA256 签名 */
  private signToken(userId: number): string {
    const payload = `${userId}.${Date.now() + TOKEN_TTL_MS}`;
    const signature = createHmac("sha256", this.secret)
      .update(payload)
      .digest("hex");
    return `${payload}.${signature}`;
  }

  /** 校验 Token：签名与有效期均通过时返回用户 ID，否则返回 null */
  verifyToken(token: string): number | null {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [userId, expiresAt, signature] = parts;
    if (!/^\d+$/.test(userId) || !/^\d+$/.test(expiresAt)) return null;
    const expected = createHmac("sha256", this.secret)
      .update(`${userId}.${expiresAt}`)
      .digest("hex");
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    if (Number(expiresAt) < Date.now()) return null;
    return Number(userId);
  }

  /** Token 有效期（秒），供 Cookie Max-Age 使用 */
  get tokenMaxAgeSeconds(): number {
    return Math.floor(TOKEN_TTL_MS / 1000);
  }
}

/** 序列化会话 Cookie：httpOnly + SameSite=Lax，本地服务无 TLS 故不启用 Secure */
export function serializeAuthCookie(token: string, maxAgeSeconds: number): string {
  return `${AUTH_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

/** 序列化清除 Cookie 的响应头（立即过期 + 空值） */
export function serializeClearAuthCookie(): string {
  return `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** 从请求 Cookie 头中解析会话 Token（无依赖，仅需识别单个认证 Cookie） */
export function parseAuthCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === AUTH_COOKIE_NAME) return decodeURIComponent(rest.join("="));
  }
  return null;
}

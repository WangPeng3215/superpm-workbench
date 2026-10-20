import type { FastifyInstance } from "fastify";

// 测试辅助：用种子账号 admin 登录一次，并把 app.inject 包装为自动携带会话 Cookie。
// 这样依赖业务接口的既有用例可按原样调用（鉴权在路由层，服务层直测的用例不受影响）。
export async function authedInject(app: FastifyInstance): Promise<void> {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "admin", password: "admin123" },
  });
  if (login.statusCode !== 200)
    throw new Error(`测试登录失败：${login.statusCode} ${login.body}`);
  const cookie = login.cookies
    .map((item) => `${item.name}=${item.value}`)
    .join("; ");
  const original = app.inject.bind(app);
  const patchable = app as unknown as { inject: unknown };
  patchable.inject = ((options: string | Record<string, unknown>) => {
    if (typeof options === "string")
      return original({ url: options, headers: { cookie } });
    return original({
      ...options,
      headers: { ...(options.headers as object), cookie },
    });
  }) as typeof app.inject;
}

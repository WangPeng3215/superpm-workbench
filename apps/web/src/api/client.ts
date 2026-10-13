import type { ApiErrorResponse } from "@superpm/shared";

export class ApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
    });
  } catch {
    throw new ApiError(
      "无法连接本地服务，请检查服务是否运行。",
      "CONNECTION_ERROR",
      0,
    );
  }
  if (!response.ok) {
    const payload = (await response
      .json()
      .catch(() => null)) as ApiErrorResponse | null;
    throw new ApiError(
      payload?.error?.message ?? "请求失败，请稍后重试。",
      payload?.error?.code ?? "HTTP_ERROR",
      response.status,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "操作失败，请重试。";

import { AsyncLocalStorage } from "node:async_hooks";
// A tool client name is an audit label, never an authenticated account.
const origins = new AsyncLocalStorage<"mcp">();
export const isUntrustedToolContext = () => origins.getStore() === "mcp";
export function runAsUntrustedTool<T>(fn: () => T): T {
  return origins.run("mcp", fn);
}

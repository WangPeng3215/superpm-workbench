import { createApp } from "./app.js";
const app = await createApp({ serveWeb: true });
const port = Number(process.env.PORT || 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  await app.close();
  throw new Error("PORT 必须为 1–65535 的整数");
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app
      .close()
      .then(() => process.exit(0))
      .catch((error) => {
        app.log.error(error);
        process.exit(1);
      });
  });
}
try {
  await app.listen({ host: "127.0.0.1", port });
} catch (error) {
  await app.close();
  throw error;
}

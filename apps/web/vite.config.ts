import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import rootManifest from "../../package.json";

const buildVersion = process.env.SUPERPM_BUILD_VERSION || rootManifest.version;

export default defineConfig({
  plugins: [vue()],
  define: {
    __APP_VERSION__: JSON.stringify(buildVersion),
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:3001" },
  },
  build: { chunkSizeWarningLimit: 1500 },
});

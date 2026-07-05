// Same as vite.preview-claude.config.ts but on :5201 so a second review
// session can run alongside the primary one without port conflicts.
import { mergeConfig } from "vite";
import baseConfig from "./vite.config";

export default mergeConfig(baseConfig, {
  server: {
    host: "127.0.0.1",
    port: 5201,
    strictPort: true,
    hmr: { clientPort: 5201 },
    proxy: {
      "/api": {
        target: "http://localhost:8091",
        changeOrigin: true,
        ws: true,
      },
    },
  },
});

// Temporary config for local UI review sessions: runs the Vite dev server
// against the already-running Docker stack (nginx on :8091) by proxying /api.
// Not used by any build or compose path.
import { mergeConfig } from "vite";
import baseConfig from "./vite.config";

export default mergeConfig(baseConfig, {
  server: {
    host: "127.0.0.1",
    port: 5199,
    strictPort: true,
    hmr: { clientPort: 5199 },
    proxy: {
      "/api": {
        target: "http://localhost:8091",
        changeOrigin: true,
        ws: true,
      },
    },
  },
});

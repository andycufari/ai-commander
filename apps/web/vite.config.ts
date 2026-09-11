import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The backend owns the session; the dev server only serves the app.
    proxy: {
      "/ws": { target: "ws://127.0.0.1:7777", ws: true },
      "/file": "http://127.0.0.1:7777",
      "/upload": "http://127.0.0.1:7777",
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});

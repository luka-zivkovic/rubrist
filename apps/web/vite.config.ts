import { defineConfig, type Connect, type Plugin } from "vite";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// SPIKE: a view mod's HTML is only ever read as text and drawn inside a
// sandboxed frame. Opened directly it must not run with this app's origin.
// nginx.conf sets the same headers for the built app.
const viewModHeaders = (): Plugin => {
  const use = (server: { middlewares: Connect.Server }) => {
    server.middlewares.use((request, response, next) => {
      if (request.url?.startsWith("/mods/")) {
        response.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
        response.setHeader("X-Content-Type-Options", "nosniff");
      }
      next();
    });
  };
  return { name: "rubrist-view-mod-headers", configureServer: use, configurePreviewServer: use };
};

export default defineConfig({
  plugins: [viewModHeaders(), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
    }
  },
  server: {
    port: Number(process.env.WEB_PORT) || 5173,
    proxy: {
      "/api": process.env.RUBRIST_API_ORIGIN || "http://localhost:8787",
      "/health": process.env.RUBRIST_API_ORIGIN || "http://localhost:8787"
    }
  }
});

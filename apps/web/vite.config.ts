import { defineConfig, type Connect, type Plugin } from "vite";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The app is never shown inside another page, and a view mod's HTML is only
// ever read as text and drawn inside a sandboxed frame: opened directly it must
// not run with this app's origin. nginx.conf sets the same headers for the
// built app.
const frameHeaders = (): Plugin => {
  const use = (server: { middlewares: Connect.Server }) => {
    server.middlewares.use((request, response, next) => {
      const mod = request.url?.startsWith("/mods/") ?? false;
      response.setHeader("Content-Security-Policy", mod ? "sandbox; default-src 'none'; frame-ancestors 'none'" : "frame-ancestors 'none'");
      response.setHeader("X-Frame-Options", "DENY");
      if (mod) response.setHeader("X-Content-Type-Options", "nosniff");
      next();
    });
  };
  return { name: "rubrist-frame-headers", configureServer: use, configurePreviewServer: use };
};

export default defineConfig({
  plugins: [frameHeaders(), react(), tailwindcss()],
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

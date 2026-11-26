import { fileURLToPath, URL } from "node:url";
import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const upstream = process.env.CFSM_DEV_UPSTREAM;
const observatory = process.env.BLACKWHITE_DEV_UPSTREAM;
const proxy: Record<string, string | ProxyOptions> = {};
if (observatory) proxy["/api/blackwhite-network-observatory"] = observatory;
if (upstream) {
  proxy["/api"] = { target: upstream, ws: true };
  for (const path of ["/admin", "/static", "/favicon.png", "/flags", "/os-icons"]) proxy[path] = upstream;
}

export default defineConfig({
  server: { proxy },
  preview: { proxy },
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    manifest: false,
    target: ["es2020", "safari15.4", "chrome87"],
    rollupOptions: {
      output: {
        // Keep vendor dependencies stable and network-only icons lazy. Priority
        // prevents icon groups from absorbing React or the shared icon factory.
        codeSplitting: {
          groups: [
            {
              name: "react",
              test: /node_modules[\\/](?:react|react-dom|react-router|react-router-dom)[\\/]/,
              priority: 40,
            },
            {
              name: "query",
              test: /node_modules[\\/]@tanstack[\\/]react-query[\\/]/,
              priority: 30,
            },
            {
              name: "validation",
              test: /node_modules[\\/]zod[\\/]/,
              priority: 30,
            },
            {
              name: "icon-core",
              test: /lucide-react[\\/]dist[\\/]esm[\\/](?:createLucideIcon|Icon|defaultAttributes|shared[\\/]src[\\/]utils)\.js$/,
              priority: 20,
            },
            {
              name: "network-icons",
              test: /lucide-react[\\/]dist[\\/]esm[\\/]icons[\\/](?:radio|layers-3|file-json|book-open|terminal|globe-2)\.js$/,
              priority: 10,
            },
          ],
        },
      },
    },
  },
});

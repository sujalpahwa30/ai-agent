import react from "@vitejs/plugin-react";
import { defineConfig } from 'vite'
import path from "path";

// https://vite.dev/config/
// eslint-disable-next-line no-empty-pattern
export default defineConfig(({ }) => ({
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
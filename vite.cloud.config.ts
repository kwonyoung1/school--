import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { renameSync } from "node:fs";
export default defineConfig({
  plugins: [
    react(),
    {
      name: "cloud-index",
      closeBundle() {
        renameSync("dist-cloud/index-cloud.html", "dist-cloud/index.html");
      },
    },
  ],
  define: { "import.meta.env.VITE_CLOUD": "true" },
  build: { outDir: "dist-cloud", rollupOptions: { input: "index-cloud.html" } },
});

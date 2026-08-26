import { defineConfig } from "vitest/config";

export default defineConfig({
  // Relative base: the built app can be served from any sub-path.
  base: "./",
  build: {
    target: "safari15",
    sourcemap: true,
  },
  server: {
    host: true,
    // getUserMedia needs a secure context, and on iPadOS a self-signed
    // certificate has to be trusted on the device first. README documents
    // the two setups that work.
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});

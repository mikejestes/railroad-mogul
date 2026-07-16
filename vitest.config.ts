import { defineConfig } from 'vitest/config';

// Vitest owns its own config so it uses its bundled Vite (no plugin-type
// clash with the app's vite.config.ts). esbuild handles the JSX in the
// UI/store test files; the sim kernel suites are plain TypeScript.
export default defineConfig({
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  test: {
    globals: true,
    // Default to node for the deterministic sim suites. UI/store selector
    // suites opt into jsdom per-file via `// @vitest-environment jsdom`.
    environment: 'node',
  },
});

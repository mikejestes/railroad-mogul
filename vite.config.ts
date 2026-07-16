import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// App build config. Test config lives in vitest.config.ts so the two Vite
// type surfaces (app vs. Vitest's bundled Vite) never collide.
export default defineConfig({
  plugins: [react()],
});

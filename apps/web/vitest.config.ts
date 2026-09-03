import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Vitest config for apps/web (React 18 client components, Next.js 15 App Router).
// This runs component/unit tests only — it does not build or serve the Next app, so
// server components, route handlers, and anything that needs the Next runtime are out
// of scope here. Everything under test is a 'use client' component or a plain module.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Mirrors the `@/*` -> `./*` path mapping in apps/web/tsconfig.json.
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
    css: false,
  },
});

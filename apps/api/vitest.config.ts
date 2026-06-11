import { defineConfig } from 'vitest/config';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// The source uses NodeNext-style explicit `.js` import specifiers (e.g. './sla.js').
// This small resolver maps those to the sibling `.ts` source so Vitest can load them.
export default defineConfig({
  plugins: [
    {
      name: 'js-to-ts',
      enforce: 'pre',
      resolveId(source: string, importer?: string) {
        if (importer && source.endsWith('.js') && (source.startsWith('./') || source.startsWith('../'))) {
          const tsPath = resolve(dirname(importer), source.replace(/\.js$/, '.ts'));
          if (existsSync(tsPath)) return tsPath;
        }
        return null;
      },
    },
  ],
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});

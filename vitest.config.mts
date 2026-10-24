import { defineConfig } from 'vitest/config';

export default defineConfig({
    resolve: {
        // Vite would load graphql's ESM build for source files while Apollo loads the CJS build,
        // and graphql rejects schema objects that come from the other copy.
        alias: [{ find: /^graphql$/, replacement: 'graphql/index.js' }],
    },
    test: {
        globals: true,
        environment: 'node',
        coverage: { reporter: ['text', 'lcov'] }, // lcov reporter is used by IDE coverage extensions
        include: ['./**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
        testTimeout: 120_000,
        hookTimeout: 120_000,
        setupFiles: ['/test/vitest-env.ts'],
    },
});

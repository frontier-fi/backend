import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['test/e2e/**/*.e2e.ts'],
        fileParallelism: false,
        sequence: { concurrent: false },
        bail: 1,
        testTimeout: 600_000,
        hookTimeout: 180_000,
    },
});

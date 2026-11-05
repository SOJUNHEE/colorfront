import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
        environment: 'node',
        // Network tests share one server per file; keep files isolated and serial.
        fileParallelism: false,
        testTimeout: 15000
    }
});

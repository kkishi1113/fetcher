import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    // vi.spyOn(AbortSignal, 'timeout') などの差し替えをテストごとに元へ戻す
    restoreMocks: true,
  },
});

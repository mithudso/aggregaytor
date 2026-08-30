import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Vitest's default `exclude` is replaced (not merged) when set, so spread
    // the defaults. `.claude/worktrees/*` holds full checkouts of this repo —
    // without this, a root-level `vitest run` collects and runs a duplicate,
    // possibly stale, copy of every test file in the workspace.
    exclude: [...configDefaults.exclude, '**/.claude/**'],
    // File-level parallelism (these match Vitest 3 defaults; pinned so a future
    // default change can't silently serialize the suite).
    fileParallelism: true,
    pool: 'forks',
    isolate: true,
  },
});

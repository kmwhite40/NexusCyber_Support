// Shared helper for DB-backed integration tests. When DATABASE_URL is unset
// (the default for fast local unit runs and the existing CI unit job), the
// returned `describeDb` is `describe.skip`, so integration suites are skipped
// cleanly rather than failing.
import { describe } from 'vitest';

export const hasDb = !!process.env.DATABASE_URL;

/** Use in place of `describe` for suites that need a live Postgres. */
export const describeDb: typeof describe.skip = hasDb ? describe : describe.skip;

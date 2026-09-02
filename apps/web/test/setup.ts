// Vitest setup for apps/web — extends `expect` with the jest-dom matchers
// (toBeInTheDocument, etc.) used across component tests.
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Testing Library auto-cleans only when Vitest's globals are injected, and this project
// runs without `globals: true`. Without an explicit cleanup every render in a file stacks
// up in the same document, so the second `getByRole` in a suite hits "found multiple
// elements" and a test can silently assert against a PREVIOUS test's DOM.
afterEach(cleanup);

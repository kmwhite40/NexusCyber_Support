// Minimal classnames join helper (keeps the vendored UI dependency-light).
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

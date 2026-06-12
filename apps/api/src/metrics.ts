// Lightweight, dependency-free in-process metrics (Prometheus text exposition).
// Counters are incremented at call sites (HTTP responses, domain events); render() emits
// the standard text format scraped at GET /metrics. A real deployment swaps this for a
// prom-client registry, but the exposition contract is identical.

interface Counter {
  name: string;
  help: string;
  labels: Record<string, string>;
  value: number;
}

const counters = new Map<string, Counter>();

function keyFor(name: string, labels: Record<string, string>): string {
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`);
  return `${name}{${parts.join(',')}}`;
}

/** Increment a counter (creating it on first use). */
export function incCounter(name: string, labels: Record<string, string> = {}, by = 1, help = ''): void {
  const k = keyFor(name, labels);
  const existing = counters.get(k);
  if (existing) existing.value += by;
  else counters.set(k, { name, help: help || name, labels, value: by });
}

/** Clear all counters (test helper). */
export function resetMetrics(): void {
  counters.clear();
}

function fmtLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return `{${keys.map((k) => `${k}="${labels[k].replace(/"/g, '')}"`).join(',')}}`;
}

/** Render all counters in Prometheus text exposition format. Pure over current state. */
export function renderMetrics(): string {
  // Group by metric name so each gets a single # TYPE line.
  const byName = new Map<string, Counter[]>();
  for (const c of counters.values()) {
    const list = byName.get(c.name) ?? [];
    list.push(c);
    byName.set(c.name, list);
  }
  const lines: string[] = [];
  for (const [name, series] of [...byName.entries()].sort()) {
    lines.push(`# HELP ${name} ${series[0].help}`);
    lines.push(`# TYPE ${name} counter`);
    for (const c of series.sort((a, b) => keyFor(a.name, a.labels).localeCompare(keyFor(b.name, b.labels)))) {
      lines.push(`${name}${fmtLabels(c.labels)} ${c.value}`);
    }
  }
  return lines.join('\n') + '\n';
}

/** Map an HTTP status code to a status class label (2xx/4xx/5xx). */
export function statusClass(code: number): string {
  return `${Math.floor(code / 100)}xx`;
}

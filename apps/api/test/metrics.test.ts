import { describe, it, expect, beforeEach } from 'vitest';
import { incCounter, renderMetrics, resetMetrics, statusClass } from '../src/metrics.js';

beforeEach(() => resetMetrics());

describe('statusClass', () => {
  it('maps codes to status classes', () => {
    expect(statusClass(200)).toBe('2xx');
    expect(statusClass(404)).toBe('4xx');
    expect(statusClass(503)).toBe('5xx');
  });
});

describe('metrics counters', () => {
  it('accumulates by name+labels', () => {
    incCounter('http_requests_total', { status: '2xx' });
    incCounter('http_requests_total', { status: '2xx' });
    incCounter('http_requests_total', { status: '4xx' });
    const out = renderMetrics();
    expect(out).toContain('http_requests_total{status="2xx"} 2');
    expect(out).toContain('http_requests_total{status="4xx"} 1');
  });

  it('emits one HELP and TYPE line per metric name', () => {
    incCounter('domain_events_total', { type: 'sla.breached' });
    incCounter('domain_events_total', { type: 'ticket.created' });
    const out = renderMetrics();
    expect((out.match(/# TYPE domain_events_total counter/g) ?? []).length).toBe(1);
    expect((out.match(/# HELP domain_events_total/g) ?? []).length).toBe(1);
  });

  it('renders deterministically (sorted)', () => {
    incCounter('a_total', { z: '1' });
    incCounter('a_total', { a: '1' });
    const out = renderMetrics();
    const aIdx = out.indexOf('a_total{a="1"}');
    const zIdx = out.indexOf('a_total{z="1"}');
    expect(aIdx).toBeLessThan(zIdx);
  });
});

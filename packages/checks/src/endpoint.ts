import type { Sample } from '@buho/core';
import type { CheckResult } from './types';

/**
 * Checks for engine=endpoint synthetic probes (from latest samples).
 */
export function evaluateEndpointSamples(samples: Sample[]): CheckResult[] {
  const byMetric = new Map<string, number>();
  for (const s of samples) {
    byMetric.set(s.metric, s.value);
  }

  const results: CheckResult[] = [];
  const up = byMetric.get('endpoint_up');
  if (up === 0) {
    results.push({
      checkId: 'endpoint.down',
      title: 'Endpoint down',
      severity: 'critical',
      object: 'endpoint',
      message: 'Endpoint probe failed',
      remediation: 'Check URL, DNS, firewall, and that the service is listening.',
      value: 0,
    });
  }

  const httpOk = byMetric.get('endpoint_http_ok');
  if (httpOk === 0 && up !== 0) {
    results.push({
      checkId: 'endpoint.http',
      title: 'HTTP assertion failed',
      severity: 'critical',
      object: 'http',
      message: 'HTTP assertion failed (status or body)',
      remediation: 'Compare expectStatus / body asserts with the live response.',
      value: byMetric.get('endpoint_http_status') ?? 0,
    });
  }

  const ms = byMetric.get('endpoint_http_ms');
  if (ms != null && ms >= 2000 && httpOk === 1) {
    results.push({
      checkId: 'endpoint.slow',
      title: 'Endpoint slow',
      severity: ms >= 5000 ? 'warning' : 'info',
      object: 'latency',
      message: `HTTP latency ${Math.round(ms)} ms`,
      remediation: 'Correlate with Traces and the linked database instance.',
      value: ms,
    });
  }

  const days = byMetric.get('endpoint_tls_days_left');
  if (days != null && days < 7) {
    results.push({
      checkId: 'endpoint.tls',
      title: 'TLS certificate expiring',
      severity: 'critical',
      object: 'tls',
      message: `TLS certificate expires in ${days} day(s)`,
      remediation: 'Renew the certificate before it expires.',
      value: days,
    });
  } else if (days != null && days < 30) {
    results.push({
      checkId: 'endpoint.tls',
      title: 'TLS certificate expiring soon',
      severity: 'warning',
      object: 'tls',
      message: `TLS certificate expires in ${days} day(s)`,
      remediation: 'Schedule certificate renewal.',
      value: days,
    });
  }

  const tcpOk = byMetric.get('endpoint_tcp_ok');
  if (tcpOk === 0) {
    results.push({
      checkId: 'endpoint.tcp',
      title: 'TCP connect failed',
      severity: 'critical',
      object: 'tcp',
      message: 'TCP connect failed',
      remediation: 'Host unreachable or port closed.',
      value: 0,
    });
  }

  return results;
}

export function endpointHealthScore(results: CheckResult[]): number {
  let score = 100;
  for (const r of results) {
    if (r.severity === 'critical') score -= 25;
    else if (r.severity === 'warning') score -= 8;
    else score -= 1;
  }
  return Math.max(0, Math.min(100, score));
}

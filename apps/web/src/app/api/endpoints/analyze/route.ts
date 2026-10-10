import { NextResponse } from 'next/server';
import { analyzeBaseUrl, BUHO_CONSOLE_PATHS } from '@buho/core';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * One-shot base-URL analysis (Kibana Uptime / Heartbeat style).
 * POST { baseUrl, catalog?: 'buho'|'custom', paths?: string[], expectStatus?: number[] }
 */
export async function POST(request: Request) {
  let body: {
    baseUrl?: string;
    catalog?: 'buho' | 'custom';
    paths?: string[];
    expectStatus?: number[];
    timeoutMs?: number;
    concurrency?: number;
    warnMs?: number;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const baseUrl = body.baseUrl?.trim();
  if (!baseUrl) {
    return NextResponse.json({ error: 'baseUrl required' }, { status: 400 });
  }

  try {
    const result = await analyzeBaseUrl({
      baseUrl,
      catalog: body.catalog ?? 'buho',
      paths: body.paths,
      expectStatus: body.expectStatus,
      timeoutMs: body.timeoutMs,
      concurrency: body.concurrency ?? 8,
      warnMs: body.warnMs ?? 1500,
    });
    return NextResponse.json({
      ...result,
      catalogSize: BUHO_CONSOLE_PATHS.length,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}

export async function GET() {
  return NextResponse.json({
    catalogs: {
      buho: { paths: BUHO_CONSOLE_PATHS, count: BUHO_CONSOLE_PATHS.length },
    },
    usage: {
      method: 'POST',
      body: {
        baseUrl: 'http://127.0.0.1:3100',
        catalog: 'buho',
        paths: ['optional', 'custom', 'list'],
      },
    },
  });
}

import { NextResponse } from 'next/server';
import { currentSession } from '@/lib/session';
import { getWeeklyReport } from '@/lib/report';
import { reportFilename, reportToMarkdown } from '@/lib/report-markdown';

/**
 * Descarga del informe.
 *
 * Es una ruta y no un botón que arme el archivo en el navegador para que el
 * informe se pueda pedir desde cron o desde un script y quede archivado sin
 * que nadie abra la consola.
 */
export async function GET(request: Request) {
  // El proxy ya exige sesión para llegar hasta acá; esta comprobación es la
  // que sobrevive si alguien mueve la ruta o cambia el matcher.
  const session = await currentSession();
  if (session.role !== 'admin' && session.role !== 'viewer') {
    return new NextResponse('Not authenticated', { status: 401 });
  }

  const url = new URL(request.url);
  const weeksAgo = Math.max(0, Math.min(12, Number(url.searchParams.get('semana') ?? 0) || 0));
  const report = await getWeeklyReport(weeksAgo);

  return new NextResponse(reportToMarkdown(report), {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="${reportFilename(report)}"`,
      'cache-control': 'no-store',
    },
  });
}

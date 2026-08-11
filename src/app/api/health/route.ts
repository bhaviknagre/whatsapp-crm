import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'

/**
 * Uptime/readiness check. Unauthenticated by design (monitors don't
 * carry app credentials) — the response never includes row data, only
 * a boolean reachability signal, so it's safe to expose publicly.
 *
 * Pings a tiny, always-present table rather than just returning 200
 * unconditionally: the previous "healthcheck" was `fetch('/')`, which
 * only proves the Next.js process is up, not that it can reach the
 * database — the actual dependency inbound webhooks and every route
 * need.
 */
export async function GET() {
  const startedAt = Date.now()

  try {
    const { error } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('id', { count: 'exact', head: true })
      .limit(1)

    if (error) {
      return NextResponse.json(
        { status: 'error', database: 'unreachable', error: error.message },
        { status: 503 }
      )
    }

    return NextResponse.json({
      status: 'ok',
      database: 'reachable',
      latency_ms: Date.now() - startedAt,
    })
  } catch (error) {
    return NextResponse.json(
      {
        status: 'error',
        database: 'unreachable',
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 503 }
    )
  }
}

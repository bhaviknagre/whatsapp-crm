import crypto from 'node:crypto'
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/bookings/admin-client'

/**
 * Rotate the unguessable `webhook_token` embedded in the inbound
 * webhook URL — e.g. after suspecting the URL leaked. The old URL
 * stops resolving immediately; the account must re-paste the new URL
 * into Cal.com's webhook config.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }

  const { id } = await params
  const admin = supabaseAdmin()

  const newToken = crypto.randomBytes(24).toString('base64url')
  const { data: updated, error } = await admin
    .from('calendar_integrations')
    .update({ webhook_token: newToken, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .select('id, provider, webhook_token')
    .single()

  if (error || !updated) {
    return NextResponse.json({ error: 'Integration not found' }, { status: 404 })
  }

  const base = (process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin).replace(/\/+$/, '')
  return NextResponse.json({
    webhook_url: `${base}/api/webhooks/calendar/cal/${updated.webhook_token}`,
  })
}

import crypto from 'node:crypto'
import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/bookings/admin-client'
import { encrypt } from '@/lib/whatsapp/encryption'

// Calendar webhook integrations (Cal.com now; Google Calendar rows are
// accepted but the OAuth flow itself isn't wired up yet — see the
// booking lifecycle plan). Settings-class, admin-gated writes, mirrors
// the whatsapp_config / webhook_endpoints route conventions.

function webhookUrlFor(request: Request, token: string): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin).replace(/\/+$/, '')
  return `${base}/api/webhooks/calendar/cal/${token}`
}

export async function GET(request: Request) {
  try {
    const { supabase } = await getCurrentAccount()
    // RLS (calendar_integrations_select) scopes to the caller's account.
    const { data, error } = await supabase
      .from('calendar_integrations')
      .select(
        'id, provider, webhook_token, default_reschedule_url, is_active, created_at, updated_at, webhook_secret, oauth_refresh_token',
      )
      .order('created_at', { ascending: true })

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const integrations = (data ?? []).map((row) => ({
      id: row.id,
      provider: row.provider,
      webhook_url: row.provider === 'cal_com' ? webhookUrlFor(request, row.webhook_token) : null,
      default_reschedule_url: row.default_reschedule_url,
      is_active: row.is_active,
      has_webhook_secret: Boolean(row.webhook_secret),
      is_connected: row.provider === 'google_calendar' ? Boolean(row.oauth_refresh_token) : Boolean(row.webhook_secret),
      created_at: row.created_at,
      updated_at: row.updated_at,
    }))

    return NextResponse.json({ integrations })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * Create or update the account's Cal.com integration. Upserts on
 * (account_id, provider) — there is one row per provider per account.
 * `webhook_secret` is only overwritten when a new non-empty value is
 * submitted (mirrors whatsapp_config's access_token handling — the UI
 * never re-populates the field with a real value after save).
 */
export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const provider = body.provider === 'google_calendar' ? 'google_calendar' : 'cal_com'
  if (provider === 'google_calendar') {
    return NextResponse.json(
      { error: 'Google Calendar isn’t connected yet — coming soon.' },
      { status: 400 },
    )
  }

  const webhookSecret = typeof body.webhook_secret === 'string' ? body.webhook_secret.trim() : ''
  const defaultRescheduleUrl =
    typeof body.default_reschedule_url === 'string' ? body.default_reschedule_url.trim() : null

  const admin = supabaseAdmin()

  const { data: existing } = await admin
    .from('calendar_integrations')
    .select('id, webhook_token, webhook_secret')
    .eq('account_id', ctx.accountId)
    .eq('provider', provider)
    .maybeSingle()

  if (!existing && !webhookSecret) {
    return NextResponse.json(
      { error: 'webhook_secret is required for initial setup' },
      { status: 400 },
    )
  }

  const webhookToken = existing?.webhook_token ?? crypto.randomBytes(24).toString('base64url')

  const row: Record<string, unknown> = {
    account_id: ctx.accountId,
    provider,
    webhook_token: webhookToken,
    default_reschedule_url: defaultRescheduleUrl,
    is_active: true,
    updated_at: new Date().toISOString(),
  }
  if (webhookSecret) {
    row.webhook_secret = encrypt(webhookSecret)
  }

  const { data: saved, error } = existing
    ? await admin.from('calendar_integrations').update(row).eq('id', existing.id).select().single()
    : await admin.from('calendar_integrations').insert(row).select().single()

  if (error || !saved) {
    console.error('[settings/calendar-integrations] save failed:', error)
    return NextResponse.json({ error: 'Failed to save integration' }, { status: 500 })
  }

  return NextResponse.json({
    integration: {
      id: saved.id,
      provider: saved.provider,
      webhook_url: webhookUrlFor(request, saved.webhook_token),
      default_reschedule_url: saved.default_reschedule_url,
      is_active: saved.is_active,
    },
  })
}

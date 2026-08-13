// ============================================================
// Inbound Cal.com webhook — BOOKING_CREATED / BOOKING_RESCHEDULED /
// BOOKING_CANCELLED.
//
// `accountToken` resolves which account this belongs to
// (`calendar_integrations.webhook_token`) — Cal.com's webhook config
// has no custom-header support, so the account has to be identified
// from the URL itself rather than an auth header. The signature check
// (`Cal-Signature-256`) is what actually authenticates the request;
// the token is a lookup key, not a secret on its own — treat it as
// unguessable (generated server-side) rather than as the sole guard.
// ============================================================

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { verifyCalComSignature, parseCalComPayload } from '@/lib/bookings/providers/cal-com'
import { handleCalComWebhookEvent } from '@/lib/bookings/booking-engine'

function supabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ accountToken: string }> },
) {
  const { accountToken } = await params
  const admin = supabaseAdmin()

  const { data: integration, error: integrationError } = await admin
    .from('calendar_integrations')
    .select('*')
    .eq('webhook_token', accountToken)
    .eq('provider', 'cal_com')
    .eq('is_active', true)
    .maybeSingle()

  if (integrationError || !integration) {
    // Don't distinguish "no such token" from "inactive" in the
    // response — no information leak about which tokens are live.
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const rawBody = await request.text()

  if (!integration.webhook_secret) {
    console.error(
      `[calendar-webhook] account ${integration.account_id} has no webhook_secret configured — rejecting.`,
    )
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 })
  }

  let secret: string
  try {
    secret = decrypt(integration.webhook_secret)
  } catch (err) {
    console.error('[calendar-webhook] webhook_secret decryption failed:', err)
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 })
  }

  const signatureHeader = request.headers.get('Cal-Signature-256')
  if (!verifyCalComSignature(rawBody, signatureHeader, secret)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = parseCalComPayload(body)
  if (!parsed) {
    // Recognized-but-unhandled trigger event (Cal.com fires many more
    // than the three we act on), or a malformed payload we can't use.
    // 200 so Cal.com doesn't retry indefinitely.
    return NextResponse.json({ ok: true, skipped: true })
  }

  try {
    const result = await handleCalComWebhookEvent(admin, integration, parsed, body)
    return NextResponse.json({ ok: true, bookingId: result?.bookingId ?? null })
  } catch (err) {
    console.error('[calendar-webhook] processing failed:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}

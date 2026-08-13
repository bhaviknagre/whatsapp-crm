import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/bookings/admin-client'
import { processReminderRow } from '@/lib/bookings/process-reminder'
import type { ReminderKind } from '@/lib/bookings/reminders'

/**
 * Drain due `booking_reminders` rows. Meant to be hit on a schedule
 * (external pinger — same convention as /api/automations/cron and
 * /api/flows/cron) — requires a shared secret via the `x-cron-secret`
 * header to match `BOOKING_CRON_SECRET`.
 *
 * A separate secret from `AUTOMATION_CRON_SECRET` by design: a missed
 * or early booking reminder is a real business cost (a no-show, or a
 * reminder firing before it should), so this endpoint should be
 * rotatable independently of the automations/flows cron.
 *
 * The claim step (status = 'running') serves as a simple lock so
 * overlapping invocations don't double-send. Failed rows retry up to
 * 3 times before being marked `failed`.
 */
export async function GET(request: Request) {
  const expected = process.env.BOOKING_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  const { data: due, error } = await admin
    .from('booking_reminders')
    .select('*')
    .eq('status', 'pending')
    .lte('run_at', new Date().toISOString())
    .order('run_at', { ascending: true })
    .limit(50)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!due || due.length === 0) return NextResponse.json({ processed: 0 })

  const MAX_ATTEMPTS = 3
  let processed = 0
  let failed = 0

  for (const row of due) {
    const { data: claim } = await admin
      .from('booking_reminders')
      .update({ status: 'running', attempts: (row.attempts as number) + 1 })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id, attempts')
      .maybeSingle()
    if (!claim) continue

    try {
      await processReminderRow(admin, {
        id: row.id as string,
        account_id: row.account_id as string,
        booking_id: row.booking_id as string,
        kind: row.kind as ReminderKind,
      })
      await admin.from('booking_reminders').update({ status: 'done' }).eq('id', row.id)
      processed++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[bookings/cron] row ${row.id} (${row.kind}) failed:`, message)
      const attempts = claim.attempts as number
      await admin
        .from('booking_reminders')
        .update({
          status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
          last_error: message,
        })
        .eq('id', row.id)
      failed++
    }
  }

  return NextResponse.json({ processed, failed })
}

// ============================================================
// booking_reminders queue management.
//
// Every lifecycle send — including the initial confirmation — goes
// through this queue rather than being sent synchronously inline from
// the webhook handler. That keeps the webhook handler fast (it just
// upserts rows) and crash-safe (a send that fails mid-flight is
// retried by the next cron tick instead of being silently lost if the
// request process dies right after the calendar webhook is ack'd).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

export type ReminderKind =
  | 'confirmation'
  | 'meeting_link'
  | 'cancellation'
  | 'reminder_1h'
  | 'reminder_15m'
  | 'no_show_check'
  | 'no_show_followup_1m'
  | 'no_show_followup_4h'

interface BookingTiming {
  id: string
  account_id: string
  meeting_start_at: string
  meeting_end_at: string
  meeting_link?: string | null
}

/**
 * (Re)schedule the standard reminder set for a booking: an immediate
 * confirmation (plus a `meeting_link` send right after it, only when
 * the booking has a video-call link), T-1h / T-15m reminders (skipped
 * if already in the past — e.g. a booking created less than an hour
 * before its start time), and a no-show check at meeting end.
 *
 * Upserts on (booking_id, kind), so calling this again after a
 * reschedule naturally satisfies "update reminders" — the new
 * `run_at` values overwrite the old ones instead of accumulating
 * duplicate rows.
 */
export async function scheduleReminders(
  db: SupabaseClient,
  booking: BookingTiming,
): Promise<void> {
  const now = Date.now()
  const start = new Date(booking.meeting_start_at).getTime()
  const end = new Date(booking.meeting_end_at).getTime()

  const rows: { kind: ReminderKind; run_at: string }[] = [
    { kind: 'confirmation', run_at: new Date(now).toISOString() },
  ]

  if (booking.meeting_link) {
    // A few seconds after the confirmation so it lands as a distinct,
    // easy-to-tap message rather than racing it in the same batch.
    rows.push({ kind: 'meeting_link', run_at: new Date(now + 5_000).toISOString() })
  }

  const oneHourBefore = start - 60 * 60 * 1000
  if (oneHourBefore > now) {
    rows.push({ kind: 'reminder_1h', run_at: new Date(oneHourBefore).toISOString() })
  }

  const fifteenMinBefore = start - 15 * 60 * 1000
  if (fifteenMinBefore > now) {
    rows.push({ kind: 'reminder_15m', run_at: new Date(fifteenMinBefore).toISOString() })
  }

  rows.push({ kind: 'no_show_check', run_at: new Date(end).toISOString() })

  const { error } = await db.from('booking_reminders').upsert(
    rows.map((r) => ({
      account_id: booking.account_id,
      booking_id: booking.id,
      kind: r.kind,
      run_at: r.run_at,
      status: 'pending',
      attempts: 0,
      last_error: null,
    })),
    { onConflict: 'booking_id,kind' },
  )

  if (error) {
    console.error('[bookings] scheduleReminders upsert failed:', error)
  }
}

/**
 * Cancel pending reminders for a booking — used on reschedule (before
 * re-scheduling with new times) and on cancellation. `kinds` narrows
 * to specific kinds; omitted cancels every still-pending kind.
 */
export async function cancelReminders(
  db: SupabaseClient,
  bookingId: string,
  kinds?: ReminderKind[],
): Promise<void> {
  let query = db
    .from('booking_reminders')
    .update({ status: 'cancelled' })
    .eq('booking_id', bookingId)
    .eq('status', 'pending')

  if (kinds && kinds.length > 0) {
    query = query.in('kind', kinds)
  }

  const { error } = await query
  if (error) {
    console.error('[bookings] cancelReminders failed:', error)
  }
}

/**
 * Enqueue the two no-show follow-up sends. `runFrom` anchors the
 * offsets — the cron's automatic detection anchors on the meeting's
 * actual end time, while a manual "mark No-Show" from the inbox
 * anchors on `now()` per the "immediately triggers" requirement.
 */
export async function scheduleNoShowFollowups(
  db: SupabaseClient,
  booking: { id: string; account_id: string },
  runFrom: Date = new Date(),
): Promise<void> {
  const base = runFrom.getTime()
  const rows = [
    { kind: 'no_show_followup_1m' as const, run_at: new Date(base + 60 * 1000).toISOString() },
    {
      kind: 'no_show_followup_4h' as const,
      run_at: new Date(base + 4 * 60 * 60 * 1000).toISOString(),
    },
  ]

  const { error } = await db.from('booking_reminders').upsert(
    rows.map((r) => ({
      account_id: booking.account_id,
      booking_id: booking.id,
      kind: r.kind,
      run_at: r.run_at,
      status: 'pending',
      attempts: 0,
      last_error: null,
    })),
    { onConflict: 'booking_id,kind' },
  )

  if (error) {
    console.error('[bookings] scheduleNoShowFollowups upsert failed:', error)
  }
}

/**
 * Enqueue an immediate cancellation-notice send. Queued (not sent
 * synchronously from the webhook route) for the same crash-safety
 * reason as `confirmation` in `scheduleReminders`.
 */
export async function scheduleCancellationSend(
  db: SupabaseClient,
  booking: { id: string; account_id: string },
): Promise<void> {
  const { error } = await db.from('booking_reminders').upsert(
    [
      {
        account_id: booking.account_id,
        booking_id: booking.id,
        kind: 'cancellation',
        run_at: new Date().toISOString(),
        status: 'pending',
        attempts: 0,
        last_error: null,
      },
    ],
    { onConflict: 'booking_id,kind' },
  )

  if (error) {
    console.error('[bookings] scheduleCancellationSend upsert failed:', error)
  }
}

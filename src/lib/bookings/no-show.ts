// ============================================================
// No-show detection + follow-up sequence trigger.
//
// Two entry points:
//   - `evaluateNoShow` — called by the cron when a `no_show_check`
//     reminder fires (i.e. the meeting's end time has passed). Decides
//     attended vs. no-show from `acknowledged_at` as a heuristic (a
//     "Got It" tap only proves the lead saw a message, not that they
//     joined the call — the manual attendance toggle in the inbox
//     always overrides this).
//   - `triggerNoShowSequence` — the shared "mark as no-show and queue
//     follow-ups" action, called either from `evaluateNoShow` (cron
//     path, anchored at the meeting's actual end time) or directly
//     from the attendance-toggle API route (manual path, anchored at
//     `now()` so "immediately triggers" holds even if the toggle is
//     flipped well after the meeting ended).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { scheduleNoShowFollowups } from './reminders'
import { logBookingEvent } from './events'

interface BookingForNoShow {
  id: string
  account_id: string
  meeting_end_at: string
  acknowledged_at: string | null
  attendance_status: string
}

/**
 * Called when a booking's `no_show_check` reminder fires. Only acts if
 * attendance is still `pending` — a manual override in the meantime
 * (agent already marked Attended/No-Show/Rescheduled) wins.
 */
export async function evaluateNoShow(
  db: SupabaseClient,
  booking: BookingForNoShow,
): Promise<void> {
  if (booking.attendance_status !== 'pending') return

  if (booking.acknowledged_at) {
    const { error } = await db
      .from('bookings')
      .update({ attendance_status: 'attended', attendance_set_at: new Date().toISOString() })
      .eq('id', booking.id)
      .eq('attendance_status', 'pending')
    if (!error) {
      await logBookingEvent(db, booking.account_id, booking.id, 'attendance_set', {
        attendance_status: 'attended',
        source: 'cron_heuristic',
      })
    }
    return
  }

  await triggerNoShowSequence(db, booking, 'cron')
}

/**
 * Mark a booking as no-show and enqueue the two follow-up sends.
 * Idempotent: only transitions `attendance_status` when it isn't
 * already `no_show` from a prior call, but always (re)schedules the
 * follow-ups — a manual re-trigger after the auto-detection should
 * still move the clock to `now()`.
 */
export async function triggerNoShowSequence(
  db: SupabaseClient,
  booking: BookingForNoShow,
  source: 'cron' | 'manual',
): Promise<void> {
  const { error } = await db
    .from('bookings')
    .update({
      attendance_status: 'no_show',
      attendance_set_at: new Date().toISOString(),
    })
    .eq('id', booking.id)

  if (error) {
    console.error('[bookings] triggerNoShowSequence update failed:', error)
    return
  }

  await logBookingEvent(db, booking.account_id, booking.id, 'attendance_set', {
    attendance_status: 'no_show',
    source,
  })

  const runFrom = source === 'manual' ? new Date() : new Date(booking.meeting_end_at)
  await scheduleNoShowFollowups(db, booking, runFrom)
}

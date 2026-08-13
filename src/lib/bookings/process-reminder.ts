// ============================================================
// Dispatch a single due `booking_reminders` row to the right sender
// (or the no-show evaluator). Called by the cron route after it has
// claimed the row via the conditional-UPDATE lock.
//
// Lives in its own module (not reminders.ts) to avoid a circular
// import: reminders.ts is imported by no-show.ts (for
// scheduleNoShowFollowups), so the dispatcher — which needs both
// no-show.ts and sender.ts — sits one level up instead.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  sendBookingConfirmation,
  sendMeetingLink,
  sendBookingReminder,
  sendBookingCancellation,
  sendNoShowFollowup,
  type BookingRow,
} from './sender'
import { evaluateNoShow } from './no-show'
import { logBookingEvent } from './events'
import type { ReminderKind } from './reminders'

interface ReminderRow {
  id: string
  account_id: string
  booking_id: string
  kind: ReminderKind
}

const SENT_EVENT: Partial<Record<ReminderKind, string>> = {
  confirmation: 'confirmation_sent',
  meeting_link: 'meeting_link_sent',
  cancellation: 'cancellation_sent',
  reminder_1h: 'reminder_1h_sent',
  reminder_15m: 'reminder_15m_sent',
  no_show_followup_1m: 'no_show_followup_1m_sent',
  no_show_followup_4h: 'no_show_followup_4h_sent',
}

export async function processReminderRow(db: SupabaseClient, row: ReminderRow): Promise<void> {
  const { data: booking, error } = await db
    .from('bookings')
    .select('*')
    .eq('id', row.booking_id)
    .maybeSingle()

  if (error || !booking) {
    throw new Error(`booking ${row.booking_id} not found: ${error?.message ?? 'no row'}`)
  }

  // A cancelled booking's pending reminders are cancelled explicitly
  // on cancellation, but this guards against a race (cron already
  // claimed the row moments before the cancellation webhook landed).
  if (booking.status === 'cancelled' && row.kind !== 'cancellation') {
    return
  }

  switch (row.kind) {
    case 'confirmation':
      await sendBookingConfirmation(db, booking as BookingRow)
      break
    case 'meeting_link':
      await sendMeetingLink(db, booking as BookingRow)
      break
    case 'cancellation':
      await sendBookingCancellation(db, booking as BookingRow)
      break
    case 'reminder_1h':
      await sendBookingReminder(db, booking as BookingRow, '1h')
      break
    case 'reminder_15m':
      await sendBookingReminder(db, booking as BookingRow, '15m')
      break
    case 'no_show_check':
      await evaluateNoShow(db, booking as BookingRow & { acknowledged_at: string | null; attendance_status: string })
      return
    case 'no_show_followup_1m':
    case 'no_show_followup_4h':
      // Skip if the booking was reclassified (Attended/Rescheduled)
      // since this follow-up was scheduled — the sequence is only
      // valid while attendance is still `no_show`.
      if (booking.attendance_status !== 'no_show') return
      await sendNoShowFollowup(db, booking as BookingRow)
      break
    default:
      return
  }

  const eventType = SENT_EVENT[row.kind]
  if (eventType) {
    await logBookingEvent(db, row.account_id, row.booking_id, eventType)
  }
}

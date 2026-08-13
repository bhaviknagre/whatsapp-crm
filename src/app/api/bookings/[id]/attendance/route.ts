import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/bookings/admin-client'
import { cancelReminders } from '@/lib/bookings/reminders'
import { triggerNoShowSequence } from '@/lib/bookings/no-show'
import { logBookingEvent } from '@/lib/bookings/events'

const VALID_STATUSES = new Set(['attended', 'no_show', 'rescheduled'])

/**
 * PATCH /api/bookings/[id]/attendance
 *
 * Manual attendance override from the inbox's booking panel. Marking
 * `no_show` immediately runs the same follow-up sequence the cron's
 * auto-detection would (anchored on `now()`, not the meeting's actual
 * end time, so "immediately triggers" holds even if the toggle is
 * flipped well after the meeting). Marking `attended` or `rescheduled`
 * cancels any no-show follow-ups still pending — a human's read on
 * what happened always wins over the heuristic.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const { id } = await params
  const body = await request.json().catch(() => null)
  const attendanceStatus = body?.attendance_status

  if (typeof attendanceStatus !== 'string' || !VALID_STATUSES.has(attendanceStatus)) {
    return NextResponse.json(
      { error: 'attendance_status must be one of: attended, no_show, rescheduled' },
      { status: 400 },
    )
  }

  const admin = supabaseAdmin()

  // Load + scope by account_id via the service-role client (bookings'
  // RLS would also allow this via ctx.supabase, but booking_reminders /
  // booking_events writes below are service-role-only tables, so the
  // whole route uses the admin client for a single consistent path —
  // manual account_id scoping stands in for RLS here).
  const { data: booking, error: fetchError } = await admin
    .from('bookings')
    .select('*')
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle()

  if (fetchError || !booking) {
    return NextResponse.json({ error: 'Booking not found' }, { status: 404 })
  }

  if (attendanceStatus === 'no_show') {
    await triggerNoShowSequence(admin, booking, 'manual')
  } else {
    const { error: updateError } = await admin
      .from('bookings')
      .update({
        attendance_status: attendanceStatus,
        attendance_set_by: ctx.userId,
        attendance_set_at: new Date().toISOString(),
      })
      .eq('id', booking.id)

    if (updateError) {
      return NextResponse.json({ error: 'Failed to update attendance' }, { status: 500 })
    }

    await logBookingEvent(admin, ctx.accountId, booking.id, 'attendance_set', {
      attendance_status: attendanceStatus,
      source: 'manual',
    })

    // A human resolved attendance — no need for the auto no-show
    // detection or any follow-ups still pending from an earlier
    // (possibly since-corrected) auto/manual no-show classification.
    await cancelReminders(admin, booking.id, [
      'no_show_check',
      'no_show_followup_1m',
      'no_show_followup_4h',
    ])
  }

  return NextResponse.json({ success: true, attendance_status: attendanceStatus })
}

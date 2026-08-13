import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/bookings/admin-client'
import { rescheduleBookingById } from '@/lib/bookings/booking-engine'

/**
 * POST /api/bookings/[id]/reschedule
 *
 * Move a booking to a new time from the CRM — re-derives reminders
 * and resets attendance to `pending`, same as a Cal.com same-uid
 * BOOKING_RESCHEDULED webhook. One-way: if this booking came from
 * Cal.com, rescheduling here does not move it on Cal.com's side (no
 * write-back API integration configured) — the two calendars will
 * disagree until Cal.com's own event is updated separately.
 */
export async function POST(
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
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const meetingStartAt = typeof body.meeting_start_at === 'string' ? body.meeting_start_at : null
  const meetingEndAt = typeof body.meeting_end_at === 'string' ? body.meeting_end_at : null
  if (!meetingStartAt || !meetingEndAt) {
    return NextResponse.json(
      { error: 'meeting_start_at and meeting_end_at are required' },
      { status: 400 },
    )
  }
  if (new Date(meetingEndAt).getTime() <= new Date(meetingStartAt).getTime()) {
    return NextResponse.json({ error: 'meeting_end_at must be after meeting_start_at' }, { status: 400 })
  }

  const admin = supabaseAdmin()

  const { data: booking } = await admin
    .from('bookings')
    .select('id, status, calendar_provider')
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle()

  if (!booking) {
    return NextResponse.json({ error: 'Booking not found' }, { status: 404 })
  }
  if (booking.status === 'cancelled') {
    return NextResponse.json({ error: 'Cannot reschedule a cancelled booking' }, { status: 400 })
  }

  const result = await rescheduleBookingById(
    admin,
    ctx.accountId,
    booking.id,
    {
      meetingStartAt: new Date(meetingStartAt).toISOString(),
      meetingEndAt: new Date(meetingEndAt).toISOString(),
    },
    'manual',
  )

  if (!result) {
    return NextResponse.json({ error: 'Failed to reschedule booking' }, { status: 500 })
  }

  const { data: updated } = await admin
    .from('bookings')
    .select('*')
    .eq('id', result.bookingId)
    .maybeSingle()

  return NextResponse.json({
    booking: updated,
    synced_to_provider: false,
    provider: booking.calendar_provider,
  })
}

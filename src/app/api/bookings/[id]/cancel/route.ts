import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/bookings/admin-client'
import { cancelBookingById } from '@/lib/bookings/booking-engine'

/**
 * POST /api/bookings/[id]/cancel
 *
 * Cancel a booking from the CRM — cancels its pending reminders and
 * queues a cancellation notice to the lead/teammate, same as a
 * Cal.com BOOKING_CANCELLED webhook. One-way: if this booking came
 * from Cal.com, cancelling here does not cancel it on Cal.com's side
 * (no write-back API integration configured).
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
    return NextResponse.json({ error: 'Booking is already cancelled' }, { status: 400 })
  }

  const result = await cancelBookingById(admin, ctx.accountId, booking.id)
  if (!result) {
    return NextResponse.json({ error: 'Failed to cancel booking' }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    synced_to_provider: false,
    provider: booking.calendar_provider,
  })
}

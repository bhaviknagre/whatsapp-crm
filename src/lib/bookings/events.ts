import type { SupabaseClient } from '@supabase/supabase-js'

/** Append a row to the booking_events audit log. Best-effort — a
 * logging failure never blocks the state change that triggered it. */
export async function logBookingEvent(
  db: SupabaseClient,
  accountId: string,
  bookingId: string,
  eventType: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const { error } = await db
    .from('booking_events')
    .insert({ account_id: accountId, booking_id: bookingId, event_type: eventType, metadata: metadata ?? null })
  if (error) {
    console.error(`[bookings] logBookingEvent(${eventType}) failed:`, error)
  }
}

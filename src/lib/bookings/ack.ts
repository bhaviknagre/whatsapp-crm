// ============================================================
// Resolve a "Got It" / "Reschedule" button tap to a specific booking
// and apply it.
//
// WhatsApp quick-reply button payloads are fixed at template-creation
// time — they can't embed a dynamic {booking_id} (see
// src/lib/bookings/templates.ts for the full platform-constraint
// writeup). So every tap arrives with one of two generic payloads
// (`booking_ack` / `booking_reschedule`), and this module resolves it
// to "the contact's earliest confirmed, not-yet-acknowledged booking"
// — correct for the common case of one open booking per lead, with a
// documented edge case (two simultaneous unacknowledged bookings for
// the same lead ack the earlier one).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'
import { logBookingEvent } from './events'
import { BOOKING_ACK_PAYLOAD, BOOKING_RESCHEDULE_PAYLOAD } from './templates'

export { BOOKING_ACK_PAYLOAD, BOOKING_RESCHEDULE_PAYLOAD }

export interface BookingButtonTapInput {
  accountId: string
  contactId: string
  conversationId: string
  action: 'ack' | 'reschedule'
}

export async function handleBookingButtonTap(
  db: SupabaseClient,
  input: BookingButtonTapInput,
): Promise<void> {
  const { data: booking, error } = await db
    .from('bookings')
    .select('*')
    .eq('account_id', input.accountId)
    .eq('contact_id', input.contactId)
    .eq('status', 'confirmed')
    .is('acknowledged_at', null)
    .order('meeting_start_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error('[bookings] handleBookingButtonTap lookup failed:', error)
    return
  }
  // No open, unacknowledged booking for this contact — nothing to do.
  // (A stray tap on an old message after the meeting already resolved,
  // for instance.)
  if (!booking) return

  if (input.action === 'ack') {
    const { error: updateError } = await db
      .from('bookings')
      .update({ acknowledged_at: new Date().toISOString() })
      .eq('id', booking.id)
    if (updateError) {
      console.error('[bookings] ack update failed:', updateError)
      return
    }
    await logBookingEvent(db, input.accountId, booking.id, 'acknowledged')
    return
  }

  // 'reschedule' — reply in-session with the link. The tap that
  // triggered this handler is itself an inbound message, so the 24h
  // window is open and a free-form text reply is valid.
  const url = booking.reschedule_url as string | null
  if (!url) return

  try {
    await sendMessageToConversation(db, input.accountId, {
      conversationId: input.conversationId,
      messageType: 'text',
      contentText: `Sure — pick a new time here: ${url}`,
    })
  } catch (err) {
    console.error('[bookings] reschedule reply send failed:', err)
  }
}

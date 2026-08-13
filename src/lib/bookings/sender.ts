// ============================================================
// Booking lifecycle senders — confirmation / reminder / cancellation /
// no-show follow-up. Every function here wraps
// `sendMessageToConversation` (src/lib/whatsapp/send-message.ts), the
// same core the dashboard composer and public API use, so booking
// sends get the same phone-variant retry, template-approval
// enforcement, and message persistence for free.
//
// Lead-facing text is formatted in `bookings.lead_timezone`;
// teammate-facing text is formatted in `profiles.timezone`. Both run
// through `safeTimezone`/`formatMeetingTime` (src/lib/bookings/timezone.ts)
// so a malformed zone never throws mid-send.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { sendMessageToConversation, SendMessageError } from '@/lib/whatsapp/send-message'
import { formatMeetingTime } from './timezone'
import { BOOKING_TEMPLATES, DEFAULT_TEMPLATE_LANGUAGE } from './templates'
import {
  findOrCreateContactForBooking,
  findOrCreateConversationForBooking,
} from './conversation'

export interface BookingRow {
  id: string
  account_id: string
  contact_id: string | null
  conversation_id: string | null
  assigned_profile_id: string | null
  title: string | null
  lead_name: string | null
  lead_phone: string | null
  lead_email: string | null
  lead_timezone: string
  meeting_start_at: string
  meeting_end_at: string
  reschedule_url: string | null
  meeting_link: string | null
  [key: string]: unknown
}

interface TeammateProfile {
  id: string
  full_name: string | null
  email: string
  timezone: string
  notification_phone: string | null
}

async function loadWhatsappConfigOwner(
  db: SupabaseClient,
  accountId: string,
): Promise<string | null> {
  const { data } = await db
    .from('whatsapp_config')
    .select('user_id')
    .eq('account_id', accountId)
    .maybeSingle()
  return (data?.user_id as string | undefined) ?? null
}

async function loadAssignedProfile(
  db: SupabaseClient,
  profileId: string | null,
): Promise<TeammateProfile | null> {
  if (!profileId) return null
  const { data } = await db
    .from('profiles')
    .select('id, full_name, email, timezone, notification_phone')
    .eq('id', profileId)
    .maybeSingle()
  return (data as TeammateProfile | null) ?? null
}

/** Resolve (or lazily create) the conversation a lead send should go through. */
async function resolveLeadConversationId(
  db: SupabaseClient,
  booking: BookingRow,
): Promise<string | null> {
  if (booking.conversation_id) return booking.conversation_id
  if (!booking.lead_phone) return null

  const ownerUserId = await loadWhatsappConfigOwner(db, booking.account_id)
  if (!ownerUserId) return null

  const contact = await findOrCreateContactForBooking(
    db,
    booking.account_id,
    ownerUserId,
    booking.lead_phone,
    booking.lead_name,
  )
  if (!contact) return null

  const conversation = await findOrCreateConversationForBooking(
    db,
    booking.account_id,
    ownerUserId,
    contact.id,
  )
  if (!conversation) return null

  await db
    .from('bookings')
    .update({ contact_id: contact.id, conversation_id: conversation.id })
    .eq('id', booking.id)

  return conversation.id
}

/** Resolve (or lazily create) the conversation a teammate notification should go through. */
async function resolveTeammateConversationId(
  db: SupabaseClient,
  booking: BookingRow,
  teammate: TeammateProfile,
): Promise<string | null> {
  if (!teammate.notification_phone) return null

  const ownerUserId = await loadWhatsappConfigOwner(db, booking.account_id)
  if (!ownerUserId) return null

  const contact = await findOrCreateContactForBooking(
    db,
    booking.account_id,
    ownerUserId,
    teammate.notification_phone,
    teammate.full_name,
  )
  if (!contact) return null

  const conversation = await findOrCreateConversationForBooking(
    db,
    booking.account_id,
    ownerUserId,
    contact.id,
  )
  return conversation?.id ?? null
}

async function sendTemplate(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
  templateName: string,
  bodyParams: string[],
): Promise<void> {
  try {
    await sendMessageToConversation(db, accountId, {
      conversationId,
      messageType: 'template',
      templateName,
      templateLanguage: DEFAULT_TEMPLATE_LANGUAGE,
      templateParams: bodyParams,
    })
  } catch (err) {
    if (err instanceof SendMessageError) {
      console.error(
        `[bookings] template send "${templateName}" failed (${err.code}): ${err.message}`,
      )
      throw err
    }
    throw err
  }
}

export async function sendBookingConfirmation(
  db: SupabaseClient,
  booking: BookingRow,
): Promise<void> {
  const teammate = await loadAssignedProfile(db, booking.assigned_profile_id)
  const teammateName = teammate?.full_name || teammate?.email || 'your teammate'
  const title = booking.title || 'meeting'

  const leadConvId = await resolveLeadConversationId(db, booking)
  if (leadConvId) {
    await sendTemplate(db, booking.account_id, leadConvId, BOOKING_TEMPLATES.confirmationLead.name, [
      booking.lead_name || 'there',
      title,
      teammateName,
      formatMeetingTime(booking.meeting_start_at, booking.lead_timezone),
    ])
  }

  if (teammate?.notification_phone) {
    const teammateConvId = await resolveTeammateConversationId(db, booking, teammate)
    if (teammateConvId) {
      await sendTemplate(
        db,
        booking.account_id,
        teammateConvId,
        BOOKING_TEMPLATES.confirmationTeammate.name,
        [
          booking.lead_name || booking.lead_phone || 'A lead',
          title,
          booking.lead_phone || '—',
          booking.lead_email || '—',
          formatMeetingTime(booking.meeting_start_at, teammate.timezone),
        ],
      )
    }
  }
}

/**
 * Send the video-call link as its own message, to both parties. Only
 * ever queued for a booking that actually has `meeting_link` set (see
 * `scheduleReminders`), so this never runs for a booking without one.
 */
export async function sendMeetingLink(db: SupabaseClient, booking: BookingRow): Promise<void> {
  if (!booking.meeting_link) return
  const title = booking.title || 'meeting'

  const leadConvId = await resolveLeadConversationId(db, booking)
  if (leadConvId) {
    await sendTemplate(db, booking.account_id, leadConvId, BOOKING_TEMPLATES.meetingLink.name, [
      title,
      booking.meeting_link,
    ])
  }

  const teammate = await loadAssignedProfile(db, booking.assigned_profile_id)
  if (teammate?.notification_phone) {
    const teammateConvId = await resolveTeammateConversationId(db, booking, teammate)
    if (teammateConvId) {
      await sendTemplate(db, booking.account_id, teammateConvId, BOOKING_TEMPLATES.meetingLink.name, [
        title,
        booking.meeting_link,
      ])
    }
  }
}

export async function sendBookingReminder(
  db: SupabaseClient,
  booking: BookingRow,
  which: '1h' | '15m',
): Promise<void> {
  const teammate = await loadAssignedProfile(db, booking.assigned_profile_id)
  const teammateName = teammate?.full_name || teammate?.email || 'your teammate'
  const title = booking.title || 'meeting'
  const template = which === '1h' ? BOOKING_TEMPLATES.reminder1h : BOOKING_TEMPLATES.reminder15m

  const leadConvId = await resolveLeadConversationId(db, booking)
  if (leadConvId) {
    await sendTemplate(db, booking.account_id, leadConvId, template.name, [
      title,
      teammateName,
      formatMeetingTime(booking.meeting_start_at, booking.lead_timezone),
    ])
  }

  if (teammate?.notification_phone) {
    const teammateConvId = await resolveTeammateConversationId(db, booking, teammate)
    if (teammateConvId) {
      await sendTemplate(db, booking.account_id, teammateConvId, template.name, [
        title,
        booking.lead_name || booking.lead_phone || 'the lead',
        formatMeetingTime(booking.meeting_start_at, teammate.timezone),
      ])
    }
  }
}

export async function sendBookingCancellation(
  db: SupabaseClient,
  booking: BookingRow,
): Promise<void> {
  const teammate = await loadAssignedProfile(db, booking.assigned_profile_id)
  const title = booking.title || 'meeting'

  const leadConvId = await resolveLeadConversationId(db, booking)
  if (leadConvId) {
    await sendTemplate(
      db,
      booking.account_id,
      leadConvId,
      BOOKING_TEMPLATES.cancelledLead.name,
      [title, formatMeetingTime(booking.meeting_start_at, booking.lead_timezone)],
    )
  }

  if (teammate?.notification_phone) {
    const teammateConvId = await resolveTeammateConversationId(db, booking, teammate)
    if (teammateConvId) {
      await sendTemplate(
        db,
        booking.account_id,
        teammateConvId,
        BOOKING_TEMPLATES.cancelledTeammate.name,
        [
          booking.lead_name || booking.lead_phone || 'The lead',
          title,
          formatMeetingTime(booking.meeting_start_at, teammate.timezone),
        ],
      )
    }
  }
}

export async function sendNoShowFollowup(
  db: SupabaseClient,
  booking: BookingRow,
): Promise<void> {
  const leadConvId = await resolveLeadConversationId(db, booking)
  if (!leadConvId) return

  const title = booking.title || 'meeting'
  const rescheduleUrl = booking.reschedule_url || ''

  await sendTemplate(
    db,
    booking.account_id,
    leadConvId,
    BOOKING_TEMPLATES.noShowFollowup.name,
    [title, rescheduleUrl],
  )
}

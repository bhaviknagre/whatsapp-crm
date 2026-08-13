// ============================================================
// Calendar webhook → bookings state machine.
//
// Provider-agnostic: takes an already-parsed, already-verified event
// (see src/lib/bookings/providers/cal-com.ts for the Cal.com parser)
// and applies it to the `bookings` table, idempotently on
// `(calendar_provider, external_booking_id)`. Provider-specific route
// handlers own signature verification and account resolution; this
// module owns everything after that.
// ============================================================

import crypto from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils'
import { scheduleReminders, cancelReminders, scheduleCancellationSend } from './reminders'
import { logBookingEvent } from './events'
import type { ParsedCalComBooking } from './providers/cal-com'

export interface CalendarIntegrationRow {
  id: string
  account_id: string
  provider: string
  default_reschedule_url: string | null
}

interface BookingRow {
  id: string
  account_id: string
  meeting_start_at: string
  meeting_end_at: string
  attendance_status: string
  [key: string]: unknown
}

async function resolveAssignedProfileId(
  db: SupabaseClient,
  accountId: string,
  organizerEmail: string | null,
): Promise<string | null> {
  if (!organizerEmail) return null
  const { data } = await db
    .from('profiles')
    .select('id')
    .eq('account_id', accountId)
    .ilike('email', organizerEmail)
    .maybeSingle()
  return (data?.id as string | undefined) ?? null
}

/**
 * Sanitize + validate a lead phone captured from a calendar payload.
 * Returns null (not a throw) when absent/invalid — a booking without
 * a usable phone is still recorded, just excluded from the WhatsApp
 * lifecycle (documented setup prerequisite: the account's Cal.com
 * event type must require a phone-number question).
 */
function resolveLeadPhone(raw: string | null): string | null {
  if (!raw) return null
  const sanitized = sanitizePhoneForMeta(raw)
  return isValidE164(sanitized) ? sanitized : null
}

export async function handleCalComWebhookEvent(
  db: SupabaseClient,
  integration: CalendarIntegrationRow,
  parsed: ParsedCalComBooking,
  rawPayload: unknown,
): Promise<{ bookingId: string } | null> {
  const accountId = integration.account_id

  if (parsed.eventType === 'created') {
    return handleCreated(db, integration, parsed, rawPayload)
  }
  if (parsed.eventType === 'rescheduled') {
    return handleRescheduled(db, integration, parsed, rawPayload)
  }
  if (parsed.eventType === 'cancelled') {
    return handleCancelled(db, accountId, parsed)
  }
  return null
}

async function handleCreated(
  db: SupabaseClient,
  integration: CalendarIntegrationRow,
  parsed: ParsedCalComBooking,
  rawPayload: unknown,
): Promise<{ bookingId: string } | null> {
  const accountId = integration.account_id
  const leadPhone = resolveLeadPhone(parsed.leadPhone)
  const assignedProfileId = await resolveAssignedProfileId(db, accountId, parsed.organizerEmail)

  const { data: booking, error } = await db
    .from('bookings')
    .upsert(
      {
        account_id: accountId,
        assigned_profile_id: assignedProfileId,
        calendar_provider: 'cal_com',
        external_booking_id: parsed.externalBookingId,
        event_type: parsed.eventTypeSlug,
        title: parsed.title,
        lead_name: parsed.leadName,
        lead_phone: leadPhone,
        lead_email: parsed.leadEmail,
        lead_timezone: parsed.leadTimezone || 'UTC',
        meeting_start_at: parsed.meetingStartAt,
        meeting_end_at: parsed.meetingEndAt,
        reschedule_url: integration.default_reschedule_url,
        meeting_link: parsed.meetingLink,
        status: 'confirmed',
        raw_payload: rawPayload,
      },
      { onConflict: 'calendar_provider,external_booking_id' },
    )
    .select()
    .single()

  if (error || !booking) {
    console.error('[bookings] handleCreated upsert failed:', error)
    return null
  }

  await logBookingEvent(db, accountId, booking.id, 'created', {
    skipped_lifecycle: !leadPhone,
    reason: leadPhone ? undefined : 'missing_or_invalid_phone',
  })

  if (leadPhone) {
    await scheduleReminders(db, booking as BookingRow)
  }

  return { bookingId: booking.id }
}

async function handleRescheduled(
  db: SupabaseClient,
  integration: CalendarIntegrationRow,
  parsed: ParsedCalComBooking,
  rawPayload: unknown,
): Promise<{ bookingId: string } | null> {
  const accountId = integration.account_id

  // Case 1: Cal.com kept the same uid and just updated the time.
  const { data: sameUidRow } = await db
    .from('bookings')
    .select('id')
    .eq('account_id', accountId)
    .eq('calendar_provider', 'cal_com')
    .eq('external_booking_id', parsed.externalBookingId)
    .maybeSingle()

  if (sameUidRow) {
    return rescheduleBookingById(
      db,
      accountId,
      sameUidRow.id,
      {
        meetingStartAt: parsed.meetingStartAt,
        meetingEndAt: parsed.meetingEndAt,
        title: parsed.title,
        leadName: parsed.leadName,
        leadEmail: parsed.leadEmail,
        leadTimezone: parsed.leadTimezone || 'UTC',
        meetingLink: parsed.meetingLink,
        rawPayload,
      },
      'cal_com',
    )
  }

  // Case 2: Cal.com minted a new uid and points at the old one via
  // rescheduleUid. Close out the old row and create a fresh one.
  const oldExternalId = parsed.rescheduledFromExternalId
  let oldRow: BookingRow & { recovered_booking_id?: string | null } = null as unknown as BookingRow & {
    recovered_booking_id?: string | null
  }

  if (oldExternalId) {
    const { data } = await db
      .from('bookings')
      .select('*')
      .eq('account_id', accountId)
      .eq('calendar_provider', 'cal_com')
      .eq('external_booking_id', oldExternalId)
      .maybeSingle()
    oldRow = data as typeof oldRow
  }

  const created = await handleCreated(db, integration, parsed, rawPayload)
  if (!created) return null

  if (oldRow) {
    await cancelReminders(db, oldRow.id)
    const wasNoShow = oldRow.attendance_status === 'no_show'
    await db
      .from('bookings')
      .update({
        status: 'rescheduled',
        rescheduled_to_booking_id: created.bookingId,
        recovered: wasNoShow ? true : oldRow.recovered,
        recovered_booking_id: wasNoShow ? created.bookingId : oldRow.recovered_booking_id ?? null,
      })
      .eq('id', oldRow.id)
    await logBookingEvent(db, accountId, oldRow.id, 'rescheduled', {
      mode: 'new_uid',
      new_booking_id: created.bookingId,
      recovered: wasNoShow,
    })
  }

  return created
}

async function handleCancelled(
  db: SupabaseClient,
  accountId: string,
  parsed: ParsedCalComBooking,
): Promise<{ bookingId: string } | null> {
  const { data: existing } = await db
    .from('bookings')
    .select('id')
    .eq('account_id', accountId)
    .eq('calendar_provider', 'cal_com')
    .eq('external_booking_id', parsed.externalBookingId)
    .maybeSingle()

  if (!existing) {
    console.error('[bookings] handleCancelled: no matching booking for', parsed.externalBookingId)
    return null
  }

  return cancelBookingById(db, accountId, existing.id)
}

export interface RescheduleBookingInput {
  meetingStartAt: string
  meetingEndAt: string
  /** Optional field sync alongside the time change — Cal.com brings
   *  fresh lead/title data on reschedule; a manual CRM reschedule only
   *  changes the time and omits these. */
  title?: string | null
  leadName?: string | null
  leadEmail?: string | null
  leadTimezone?: string | null
  meetingLink?: string | null
  rawPayload?: unknown
}

/**
 * Move a booking to a new time — shared by the Cal.com "same uid"
 * reschedule path and the manual CRM reschedule action
 * (POST /api/bookings/[id]/reschedule). Resets attendance to
 * `pending` (a new time means the old attendance read no longer
 * applies) and re-derives reminders/no-show-check from the new
 * schedule.
 *
 * IMPORTANT: this only updates wacrm's own record. For a
 * Cal.com-sourced booking, rescheduling from the CRM does NOT push
 * the change back to Cal.com — there's no write-back API integration
 * configured (Cal.com's REST API needs a separate API key wacrm
 * doesn't currently store). The two calendars can drift; the CRM
 * route surfaces this to the user rather than silently pretending
 * it's two-way synced.
 */
export async function rescheduleBookingById(
  db: SupabaseClient,
  accountId: string,
  bookingId: string,
  input: RescheduleBookingInput,
  source: 'cal_com' | 'manual',
): Promise<{ bookingId: string } | null> {
  const updatePayload: Record<string, unknown> = {
    meeting_start_at: input.meetingStartAt,
    meeting_end_at: input.meetingEndAt,
    status: 'confirmed',
    attendance_status: 'pending',
    acknowledged_at: null,
  }
  if (input.title !== undefined) updatePayload.title = input.title
  if (input.leadName !== undefined) updatePayload.lead_name = input.leadName
  if (input.leadEmail !== undefined) updatePayload.lead_email = input.leadEmail
  if (input.leadTimezone) updatePayload.lead_timezone = input.leadTimezone
  if (input.meetingLink !== undefined) updatePayload.meeting_link = input.meetingLink
  if (input.rawPayload !== undefined) updatePayload.raw_payload = input.rawPayload

  const { data: updated, error } = await db
    .from('bookings')
    .update(updatePayload)
    .eq('id', bookingId)
    .eq('account_id', accountId)
    .select()
    .single()

  if (error || !updated) {
    console.error('[bookings] rescheduleBookingById update failed:', error)
    return null
  }

  await cancelReminders(db, updated.id)
  await scheduleReminders(db, updated as BookingRow)
  await logBookingEvent(db, accountId, updated.id, 'rescheduled', {
    mode: source === 'cal_com' ? 'same_uid' : 'manual',
  })

  return { bookingId: updated.id }
}

/**
 * Cancel a booking directly — shared by the Cal.com cancellation
 * webhook and the manual CRM cancel action
 * (POST /api/bookings/[id]/cancel). Same one-way-sync caveat as
 * `rescheduleBookingById`: cancelling a Cal.com-sourced booking from
 * the CRM does not cancel it on Cal.com's side.
 */
export async function cancelBookingById(
  db: SupabaseClient,
  accountId: string,
  bookingId: string,
): Promise<{ bookingId: string } | null> {
  const { data: booking, error } = await db
    .from('bookings')
    .update({ status: 'cancelled' })
    .eq('id', bookingId)
    .eq('account_id', accountId)
    .select()
    .single()

  if (error || !booking) {
    console.error('[bookings] cancelBookingById update failed:', error)
    return null
  }

  await cancelReminders(db, booking.id)
  await scheduleCancellationSend(db, booking as BookingRow)
  await logBookingEvent(db, accountId, booking.id, 'cancelled')

  return { bookingId: booking.id }
}

export interface CreateManualBookingInput {
  accountId: string
  contactId: string
  conversationId: string | null
  assignedProfileId: string | null
  title: string
  leadName: string | null
  leadPhone: string | null
  leadEmail: string | null
  leadTimezone: string
  meetingStartAt: string
  meetingEndAt: string
  rescheduleUrl: string | null
  meetingLink: string | null
}

/**
 * Create a booking directly from the CRM (no calendar webhook
 * involved) — an agent scheduling a meeting they arranged over a call
 * or email. Uses `calendar_provider: 'manual'` with a synthetic
 * `external_booking_id` so the (provider, external_id) unique index
 * still holds; otherwise runs through the exact same reminder
 * scheduling as a Cal.com booking.
 */
export async function createManualBooking(
  db: SupabaseClient,
  input: CreateManualBookingInput,
): Promise<{ bookingId: string } | null> {
  const { data: booking, error } = await db
    .from('bookings')
    .insert({
      account_id: input.accountId,
      contact_id: input.contactId,
      conversation_id: input.conversationId,
      assigned_profile_id: input.assignedProfileId,
      calendar_provider: 'manual',
      external_booking_id: `manual-${crypto.randomUUID()}`,
      title: input.title,
      lead_name: input.leadName,
      lead_phone: input.leadPhone,
      lead_email: input.leadEmail,
      lead_timezone: input.leadTimezone || 'UTC',
      meeting_start_at: input.meetingStartAt,
      meeting_end_at: input.meetingEndAt,
      reschedule_url: input.rescheduleUrl,
      meeting_link: input.meetingLink,
      status: 'confirmed',
    })
    .select()
    .single()

  if (error || !booking) {
    console.error('[bookings] createManualBooking insert failed:', error)
    return null
  }

  await logBookingEvent(db, input.accountId, booking.id, 'created', { source: 'manual' })
  await scheduleReminders(db, booking as BookingRow)

  return { bookingId: booking.id }
}

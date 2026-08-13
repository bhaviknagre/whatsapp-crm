// ============================================================
// HSM (WhatsApp message template) contract for the booking lifecycle.
//
// Every lifecycle send except an in-session reply to a button tap
// fires outside the 24h customer-service window (the lead hasn't
// necessarily texted the CRM recently), so it MUST be a pre-approved
// template — Meta rejects free-form sends outside the window and
// `sendMessageToConversation` enforces this server-side.
//
// These 7 templates must be created in Meta Business Manager
// (category: Utility, for transactional deliverability/pricing) before
// the lifecycle can go live end-to-end. Quick-reply button PAYLOADS are
// fixed at template-creation time on Meta's platform — they cannot
// embed a dynamic {booking_id} — so "Got It" / "Reschedule" buttons
// must use the exact fixed payload strings below. See
// src/lib/bookings/ack.ts for how a tap is resolved back to a specific
// booking despite the payload being generic.
// ============================================================

// Meta's standard template-creation UI (Business Manager / WhatsApp
// Manager) does not expose a way to set a QUICK_REPLY button's
// `payload` separately from its visible label — the payload Meta
// echoes back in the inbound webhook when the button is tapped
// defaults to the button's own text. So the payload these constants
// must match is whatever you type as the button label below, not an
// arbitrary internal id. Kept as named constants (not inlined at each
// call site) so the button label and the matcher can't drift apart.
//
// VERIFY THIS against your own WABA once the templates are approved:
// send yourself a real confirmation/reminder, tap "Got It", and check
// the `messages.interactive_reply_id` column (or webhook logs) for
// the exact string Meta sent back. If it differs from the label
// below, update these two constants to match — don't change the
// button label in Meta, since that's cosmetic and these are the
// actual matching key.
export const BOOKING_ACK_PAYLOAD = 'Got It'
export const BOOKING_RESCHEDULE_PAYLOAD = 'Reschedule'

export const BOOKING_TEMPLATES = {
  confirmationLead: {
    name: 'booking_confirmation_lead',
    /** {{1}} lead name, {{2}} meeting title, {{3}} teammate name, {{4}} formatted time (lead tz) */
    bodyVars: ['leadName', 'title', 'teammateName', 'formattedTime'] as const,
    buttons: [
      { type: 'quick_reply', text: 'Got It', payload: BOOKING_ACK_PAYLOAD },
      { type: 'quick_reply', text: 'Reschedule', payload: BOOKING_RESCHEDULE_PAYLOAD },
    ],
  },
  meetingLink: {
    name: 'booking_meeting_link',
    // {{1}} meeting title, {{2}} the video-call URL as plain body text.
    // Sent right after the confirmation, only when the booking has a
    // meeting_link set (Cal.com video-conferencing integration, or
    // entered manually) — never queued for a booking without one, so
    // this template never needs a "no link" placeholder value.
    bodyVars: ['title', 'meetingLink'] as const,
    buttons: [],
  },
  confirmationTeammate: {
    name: 'booking_confirmation_teammate',
    /** {{1}} lead name, {{2}} meeting title, {{3}} lead phone, {{4}} lead email, {{5}} formatted time (teammate tz) */
    bodyVars: ['leadName', 'title', 'leadPhone', 'leadEmail', 'formattedTime'] as const,
    buttons: [],
  },
  reminder1h: {
    name: 'booking_reminder_1h',
    bodyVars: ['title', 'teammateName', 'formattedTime'] as const,
    buttons: [
      { type: 'quick_reply', text: 'Got It', payload: BOOKING_ACK_PAYLOAD },
      { type: 'quick_reply', text: 'Reschedule', payload: BOOKING_RESCHEDULE_PAYLOAD },
    ],
  },
  reminder15m: {
    name: 'booking_reminder_15m',
    bodyVars: ['title', 'teammateName', 'formattedTime'] as const,
    buttons: [
      { type: 'quick_reply', text: 'Got It', payload: BOOKING_ACK_PAYLOAD },
      { type: 'quick_reply', text: 'Reschedule', payload: BOOKING_RESCHEDULE_PAYLOAD },
    ],
  },
  cancelledLead: {
    name: 'booking_cancelled_lead',
    /** {{1}} meeting title, {{2}} formatted time (lead tz) */
    bodyVars: ['title', 'formattedTime'] as const,
    buttons: [],
  },
  cancelledTeammate: {
    name: 'booking_cancelled_teammate',
    /** {{1}} lead name, {{2}} meeting title, {{3}} formatted time (teammate tz) */
    bodyVars: ['leadName', 'title', 'formattedTime'] as const,
    buttons: [],
  },
  noShowFollowup: {
    name: 'booking_no_show_followup',
    // {{1}} meeting title, {{2}} the reschedule link as plain body text.
    // Deliberately a body variable rather than a structured URL-button
    // component: a dynamic URL button requires the template row to be
    // synced locally (Settings → WhatsApp → Templates → "Sync from
    // Meta") before buildSendComponents can construct it, whereas a
    // body-text link works on the very first send with zero setup
    // beyond template approval.
    bodyVars: ['title', 'rescheduleUrl'] as const,
    buttons: [],
  },
} as const

export type BookingTemplateKey = keyof typeof BOOKING_TEMPLATES

export const DEFAULT_TEMPLATE_LANGUAGE = 'en_US'

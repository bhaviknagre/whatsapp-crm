// ============================================================
// Cal.com webhook payload verification + parsing.
//
// Cal.com signs the raw JSON body with HMAC-SHA256 using the secret
// configured on the webhook (Settings → Developer → Webhooks), sent as
// `Cal-Signature-256: <hex>` — no `sha256=` prefix, unlike Meta's
// `x-hub-signature-256`. Verified the same way as
// src/lib/whatsapp/webhook-signature.ts: hash the raw body, compare
// with `timingSafeEqual`.
// ============================================================

import crypto from 'node:crypto'

export function verifyCalComSignature(rawBody: string, signatureHeader: string | null, secret: string): boolean {
  if (!signatureHeader) return false

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')

  const a = Buffer.from(signatureHeader)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

export type CalComTriggerEvent = 'BOOKING_CREATED' | 'BOOKING_RESCHEDULED' | 'BOOKING_CANCELLED'

export interface ParsedCalComBooking {
  eventType: 'created' | 'rescheduled' | 'cancelled'
  externalBookingId: string
  rescheduledFromExternalId: string | null
  title: string | null
  eventTypeSlug: string | null
  leadName: string | null
  leadPhone: string | null
  leadEmail: string | null
  leadTimezone: string
  organizerEmail: string | null
  meetingStartAt: string
  meetingEndAt: string
  /**
   * Video-call URL, if Cal.com's event type has a video-conferencing
   * location (Google Meet, Zoom, Cal Video, etc.). Best-effort: Cal.com
   * has put this under a few different payload fields across API
   * versions (`videoCallData.url`, `metadata.videoCallUrl`, a plain
   * `location` string for a manually-entered link). Checked in that
   * order, first usable-looking URL wins. VERIFY against a real
   * webhook payload from your own Cal.com event type — if none of
   * these match, add the actual field here.
   */
  meetingLink: string | null
}

const TRIGGER_MAP: Record<CalComTriggerEvent, ParsedCalComBooking['eventType']> = {
  BOOKING_CREATED: 'created',
  BOOKING_RESCHEDULED: 'rescheduled',
  BOOKING_CANCELLED: 'cancelled',
}

function looksLikeUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function extractMeetingLink(payload: Record<string, unknown>): string | null {
  const videoCallData = payload.videoCallData as Record<string, unknown> | undefined
  if (looksLikeUrl(videoCallData?.url)) return videoCallData!.url as string

  const metadata = payload.metadata as Record<string, unknown> | undefined
  if (looksLikeUrl(metadata?.videoCallUrl)) return metadata!.videoCallUrl as string

  // A manually-entered "Link meeting" location is just a plain string.
  // Integration-based locations (e.g. "integrations:google:meet") are
  // not URLs and are deliberately skipped here — the real join link
  // for those lives in videoCallData/metadata above once Cal.com's
  // video integration has run.
  if (looksLikeUrl(payload.location)) return payload.location as string

  return null
}

/**
 * Parse a Cal.com webhook body into the shape `booking-engine.ts`
 * expects. Returns null for a trigger event we don't act on (Cal.com
 * fires many more event types than the three the CRM cares about —
 * e.g. MEETING_ENDED, RECORDING_READY — so an unrecognized
 * `triggerEvent` is a normal, silent no-op, not an error).
 *
 * Phone number: Cal.com only captures it if the event type has a
 * "phone number" booking question configured — `payload.responses.phone`.
 * When absent, `leadPhone` is null and the caller is expected to skip
 * the WhatsApp lifecycle for this booking (documented setup
 * prerequisite, not silently guessed at via email matching).
 */
export function parseCalComPayload(body: unknown): ParsedCalComBooking | null {
  if (!body || typeof body !== 'object') return null
  const root = body as Record<string, unknown>

  const triggerEvent = root.triggerEvent as string | undefined
  if (!triggerEvent || !(triggerEvent in TRIGGER_MAP)) return null

  const payload = root.payload as Record<string, unknown> | undefined
  if (!payload) return null

  const uid = payload.uid as string | undefined
  if (!uid) return null

  const attendees = (payload.attendees as Array<Record<string, unknown>> | undefined) ?? []
  const attendee = attendees[0]

  const organizer = payload.organizer as Record<string, unknown> | undefined
  const eventTypeObj = payload.eventType as Record<string, unknown> | undefined
  const responses = payload.responses as Record<string, unknown> | undefined
  const phoneResponse = responses?.phone as Record<string, unknown> | undefined

  const startTime = payload.startTime as string | undefined
  const endTime = payload.endTime as string | undefined
  if (!startTime || !endTime) return null

  return {
    eventType: TRIGGER_MAP[triggerEvent as CalComTriggerEvent],
    externalBookingId: uid,
    rescheduledFromExternalId: (payload.rescheduleUid as string | undefined) ?? null,
    title: (payload.title as string | undefined) ?? null,
    eventTypeSlug: (eventTypeObj?.slug as string | undefined) ?? null,
    leadName: (attendee?.name as string | undefined) ?? null,
    leadPhone: (phoneResponse?.value as string | undefined) ?? null,
    leadEmail: (attendee?.email as string | undefined) ?? null,
    leadTimezone: (attendee?.timeZone as string | undefined) ?? 'UTC',
    organizerEmail: (organizer?.email as string | undefined) ?? null,
    meetingStartAt: startTime,
    meetingEndAt: endTime,
    meetingLink: extractMeetingLink(payload),
  }
}

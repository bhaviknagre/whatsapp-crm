// ============================================================
// Timezone helpers for the booking lifecycle.
//
// Lead-facing messages are always formatted in `bookings.lead_timezone`
// (from the calendar payload); teammate-facing messages are always
// formatted in `profiles.timezone` (a CRM setting, defaults to 'UTC'
// until the teammate configures it). Both are plain IANA strings —
// this module is the single place that turns one of those + a UTC
// instant into human-readable text, and guards against a malformed/
// unsupported zone string blowing up a send.
// ============================================================

import { formatInTimeZone } from 'date-fns-tz'

const FALLBACK_TIMEZONE = 'UTC'

/**
 * Validate an IANA timezone string, falling back to UTC. A calendar
 * payload or a hand-edited profile setting could contain garbage
 * (empty string, a non-IANA abbreviation like "EST", a typo) — every
 * send path should run its timezone through this before formatting
 * rather than letting `Intl.DateTimeFormat` throw mid-send.
 *
 * Deliberately validated via `Intl.DateTimeFormat` construction rather
 * than `Intl.supportedValuesOf('timeZone')` membership — the latter
 * only returns ICU's canonical names (e.g. "Asia/Calcutta") and
 * rejects valid, commonly-used IANA link names like "Asia/Kolkata"
 * that calendar payloads and timezone pickers actually send.
 */
export function safeTimezone(tz: string | null | undefined): string {
  if (!tz || typeof tz !== 'string' || tz.trim() === '') return FALLBACK_TIMEZONE

  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz })
    return tz
  } catch {
    return FALLBACK_TIMEZONE
  }
}

/**
 * Format a UTC instant for display in `tz`, e.g. "Thu, Aug 20 at 3:30 PM
 * EDT". `isoUtc` accepts anything `new Date()` accepts (ISO string or
 * a Date). Invalid input formats as "UTC" fallback text rather than
 * throwing, since this always runs on the hot path of a WhatsApp send.
 */
export function formatMeetingTime(
  isoUtc: string | Date,
  tz: string | null | undefined,
  opts: { withDate?: boolean } = {}
): string {
  const { withDate = true } = opts
  const date = typeof isoUtc === 'string' ? new Date(isoUtc) : isoUtc
  const zone = safeTimezone(tz)

  const pattern = withDate ? "EEE, MMM d 'at' h:mm a zzz" : 'h:mm a zzz'
  return formatInTimeZone(date, zone, pattern)
}

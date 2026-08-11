import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Contact opt-out (STOP) handling.
 *
 * Meta's WhatsApp Business Policy requires a business to stop messaging
 * a customer who asks to stop. `contacts.opted_out` (migration 038) is
 * the single source of truth, flipped by {@link applyOptOutKeyword} on
 * inbound text and enforced by {@link isOptedOut} at every proactive
 * send path (broadcasts, automations, flows). Manual agent replies from
 * the inbox are intentionally NOT blocked here — those are a human
 * responding inside an existing conversation, not the proactive/
 * marketing messaging the policy targets.
 */

// Matched as the ENTIRE (trimmed, case-insensitive, punctuation-stripped)
// message body — not a substring — so a sentence that merely contains
// the word "stop" doesn't trip it. Mirrors conventional SMS opt-out UX.
const OPT_OUT_KEYWORDS = new Set([
  'stop',
  'unsubscribe',
  'cancel',
  'quit',
  'optout',
  'opt out',
])
const OPT_IN_KEYWORDS = new Set(['start', 'unstop', 'subscribe', 'optin', 'opt in'])

export const OPTED_OUT_ERROR = 'Contact has opted out of messages'

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/[.!?,]+$/g, '')
}

/**
 * Inspect an inbound text message for an opt-out/opt-in keyword and
 * flip `contacts.opted_out` accordingly. Best-effort — errors are
 * logged, never thrown, so a DB hiccup here can't break inbound
 * message processing.
 */
export async function applyOptOutKeyword(
  db: SupabaseClient,
  contactId: string,
  text: string | null | undefined
): Promise<void> {
  if (!text) return
  const normalized = normalize(text)

  let optedOut: boolean | null = null
  if (OPT_OUT_KEYWORDS.has(normalized)) optedOut = true
  else if (OPT_IN_KEYWORDS.has(normalized)) optedOut = false
  if (optedOut === null) return

  const { error } = await db
    .from('contacts')
    .update({
      opted_out: optedOut,
      opted_out_at: optedOut ? new Date().toISOString() : null,
    })
    .eq('id', contactId)

  if (error) {
    console.error('[opt-out] failed to update contact opt-out state:', error.message)
  } else {
    console.info(`[opt-out] contact ${contactId} ${optedOut ? 'opted out' : 'opted back in'}`)
  }
}

/**
 * True when a contact has opted out and must not receive proactive
 * (broadcast / automation / flow) messages. Fails OPEN (returns false)
 * on a lookup error — an outage in this check shouldn't itself block
 * all sends; the DB column is the source of truth when reachable.
 */
export async function isOptedOut(
  db: SupabaseClient,
  contactId: string
): Promise<boolean> {
  const { data, error } = await db
    .from('contacts')
    .select('opted_out')
    .eq('id', contactId)
    .maybeSingle()
  if (error || !data) return false
  return Boolean((data as { opted_out?: boolean }).opted_out)
}

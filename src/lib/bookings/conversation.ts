// ============================================================
// Find-or-create contact + conversation for a booking party (lead or
// teammate). Both parties need a `messages`-thread home so booking
// sends go through the normal `sendMessageToConversation` core.
//
// This reuses the same de-dup helpers the WhatsApp webhook, manual
// contact form, and CSV import already share (src/lib/contacts/dedupe.ts)
// rather than reimplementing phone matching — but the account+conversation
// creation logic itself is re-implemented here (not imported) since the
// webhook route's versions are module-private and the race-recovery
// shape is small enough not to be worth exporting across modules for a
// single new caller.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'

export interface ContactRow {
  id: string
  phone: string
  name: string | null
  account_id: string
  [key: string]: unknown
}

export interface ConversationRow {
  id: string
  account_id: string
  contact_id: string
  [key: string]: unknown
}

/**
 * Resolve (or create) the contact for `phone` within `accountId`. Used
 * both for the lead (their own number) and the teammate (their
 * `profiles.notification_phone`) — from the WhatsApp send pipeline's
 * point of view a teammate notified over WhatsApp is just another
 * contact of the account's business number.
 */
export async function findOrCreateContactForBooking(
  db: SupabaseClient,
  accountId: string,
  ownerUserId: string,
  phone: string,
  name: string | null,
): Promise<ContactRow | null> {
  const existing = await findExistingContact(db, accountId, phone)
  if (existing) {
    if (name && name !== existing.name) {
      await db
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
    }
    return existing as ContactRow
  }

  const { data: created, error } = await db
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: ownerUserId,
      phone,
      name: name || phone,
    })
    .select()
    .single()

  if (error) {
    if (isUniqueViolation(error)) {
      const raced = await findExistingContact(db, accountId, phone)
      if (raced) return raced as ContactRow
    }
    console.error('[bookings] findOrCreateContactForBooking insert failed:', error)
    return null
  }

  return created as ContactRow
}

/**
 * Resolve (or create) the oldest conversation for `contactId`. Mirrors
 * the WhatsApp webhook's oldest-first / limit(1) lookup so booking
 * sends land in the same canonical thread a lead or teammate already
 * has open, rather than spawning a parallel conversation.
 */
export async function findOrCreateConversationForBooking(
  db: SupabaseClient,
  accountId: string,
  ownerUserId: string,
  contactId: string,
): Promise<ConversationRow | null> {
  const { data: existingRows, error: findError } = await db
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1)

  if (findError) {
    console.error('[bookings] conversation lookup failed:', findError)
    return null
  }
  if (existingRows && existingRows.length > 0) {
    return existingRows[0] as ConversationRow
  }

  const { data: created, error: createError } = await db
    .from('conversations')
    .insert({ account_id: accountId, user_id: ownerUserId, contact_id: contactId })
    .select()
    .single()

  if (createError) {
    if (isUniqueViolation(createError)) {
      const { data: raced } = await db
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1)
      if (raced && raced.length > 0) return raced[0] as ConversationRow
    }
    console.error('[bookings] conversation create failed:', createError)
    return null
  }

  return created as ConversationRow
}

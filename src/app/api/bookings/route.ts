import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/bookings/admin-client'
import { createManualBooking } from '@/lib/bookings/booking-engine'

/**
 * POST /api/bookings
 *
 * Manually create a meeting from the CRM — an agent scheduling
 * something they arranged over a call/email, not via Cal.com. Fills
 * lead_name/phone/email from the contact record so the WhatsApp
 * lifecycle (confirmation, reminders, no-show follow-up) behaves
 * identically to a webhook-created booking.
 */
export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const contactId = typeof body.contact_id === 'string' ? body.contact_id : null
  const title = typeof body.title === 'string' ? body.title.trim() : ''
  const meetingStartAt = typeof body.meeting_start_at === 'string' ? body.meeting_start_at : null
  const meetingEndAt = typeof body.meeting_end_at === 'string' ? body.meeting_end_at : null
  const leadTimezone = typeof body.lead_timezone === 'string' ? body.lead_timezone : 'UTC'
  const assignedUserId = typeof body.assigned_user_id === 'string' ? body.assigned_user_id : null
  const conversationId = typeof body.conversation_id === 'string' ? body.conversation_id : null
  const meetingLinkRaw = typeof body.meeting_link === 'string' ? body.meeting_link.trim() : ''

  if (!contactId) return NextResponse.json({ error: 'contact_id is required' }, { status: 400 })
  if (!title) return NextResponse.json({ error: 'title is required' }, { status: 400 })
  if (!meetingStartAt || !meetingEndAt) {
    return NextResponse.json(
      { error: 'meeting_start_at and meeting_end_at are required' },
      { status: 400 },
    )
  }
  if (new Date(meetingEndAt).getTime() <= new Date(meetingStartAt).getTime()) {
    return NextResponse.json({ error: 'meeting_end_at must be after meeting_start_at' }, { status: 400 })
  }
  if (meetingLinkRaw && !/^https?:\/\//i.test(meetingLinkRaw)) {
    return NextResponse.json({ error: 'meeting_link must be a valid http(s) URL' }, { status: 400 })
  }

  const admin = supabaseAdmin()

  const { data: contact, error: contactError } = await admin
    .from('contacts')
    .select('id, name, phone, email')
    .eq('id', contactId)
    .eq('account_id', ctx.accountId)
    .maybeSingle()

  if (contactError || !contact) {
    return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
  }

  let assignedProfileId: string | null = null
  if (assignedUserId) {
    const { data: profile } = await admin
      .from('profiles')
      .select('id')
      .eq('user_id', assignedUserId)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    assignedProfileId = (profile?.id as string | undefined) ?? null
  }

  const result = await createManualBooking(admin, {
    accountId: ctx.accountId,
    contactId: contact.id,
    conversationId,
    assignedProfileId,
    title,
    leadName: contact.name,
    leadPhone: contact.phone,
    leadEmail: contact.email,
    leadTimezone,
    meetingStartAt: new Date(meetingStartAt).toISOString(),
    meetingEndAt: new Date(meetingEndAt).toISOString(),
    rescheduleUrl: null,
    meetingLink: meetingLinkRaw || null,
  })

  if (!result) {
    return NextResponse.json({ error: 'Failed to create booking' }, { status: 500 })
  }

  const { data: booking } = await admin
    .from('bookings')
    .select('*')
    .eq('id', result.bookingId)
    .maybeSingle()

  return NextResponse.json({ booking }, { status: 201 })
}

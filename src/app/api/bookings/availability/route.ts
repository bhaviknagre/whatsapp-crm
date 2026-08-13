import { NextResponse } from 'next/server'
import { fromZonedTime } from 'date-fns-tz'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'

/**
 * GET /api/bookings/availability?date=YYYY-MM-DD&timezone=Area/City
 *
 * Every confirmed booking across the account that overlaps the given
 * calendar day (in the given timezone), with the assignee's name —
 * feeds the "who's free when" timeline in the New Meeting / Reschedule
 * dialogs so an agent can see a teammate's existing bookings before
 * picking a time, instead of finding out about a double-booking after
 * the fact.
 *
 * Read-only, any account member (RLS-scoped via the user's own
 * session) — not gated to 'agent' since viewing availability isn't a
 * write action.
 */
export async function GET(request: Request) {
  let ctx
  try {
    ctx = await getCurrentAccount()
  } catch (err) {
    return toErrorResponse(err)
  }

  const url = new URL(request.url)
  const date = url.searchParams.get('date')
  const timezone = url.searchParams.get('timezone') || 'UTC'

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 })
  }

  let dayStart: Date
  let dayEnd: Date
  try {
    dayStart = fromZonedTime(`${date}T00:00:00`, timezone)
    dayEnd = fromZonedTime(`${date}T23:59:59.999`, timezone)
  } catch {
    return NextResponse.json({ error: 'Invalid timezone' }, { status: 400 })
  }

  // Overlap, not containment — a meeting starting the previous day and
  // ending after midnight should still show up.
  const { data, error } = await ctx.supabase
    .from('bookings')
    .select('id, title, meeting_start_at, meeting_end_at, assigned_profile_id, assignee:profiles(id, full_name, email)')
    .eq('status', 'confirmed')
    .lt('meeting_start_at', dayEnd.toISOString())
    .gt('meeting_end_at', dayStart.toISOString())
    .order('meeting_start_at', { ascending: true })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ bookings: data ?? [] })
}

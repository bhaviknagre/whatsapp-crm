import type { SupabaseClient } from '@supabase/supabase-js'
import { daysAgoStart } from './date-utils'
import type { BookingMetricsBundle, UpcomingBooking } from './types'

// Kept in its own module rather than growing queries.ts — a distinct
// feature area (booking lifecycle) with its own table, not a variant
// of the existing conversation/deal metrics.
//
// Client-side aggregation over a single `bookings` select, same
// "acceptable at current scale, migrate to a SQL RPC if it grows"
// posture as the rest of dashboard/queries.ts. All four metrics are
// derived from one row set (rather than joining booking_events) so
// the confirmation/no-show rates are self-consistent: the denominator
// is always "bookings created in this period," matching the numerator.

type DB = SupabaseClient

export async function loadBookingMetrics(db: DB, rangeDays = 30): Promise<BookingMetricsBundle> {
  const start = daysAgoStart(rangeDays - 1).toISOString()

  const { data, error } = await db
    .from('bookings')
    .select('id, acknowledged_at, attendance_status, recovered')
    .gte('created_at', start)

  if (error) throw error

  const rows = (data ?? []) as {
    acknowledged_at: string | null
    attendance_status: string
    recovered: boolean
  }[]

  const totalBookings = rows.length
  const acknowledgedCount = rows.filter((r) => r.acknowledged_at).length
  const resolvedCount = rows.filter(
    (r) => r.attendance_status === 'attended' || r.attendance_status === 'no_show',
  ).length
  const noShowCount = rows.filter((r) => r.attendance_status === 'no_show').length
  const recoveredMeetings = rows.filter((r) => r.recovered).length

  return {
    totalBookings,
    confirmationRate: totalBookings === 0 ? null : (acknowledgedCount / totalBookings) * 100,
    noShowRate: resolvedCount === 0 ? null : (noShowCount / resolvedCount) * 100,
    recoveredMeetings,
  }
}

/**
 * The next N confirmed, not-yet-started meetings — "how many meetings
 * do we have and when" as an actual agenda, complementing the
 * aggregate counters above. Ordered soonest-first.
 */
export async function loadUpcomingBookings(db: DB, limit = 8): Promise<UpcomingBooking[]> {
  const { data, error } = await db
    .from('bookings')
    .select(
      'id, title, meeting_start_at, meeting_end_at, lead_name, lead_timezone, assignee:profiles(full_name)',
    )
    .eq('status', 'confirmed')
    .gte('meeting_start_at', new Date().toISOString())
    .order('meeting_start_at', { ascending: true })
    .limit(limit)

  if (error) throw error

  return (
    (data ?? []) as unknown as Array<{
      id: string
      title: string | null
      meeting_start_at: string
      meeting_end_at: string
      lead_name: string | null
      lead_timezone: string
      assignee: { full_name: string | null }[] | { full_name: string | null } | null
    }>
  ).map((row) => {
    const assignee = Array.isArray(row.assignee) ? row.assignee[0] : row.assignee
    return {
      id: row.id,
      title: row.title,
      meeting_start_at: row.meeting_start_at,
      meeting_end_at: row.meeting_end_at,
      lead_name: row.lead_name,
      lead_timezone: row.lead_timezone,
      assignee_name: assignee?.full_name ?? null,
    }
  })
}

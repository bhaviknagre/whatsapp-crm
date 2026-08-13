import { describe, expect, it } from 'vitest'
import { loadBookingMetrics, loadUpcomingBookings } from './booking-queries'

function makeDb(rows: Record<string, unknown>[]) {
  return {
    from: () => ({
      select: () => ({
        gte: () => Promise.resolve({ data: rows, error: null }),
      }),
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('loadBookingMetrics', () => {
  it('returns nulls for rates and zero counts when there are no bookings', async () => {
    const result = await loadBookingMetrics(makeDb([]))
    expect(result).toEqual({
      totalBookings: 0,
      confirmationRate: null,
      noShowRate: null,
      recoveredMeetings: 0,
    })
  })

  it('computes confirmation rate against all bookings, no-show rate against resolved only', async () => {
    const rows = [
      { acknowledged_at: '2026-01-01T00:00:00Z', attendance_status: 'attended', recovered: false },
      { acknowledged_at: null, attendance_status: 'no_show', recovered: true },
      { acknowledged_at: null, attendance_status: 'pending', recovered: false },
      { acknowledged_at: '2026-01-01T00:00:00Z', attendance_status: 'pending', recovered: false },
    ]
    const result = await loadBookingMetrics(makeDb(rows))

    expect(result.totalBookings).toBe(4)
    // 2 of 4 acknowledged
    expect(result.confirmationRate).toBe(50)
    // 1 no_show out of 2 resolved (attended + no_show)
    expect(result.noShowRate).toBe(50)
    expect(result.recoveredMeetings).toBe(1)
  })

  it('reports a 0% no-show rate when every resolved booking was attended', async () => {
    const rows = [
      { acknowledged_at: '2026-01-01T00:00:00Z', attendance_status: 'attended', recovered: false },
      { acknowledged_at: '2026-01-01T00:00:00Z', attendance_status: 'attended', recovered: false },
    ]
    const result = await loadBookingMetrics(makeDb(rows))
    expect(result.noShowRate).toBe(0)
    expect(result.confirmationRate).toBe(100)
  })
})

function makeUpcomingDb(rows: Record<string, unknown>[]) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          gte: () => ({
            order: () => ({
              limit: () => Promise.resolve({ data: rows, error: null }),
            }),
          }),
        }),
      }),
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('loadUpcomingBookings', () => {
  it('normalizes an embedded assignee returned as an array (PostgREST default)', async () => {
    const db = makeUpcomingDb([
      {
        id: 'b1',
        title: 'Discovery call',
        meeting_start_at: '2026-08-20T10:00:00Z',
        meeting_end_at: '2026-08-20T10:30:00Z',
        lead_name: 'Jane',
        lead_timezone: 'UTC',
        assignee: [{ full_name: 'Rep One' }],
      },
    ])
    const result = await loadUpcomingBookings(db)
    expect(result).toEqual([
      {
        id: 'b1',
        title: 'Discovery call',
        meeting_start_at: '2026-08-20T10:00:00Z',
        meeting_end_at: '2026-08-20T10:30:00Z',
        lead_name: 'Jane',
        lead_timezone: 'UTC',
        assignee_name: 'Rep One',
      },
    ])
  })

  it('handles a null assignee (unassigned booking)', async () => {
    const db = makeUpcomingDb([
      {
        id: 'b2',
        title: null,
        meeting_start_at: '2026-08-20T10:00:00Z',
        meeting_end_at: '2026-08-20T10:30:00Z',
        lead_name: null,
        lead_timezone: 'UTC',
        assignee: null,
      },
    ])
    const result = await loadUpcomingBookings(db)
    expect(result[0].assignee_name).toBeNull()
  })

  it('returns an empty list when there are no upcoming bookings', async () => {
    expect(await loadUpcomingBookings(makeUpcomingDb([]))).toEqual([])
  })
})

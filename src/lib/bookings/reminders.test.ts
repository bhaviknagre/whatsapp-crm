import { describe, expect, it, vi } from 'vitest'
import { scheduleReminders, cancelReminders, scheduleNoShowFollowups } from './reminders'

// Minimal fake Supabase client tailored to what reminders.ts calls:
// `.from(table).upsert(rows, opts)` and
// `.from(table).update(payload).eq(...).eq(...)[.in(...)]`.
// Records every call so assertions can inspect exactly what was sent,
// without pulling in the full generic mock-chain builder used by the
// automations engine tests (overkill for this module's narrow surface).
function makeFakeDb() {
  const upsertCalls: { table: string; rows: unknown[]; opts: unknown }[] = []
  const updateCalls: { table: string; payload: unknown; filters: [string, unknown][] }[] = []

  const db = {
    from(table: string) {
      return {
        upsert(rows: unknown[], opts: unknown) {
          upsertCalls.push({ table, rows, opts })
          return Promise.resolve({ error: null })
        },
        update(payload: unknown) {
          const filters: [string, unknown][] = []
          const builder = {
            eq(col: string, val: unknown) {
              filters.push([col, val])
              return builder
            },
            in(col: string, vals: unknown) {
              filters.push([col, vals])
              return Promise.resolve({ error: null })
            },
            // Awaiting the builder itself (no .in() call) resolves like a promise.
            then(resolve: (v: { error: null }) => void) {
              updateCalls.push({ table, payload, filters })
              resolve({ error: null })
            },
          }
          return builder
        },
      }
    },
  }

  return { db, upsertCalls, updateCalls }
}

describe('scheduleReminders', () => {
  it('upserts confirmation + 1h + 15m + no_show_check when the meeting is far in the future', async () => {
    const { db, upsertCalls } = makeFakeDb()
    const now = Date.now()
    const booking = {
      id: 'b1',
      account_id: 'acc1',
      meeting_start_at: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
      meeting_end_at: new Date(now + 2.5 * 60 * 60 * 1000).toISOString(),
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await scheduleReminders(db as any, booking)

    expect(upsertCalls).toHaveLength(1)
    const kinds = (upsertCalls[0].rows as { kind: string }[]).map((r) => r.kind)
    expect(kinds).toEqual(['confirmation', 'reminder_1h', 'reminder_15m', 'no_show_check'])
    expect(upsertCalls[0].opts).toEqual({ onConflict: 'booking_id,kind' })
  })

  it('skips reminder_1h / reminder_15m when their fire time has already passed', async () => {
    const { db, upsertCalls } = makeFakeDb()
    const now = Date.now()
    const booking = {
      id: 'b2',
      account_id: 'acc1',
      // Meeting starts in 5 minutes — both the 1h and 15m marks are in the past.
      meeting_start_at: new Date(now + 5 * 60 * 1000).toISOString(),
      meeting_end_at: new Date(now + 35 * 60 * 1000).toISOString(),
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await scheduleReminders(db as any, booking)

    const kinds = (upsertCalls[0].rows as { kind: string }[]).map((r) => r.kind)
    expect(kinds).toEqual(['confirmation', 'no_show_check'])
  })
})

describe('cancelReminders', () => {
  it('cancels all pending kinds when none are specified', async () => {
    const { db, updateCalls } = makeFakeDb()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await cancelReminders(db as any, 'b1')

    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0].payload).toEqual({ status: 'cancelled' })
    expect(updateCalls[0].filters).toEqual([
      ['booking_id', 'b1'],
      ['status', 'pending'],
    ])
  })

  it('narrows to specific kinds when given', async () => {
    const { db } = makeFakeDb()
    const inSpy = vi.fn(() => Promise.resolve({ error: null }))
    const scoped = {
      from: () => ({
        update: () => ({
          eq: () => ({ eq: () => ({ in: inSpy }) }),
        }),
      }),
    }
    void db
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await cancelReminders(scoped as any, 'b1', ['reminder_1h', 'reminder_15m'])
    expect(inSpy).toHaveBeenCalledWith('kind', ['reminder_1h', 'reminder_15m'])
  })
})

describe('scheduleNoShowFollowups', () => {
  it('enqueues the 1-minute and 4-hour follow-ups anchored on runFrom', async () => {
    const { db, upsertCalls } = makeFakeDb()
    const anchor = new Date('2026-08-20T15:00:00Z')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await scheduleNoShowFollowups(db as any, { id: 'b3', account_id: 'acc1' }, anchor)

    const rows = upsertCalls[0].rows as { kind: string; run_at: string }[]
    expect(rows.map((r) => r.kind)).toEqual(['no_show_followup_1m', 'no_show_followup_4h'])
    expect(rows[0].run_at).toBe(new Date(anchor.getTime() + 60_000).toISOString())
    expect(rows[1].run_at).toBe(new Date(anchor.getTime() + 4 * 60 * 60_000).toISOString())
  })
})

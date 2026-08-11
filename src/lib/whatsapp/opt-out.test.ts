import { describe, expect, it } from 'vitest'
import { applyOptOutKeyword, isOptedOut } from './opt-out'

function makeUpdateDb() {
  const updates: Array<{ table: string; values: Record<string, unknown>; id: string }> = []
  const db = {
    from(table: string) {
      return {
        update(values: Record<string, unknown>) {
          return {
            eq(_col: string, id: string) {
              updates.push({ table, values, id })
              return Promise.resolve({ error: null })
            },
          }
        },
      }
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
  return { db, updates }
}

function makeSelectDb(row: { opted_out?: boolean } | null, error: unknown = null) {
  const db = {
    from() {
      return {
        select() {
          return {
            eq() {
              return { maybeSingle: () => Promise.resolve({ data: row, error }) }
            },
          }
        },
      }
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
  return db
}

describe('applyOptOutKeyword', () => {
  it('opts a contact out on an exact "STOP" message (case/whitespace-insensitive)', async () => {
    const { db, updates } = makeUpdateDb()
    await applyOptOutKeyword(db, 'contact-1', '  Stop  ')
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({ table: 'contacts', id: 'contact-1' })
    expect(updates[0].values.opted_out).toBe(true)
    expect(updates[0].values.opted_out_at).toEqual(expect.any(String))
  })

  it('recognizes other opt-out synonyms and trailing punctuation', async () => {
    for (const text of ['unsubscribe', 'Cancel.', 'QUIT!', 'opt out']) {
      const { db, updates } = makeUpdateDb()
      await applyOptOutKeyword(db, 'contact-1', text)
      expect(updates[0]?.values.opted_out).toBe(true)
    }
  })

  it('opts a contact back in on "START" and clears opted_out_at', async () => {
    const { db, updates } = makeUpdateDb()
    await applyOptOutKeyword(db, 'contact-1', 'start')
    expect(updates[0].values).toEqual({ opted_out: false, opted_out_at: null })
  })

  it('does nothing for a normal conversational message, even one containing "stop"', async () => {
    const { db, updates } = makeUpdateDb()
    await applyOptOutKeyword(db, 'contact-1', 'please stop calling me at night')
    expect(updates).toHaveLength(0)
  })

  it('does nothing for empty/null text', async () => {
    const { db, updates } = makeUpdateDb()
    await applyOptOutKeyword(db, 'contact-1', null)
    await applyOptOutKeyword(db, 'contact-1', '')
    expect(updates).toHaveLength(0)
  })
})

describe('isOptedOut', () => {
  it('returns true when the contact row has opted_out = true', async () => {
    const db = makeSelectDb({ opted_out: true })
    expect(await isOptedOut(db, 'contact-1')).toBe(true)
  })

  it('returns false when the contact has not opted out', async () => {
    const db = makeSelectDb({ opted_out: false })
    expect(await isOptedOut(db, 'contact-1')).toBe(false)
  })

  it('fails open (false) on a lookup error', async () => {
    const db = makeSelectDb(null, new Error('db down'))
    expect(await isOptedOut(db, 'contact-1')).toBe(false)
  })

  it('fails open (false) when the contact row is missing', async () => {
    const db = makeSelectDb(null)
    expect(await isOptedOut(db, 'contact-1')).toBe(false)
  })
})

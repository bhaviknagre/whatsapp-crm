import { describe, expect, it } from 'vitest'
import { safeTimezone, formatMeetingTime } from './timezone'

describe('safeTimezone', () => {
  it('passes through a valid IANA zone', () => {
    expect(safeTimezone('America/New_York')).toBe('America/New_York')
    expect(safeTimezone('Asia/Kolkata')).toBe('Asia/Kolkata')
  })

  it('falls back to UTC for null/undefined/empty', () => {
    expect(safeTimezone(null)).toBe('UTC')
    expect(safeTimezone(undefined)).toBe('UTC')
    expect(safeTimezone('')).toBe('UTC')
    expect(safeTimezone('   ')).toBe('UTC')
  })

  it('falls back to UTC for a garbage string', () => {
    expect(safeTimezone('not-a-timezone')).toBe('UTC')
    expect(safeTimezone('Mars/Cydonia')).toBe('UTC')
  })
})

describe('formatMeetingTime', () => {
  const instant = '2026-08-20T14:30:00Z'

  it('formats in the given timezone with date by default', () => {
    const out = formatMeetingTime(instant, 'America/New_York')
    expect(out).toContain('Aug 20')
    expect(out).toContain('10:30 AM')
  })

  it('formats time-only when withDate is false', () => {
    const out = formatMeetingTime(instant, 'America/New_York', { withDate: false })
    expect(out).not.toContain('Aug')
    expect(out).toContain('10:30 AM')
  })

  it('falls back to UTC formatting for an invalid timezone', () => {
    const out = formatMeetingTime(instant, 'garbage-zone')
    expect(out).toContain('2:30 PM')
  })

  it('accepts a Date instance as well as an ISO string', () => {
    const out = formatMeetingTime(new Date(instant), 'UTC')
    expect(out).toContain('2:30 PM')
  })
})

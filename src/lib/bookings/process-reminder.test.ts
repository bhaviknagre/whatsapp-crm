import { describe, expect, it, vi, beforeEach } from 'vitest'

const sendBookingConfirmation = vi.fn()
const sendBookingReminder = vi.fn()
const sendBookingCancellation = vi.fn()
const sendNoShowFollowup = vi.fn()
vi.mock('./sender', () => ({
  sendBookingConfirmation: (...args: unknown[]) => sendBookingConfirmation(...args),
  sendBookingReminder: (...args: unknown[]) => sendBookingReminder(...args),
  sendBookingCancellation: (...args: unknown[]) => sendBookingCancellation(...args),
  sendNoShowFollowup: (...args: unknown[]) => sendNoShowFollowup(...args),
}))

const evaluateNoShow = vi.fn()
vi.mock('./no-show', () => ({
  evaluateNoShow: (...args: unknown[]) => evaluateNoShow(...args),
}))

const logBookingEvent = vi.fn()
vi.mock('./events', () => ({
  logBookingEvent: (...args: unknown[]) => logBookingEvent(...args),
}))

import { processReminderRow } from './process-reminder'

function makeDb(booking: Record<string, unknown> | null) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: booking, error: null }),
        }),
      }),
    }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('processReminderRow', () => {
  const row = { id: 'r1', account_id: 'acc1', booking_id: 'b1' }

  it('throws when the booking is missing', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(processReminderRow(makeDb(null) as any, { ...row, kind: 'confirmation' })).rejects.toThrow(
      'booking b1 not found',
    )
  })

  it('sends confirmation and logs confirmation_sent', async () => {
    const db = makeDb({ id: 'b1', status: 'confirmed' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await processReminderRow(db as any, { ...row, kind: 'confirmation' })
    expect(sendBookingConfirmation).toHaveBeenCalledTimes(1)
    expect(logBookingEvent).toHaveBeenCalledWith(db, 'acc1', 'b1', 'confirmation_sent')
  })

  it('sends the 1h reminder with the right variant', async () => {
    const db = makeDb({ id: 'b1', status: 'confirmed' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await processReminderRow(db as any, { ...row, kind: 'reminder_1h' })
    expect(sendBookingReminder).toHaveBeenCalledWith(db, expect.objectContaining({ id: 'b1' }), '1h')
  })

  it('delegates no_show_check to evaluateNoShow without logging a *_sent event', async () => {
    const db = makeDb({ id: 'b1', status: 'confirmed' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await processReminderRow(db as any, { ...row, kind: 'no_show_check' })
    expect(evaluateNoShow).toHaveBeenCalledTimes(1)
    expect(logBookingEvent).not.toHaveBeenCalled()
  })

  it('sends the no-show follow-up when still no_show', async () => {
    const db = makeDb({ id: 'b1', status: 'confirmed', attendance_status: 'no_show' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await processReminderRow(db as any, { ...row, kind: 'no_show_followup_1m' })
    expect(sendNoShowFollowup).toHaveBeenCalledTimes(1)
    expect(logBookingEvent).toHaveBeenCalledWith(db, 'acc1', 'b1', 'no_show_followup_1m_sent')
  })

  it('skips the no-show follow-up when attendance was reclassified', async () => {
    const db = makeDb({ id: 'b1', status: 'confirmed', attendance_status: 'attended' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await processReminderRow(db as any, { ...row, kind: 'no_show_followup_1m' })
    expect(sendNoShowFollowup).not.toHaveBeenCalled()
    expect(logBookingEvent).not.toHaveBeenCalled()
  })

  it('skips non-cancellation kinds when the booking is already cancelled', async () => {
    const db = makeDb({ id: 'b1', status: 'cancelled' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await processReminderRow(db as any, { ...row, kind: 'reminder_1h' })
    expect(sendBookingReminder).not.toHaveBeenCalled()
  })

  it('still processes a cancellation kind on an already-cancelled booking', async () => {
    const db = makeDb({ id: 'b1', status: 'cancelled' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await processReminderRow(db as any, { ...row, kind: 'cancellation' })
    expect(sendBookingCancellation).toHaveBeenCalledTimes(1)
  })
})

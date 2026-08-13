import { describe, expect, it, vi, beforeEach } from 'vitest'

const sendMessageToConversation = vi.fn()
vi.mock('@/lib/whatsapp/send-message', () => ({
  sendMessageToConversation: (...args: unknown[]) => sendMessageToConversation(...args),
}))

const logBookingEvent = vi.fn()
vi.mock('./events', () => ({
  logBookingEvent: (...args: unknown[]) => logBookingEvent(...args),
}))

import { handleBookingButtonTap } from './ack'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeDb(booking: Record<string, unknown> | null, updateSpy: any = vi.fn(() => Promise.resolve({ error: null }))) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            eq: () => ({
              is: () => ({
                order: () => ({
                  limit: () => ({
                    maybeSingle: () => Promise.resolve({ data: booking, error: null }),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
      update: (payload: unknown) => ({
        eq: (...args: unknown[]) => updateSpy(payload, ...args),
      }),
    }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('handleBookingButtonTap', () => {
  const baseInput = {
    accountId: 'acc1',
    contactId: 'contact1',
    conversationId: 'conv1',
    action: 'ack' as const,
  }

  it('no-ops when there is no open unacknowledged booking', async () => {
    const db = makeDb(null)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleBookingButtonTap(db as any, baseInput)
    expect(logBookingEvent).not.toHaveBeenCalled()
    expect(sendMessageToConversation).not.toHaveBeenCalled()
  })

  it('sets acknowledged_at and logs the event on ack', async () => {
    const updateSpy = vi.fn(() => Promise.resolve({ error: null }))
    const db = makeDb({ id: 'b1', reschedule_url: 'https://cal.com/x' }, updateSpy)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleBookingButtonTap(db as any, baseInput)

    expect(updateSpy).toHaveBeenCalledTimes(1)
    const [payload] = updateSpy.mock.calls[0] as unknown[]
    expect(payload).toHaveProperty('acknowledged_at')
    expect(logBookingEvent).toHaveBeenCalledWith(db, 'acc1', 'b1', 'acknowledged')
    expect(sendMessageToConversation).not.toHaveBeenCalled()
  })

  it('replies with the reschedule link on reschedule and does not touch acknowledged_at', async () => {
    const db = makeDb({ id: 'b1', reschedule_url: 'https://cal.com/x' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleBookingButtonTap(db as any, { ...baseInput, action: 'reschedule' })

    expect(sendMessageToConversation).toHaveBeenCalledWith(
      db,
      'acc1',
      expect.objectContaining({
        conversationId: 'conv1',
        messageType: 'text',
        contentText: expect.stringContaining('https://cal.com/x'),
      }),
    )
    expect(logBookingEvent).not.toHaveBeenCalled()
  })

  it('does nothing on reschedule when the booking has no reschedule_url', async () => {
    const db = makeDb({ id: 'b1', reschedule_url: null })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleBookingButtonTap(db as any, { ...baseInput, action: 'reschedule' })
    expect(sendMessageToConversation).not.toHaveBeenCalled()
  })
})

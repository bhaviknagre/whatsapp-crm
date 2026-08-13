import { describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import { parseCalComPayload, verifyCalComSignature } from './cal-com'

function samplePayload(overrides: Record<string, unknown> = {}) {
  return {
    triggerEvent: 'BOOKING_CREATED',
    payload: {
      uid: 'abc123',
      title: '30 Min Meeting between Jane and Rep',
      eventType: { slug: '30min', title: '30 Min Meeting' },
      startTime: '2026-08-20T10:00:00Z',
      endTime: '2026-08-20T10:30:00Z',
      attendees: [{ name: 'Jane Lead', email: 'jane@x.com', timeZone: 'America/New_York' }],
      organizer: { name: 'Rep', email: 'rep@wacrm.com', timeZone: 'Asia/Kolkata' },
      responses: { phone: { value: '+15551234567' } },
      ...overrides,
    },
  }
}

describe('parseCalComPayload', () => {
  it('parses a BOOKING_CREATED payload', () => {
    const parsed = parseCalComPayload(samplePayload())
    expect(parsed).toEqual({
      eventType: 'created',
      externalBookingId: 'abc123',
      rescheduledFromExternalId: null,
      title: '30 Min Meeting between Jane and Rep',
      eventTypeSlug: '30min',
      leadName: 'Jane Lead',
      leadPhone: '+15551234567',
      leadEmail: 'jane@x.com',
      leadTimezone: 'America/New_York',
      organizerEmail: 'rep@wacrm.com',
      meetingStartAt: '2026-08-20T10:00:00Z',
      meetingEndAt: '2026-08-20T10:30:00Z',
      meetingLink: null,
    })
  })

  it('maps BOOKING_RESCHEDULED and BOOKING_CANCELLED trigger events', () => {
    const rescheduled = parseCalComPayload({
      triggerEvent: 'BOOKING_RESCHEDULED',
      payload: { ...samplePayload().payload, rescheduleUid: 'old-uid' },
    })
    expect(rescheduled?.eventType).toBe('rescheduled')
    expect(rescheduled?.rescheduledFromExternalId).toBe('old-uid')

    const cancelled = parseCalComPayload({
      triggerEvent: 'BOOKING_CANCELLED',
      payload: samplePayload().payload,
    })
    expect(cancelled?.eventType).toBe('cancelled')
  })

  it('returns null for an unrecognized trigger event', () => {
    expect(parseCalComPayload({ triggerEvent: 'MEETING_ENDED', payload: {} })).toBeNull()
  })

  it('returns null when uid or start/end time is missing', () => {
    const noUid = samplePayload()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (noUid.payload as any).uid
    expect(parseCalComPayload(noUid)).toBeNull()

    const noStart = samplePayload()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (noStart.payload as any).startTime
    expect(parseCalComPayload(noStart)).toBeNull()
  })

  it('leaves leadPhone null when the phone response is absent', () => {
    const noPhone = samplePayload({ responses: {} })
    expect(parseCalComPayload(noPhone)?.leadPhone).toBeNull()
  })

  it('returns null for malformed root input', () => {
    expect(parseCalComPayload(null)).toBeNull()
    expect(parseCalComPayload('not an object')).toBeNull()
    expect(parseCalComPayload({})).toBeNull()
  })

  describe('meetingLink extraction', () => {
    it('prefers videoCallData.url', () => {
      const parsed = parseCalComPayload(
        samplePayload({
          videoCallData: { url: 'https://meet.google.com/abc-defg-hij' },
          metadata: { videoCallUrl: 'https://zoom.us/j/other' },
          location: 'https://plain-location.example/link',
        }),
      )
      expect(parsed?.meetingLink).toBe('https://meet.google.com/abc-defg-hij')
    })

    it('falls back to metadata.videoCallUrl', () => {
      const parsed = parseCalComPayload(
        samplePayload({ metadata: { videoCallUrl: 'https://zoom.us/j/12345' } }),
      )
      expect(parsed?.meetingLink).toBe('https://zoom.us/j/12345')
    })

    it('falls back to a plain-string location if it looks like a URL', () => {
      const parsed = parseCalComPayload(samplePayload({ location: 'https://cal.com/video/xyz' }))
      expect(parsed?.meetingLink).toBe('https://cal.com/video/xyz')
    })

    it('ignores a non-URL integration location like "integrations:google:meet"', () => {
      const parsed = parseCalComPayload(samplePayload({ location: 'integrations:google:meet' }))
      expect(parsed?.meetingLink).toBeNull()
    })

    it('is null when nothing usable is present', () => {
      const parsed = parseCalComPayload(samplePayload())
      expect(parsed?.meetingLink).toBeNull()
    })
  })
})

describe('verifyCalComSignature', () => {
  const secret = 'test-secret'
  const body = JSON.stringify({ hello: 'world' })
  const validSig = crypto.createHmac('sha256', secret).update(body).digest('hex')

  it('accepts a valid signature', () => {
    expect(verifyCalComSignature(body, validSig, secret)).toBe(true)
  })

  it('rejects a missing signature header', () => {
    expect(verifyCalComSignature(body, null, secret)).toBe(false)
  })

  it('rejects a wrong signature', () => {
    expect(verifyCalComSignature(body, 'deadbeef', secret)).toBe(false)
  })

  it('rejects a signature computed with the wrong secret', () => {
    const wrongSig = crypto.createHmac('sha256', 'other-secret').update(body).digest('hex')
    expect(verifyCalComSignature(body, wrongSig, secret)).toBe(false)
  })
})

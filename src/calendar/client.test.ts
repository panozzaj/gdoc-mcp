import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  listCalendars,
  listEvents,
  getEvent,
  createEvent,
  updateEvent,
  deleteEvent,
  quickAdd,
} from './client.js'

vi.mock('../auth.js', () => ({
  getCalendarClient: vi.fn(),
}))

import { getCalendarClient } from '../auth.js'

function createMockEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'event-1',
    summary: 'Test Event',
    start: { dateTime: '2025-06-15T10:00:00-04:00' },
    end: { dateTime: '2025-06-15T11:00:00-04:00' },
    status: 'confirmed',
    htmlLink: 'https://calendar.google.com/event?eid=abc',
    ...overrides,
  }
}

describe('Google Calendar Client', () => {
  let mockCalendarClient: {
    calendarList: {
      list: ReturnType<typeof vi.fn>
    }
    events: {
      list: ReturnType<typeof vi.fn>
      get: ReturnType<typeof vi.fn>
      insert: ReturnType<typeof vi.fn>
      update: ReturnType<typeof vi.fn>
      delete: ReturnType<typeof vi.fn>
      quickAdd: ReturnType<typeof vi.fn>
    }
  }

  beforeEach(() => {
    mockCalendarClient = {
      calendarList: {
        list: vi.fn(),
      },
      events: {
        list: vi.fn(),
        get: vi.fn(),
        insert: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        quickAdd: vi.fn(),
      },
    }

    vi.mocked(getCalendarClient).mockResolvedValue(mockCalendarClient as any)
  })

  describe('listCalendars', () => {
    it('returns all calendars', async () => {
      mockCalendarClient.calendarList.list.mockResolvedValue({
        data: {
          items: [
            { id: 'primary@gmail.com', summary: 'My Calendar', primary: true },
            { id: 'work@group.calendar.google.com', summary: 'Work' },
            { id: 'holidays@group.v.calendar.google.com', summary: 'US Holidays' },
          ],
        },
      })

      const result = await listCalendars()

      expect(result).toHaveLength(3)
      expect(result[0]).toEqual({
        id: 'primary@gmail.com',
        summary: 'My Calendar',
        primary: true,
      })
      expect(result[1]).toEqual({
        id: 'work@group.calendar.google.com',
        summary: 'Work',
        primary: false,
      })
    })

    it('handles empty calendar list', async () => {
      mockCalendarClient.calendarList.list.mockResolvedValue({
        data: { items: [] },
      })

      const result = await listCalendars()
      expect(result).toHaveLength(0)
    })

    it('handles missing fields gracefully', async () => {
      mockCalendarClient.calendarList.list.mockResolvedValue({
        data: {
          items: [{ id: null, summary: null }],
        },
      })

      const result = await listCalendars()
      expect(result[0]).toEqual({ id: '', summary: '(unnamed)', primary: false })
    })
  })

  describe('listEvents', () => {
    it('returns upcoming events', async () => {
      mockCalendarClient.events.list.mockResolvedValue({
        data: {
          items: [
            createMockEvent({ id: 'e1', summary: 'Meeting' }),
            createMockEvent({ id: 'e2', summary: 'Lunch' }),
          ],
        },
      })

      const result = await listEvents('primary')

      expect(result).toHaveLength(2)
      expect(result[0].id).toBe('e1')
      expect(result[0].summary).toBe('Meeting')
      expect(result[1].summary).toBe('Lunch')
    })

    it('passes time range params to API', async () => {
      mockCalendarClient.events.list.mockResolvedValue({
        data: { items: [] },
      })

      await listEvents('primary', '2025-06-01T00:00:00Z', '2025-06-30T23:59:59Z', 5, 'standup')

      expect(mockCalendarClient.events.list).toHaveBeenCalledWith(
        expect.objectContaining({
          calendarId: 'primary',
          timeMin: '2025-06-01T00:00:00Z',
          timeMax: '2025-06-30T23:59:59Z',
          maxResults: 5,
          q: 'standup',
          singleEvents: true,
          orderBy: 'startTime',
        }),
      )
    })

    it('defaults timeMin to now when not specified', async () => {
      mockCalendarClient.events.list.mockResolvedValue({
        data: { items: [] },
      })

      const before = new Date().toISOString()
      await listEvents()
      const after = new Date().toISOString()

      const call = mockCalendarClient.events.list.mock.calls[0][0]
      expect(call.timeMin >= before).toBe(true)
      expect(call.timeMin <= after).toBe(true)
    })

    it('defaults calendarId to primary', async () => {
      mockCalendarClient.events.list.mockResolvedValue({
        data: { items: [] },
      })

      await listEvents()

      expect(mockCalendarClient.events.list).toHaveBeenCalledWith(
        expect.objectContaining({ calendarId: 'primary' }),
      )
    })

    it('handles all-day events', async () => {
      mockCalendarClient.events.list.mockResolvedValue({
        data: {
          items: [
            createMockEvent({
              start: { date: '2025-06-15' },
              end: { date: '2025-06-16' },
            }),
          ],
        },
      })

      const result = await listEvents()

      expect(result[0].allDay).toBe(true)
      expect(result[0].start).toBe('2025-06-15')
    })

    it('extracts meet link from hangoutLink', async () => {
      mockCalendarClient.events.list.mockResolvedValue({
        data: {
          items: [
            createMockEvent({
              hangoutLink: 'https://meet.google.com/abc-def-ghi',
            }),
          ],
        },
      })

      const result = await listEvents()
      expect(result[0].meetLink).toBe('https://meet.google.com/abc-def-ghi')
    })

    it('extracts meet link from conferenceData when no hangoutLink', async () => {
      mockCalendarClient.events.list.mockResolvedValue({
        data: {
          items: [
            createMockEvent({
              hangoutLink: undefined,
              conferenceData: {
                entryPoints: [{ uri: 'https://zoom.us/j/12345', entryPointType: 'video' }],
              },
            }),
          ],
        },
      })

      const result = await listEvents()
      expect(result[0].meetLink).toBe('https://zoom.us/j/12345')
    })

    it('parses attendees', async () => {
      mockCalendarClient.events.list.mockResolvedValue({
        data: {
          items: [
            createMockEvent({
              attendees: [
                { email: 'alice@example.com' },
                { email: 'bob@example.com' },
                { email: '' },
              ],
            }),
          ],
        },
      })

      const result = await listEvents()
      expect(result[0].attendees).toEqual(['alice@example.com', 'bob@example.com'])
    })

    it('handles event with no title', async () => {
      mockCalendarClient.events.list.mockResolvedValue({
        data: {
          items: [createMockEvent({ summary: undefined })],
        },
      })

      const result = await listEvents()
      expect(result[0].summary).toBe('(no title)')
    })
  })

  describe('getEvent', () => {
    it('returns full event details', async () => {
      mockCalendarClient.events.get.mockResolvedValue({
        data: createMockEvent({
          description: 'Discuss Q3 goals',
          location: 'Conference Room A',
          attendees: [{ email: 'alice@example.com' }],
        }),
      })

      const result = await getEvent('primary', 'event-1')

      expect(result.id).toBe('event-1')
      expect(result.summary).toBe('Test Event')
      expect(result.description).toBe('Discuss Q3 goals')
      expect(result.location).toBe('Conference Room A')
      expect(result.attendees).toEqual(['alice@example.com'])
    })

    it('passes correct params to API', async () => {
      mockCalendarClient.events.get.mockResolvedValue({
        data: createMockEvent(),
      })

      await getEvent('work-calendar', 'evt-123')

      expect(mockCalendarClient.events.get).toHaveBeenCalledWith({
        calendarId: 'work-calendar',
        eventId: 'evt-123',
      })
    })
  })

  describe('createEvent', () => {
    it('creates a timed event', async () => {
      mockCalendarClient.events.insert.mockResolvedValue({
        data: createMockEvent({ id: 'new-event' }),
      })

      const result = await createEvent('primary', {
        summary: 'Team Standup',
        start: '2025-06-15T09:00:00-04:00',
        end: '2025-06-15T09:30:00-04:00',
      })

      expect(result.id).toBe('new-event')
      expect(mockCalendarClient.events.insert).toHaveBeenCalledWith({
        calendarId: 'primary',
        requestBody: expect.objectContaining({
          summary: 'Team Standup',
          start: { dateTime: '2025-06-15T09:00:00-04:00', timeZone: expect.any(String) },
          end: { dateTime: '2025-06-15T09:30:00-04:00', timeZone: expect.any(String) },
        }),
      })
    })

    it('creates an all-day event', async () => {
      mockCalendarClient.events.insert.mockResolvedValue({
        data: createMockEvent({
          start: { date: '2025-06-15' },
          end: { date: '2025-06-16' },
        }),
      })

      await createEvent('primary', {
        summary: 'Vacation',
        start: '2025-06-15',
        end: '2025-06-16',
      })

      expect(mockCalendarClient.events.insert).toHaveBeenCalledWith({
        calendarId: 'primary',
        requestBody: expect.objectContaining({
          start: { date: '2025-06-15' },
          end: { date: '2025-06-16' },
        }),
      })
    })

    it('includes optional fields', async () => {
      mockCalendarClient.events.insert.mockResolvedValue({
        data: createMockEvent(),
      })

      await createEvent('primary', {
        summary: 'Lunch',
        start: '2025-06-15T12:00:00-04:00',
        end: '2025-06-15T13:00:00-04:00',
        description: 'Team lunch',
        location: 'Cafe Milano',
        attendees: ['alice@example.com', 'bob@example.com'],
      })

      expect(mockCalendarClient.events.insert).toHaveBeenCalledWith({
        calendarId: 'primary',
        requestBody: expect.objectContaining({
          description: 'Team lunch',
          location: 'Cafe Milano',
          attendees: [{ email: 'alice@example.com' }, { email: 'bob@example.com' }],
        }),
      })
    })

    it('uses provided timeZone', async () => {
      mockCalendarClient.events.insert.mockResolvedValue({
        data: createMockEvent(),
      })

      await createEvent('primary', {
        summary: 'Call',
        start: '2025-06-15T10:00:00',
        end: '2025-06-15T11:00:00',
        timeZone: 'America/Los_Angeles',
      })

      expect(mockCalendarClient.events.insert).toHaveBeenCalledWith({
        calendarId: 'primary',
        requestBody: expect.objectContaining({
          start: { dateTime: '2025-06-15T10:00:00', timeZone: 'America/Los_Angeles' },
          end: { dateTime: '2025-06-15T11:00:00', timeZone: 'America/Los_Angeles' },
        }),
      })
    })
  })

  describe('updateEvent', () => {
    it('fetches existing event and merges updates', async () => {
      const existingEvent = createMockEvent({
        summary: 'Old Title',
        description: 'Old description',
        location: 'Room A',
      })

      mockCalendarClient.events.get.mockResolvedValue({ data: existingEvent })
      mockCalendarClient.events.update.mockResolvedValue({
        data: { ...existingEvent, summary: 'New Title' },
      })

      const result = await updateEvent('primary', 'event-1', { summary: 'New Title' })

      expect(result.summary).toBe('New Title')
      expect(mockCalendarClient.events.update).toHaveBeenCalledWith({
        calendarId: 'primary',
        eventId: 'event-1',
        requestBody: expect.objectContaining({
          summary: 'New Title',
          description: 'Old description',
          location: 'Room A',
        }),
      })
    })

    it('updates start/end times', async () => {
      mockCalendarClient.events.get.mockResolvedValue({
        data: createMockEvent(),
      })
      mockCalendarClient.events.update.mockResolvedValue({
        data: createMockEvent({
          start: { dateTime: '2025-06-15T14:00:00-04:00' },
          end: { dateTime: '2025-06-15T15:00:00-04:00' },
        }),
      })

      await updateEvent('primary', 'event-1', {
        start: '2025-06-15T14:00:00-04:00',
        end: '2025-06-15T15:00:00-04:00',
      })

      expect(mockCalendarClient.events.update).toHaveBeenCalledWith({
        calendarId: 'primary',
        eventId: 'event-1',
        requestBody: expect.objectContaining({
          start: { dateTime: '2025-06-15T14:00:00-04:00', timeZone: expect.any(String) },
          end: { dateTime: '2025-06-15T15:00:00-04:00', timeZone: expect.any(String) },
        }),
      })
    })

    it('updates attendees', async () => {
      mockCalendarClient.events.get.mockResolvedValue({
        data: createMockEvent(),
      })
      mockCalendarClient.events.update.mockResolvedValue({
        data: createMockEvent(),
      })

      await updateEvent('primary', 'event-1', {
        attendees: ['new@example.com'],
      })

      expect(mockCalendarClient.events.update).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: expect.objectContaining({
            attendees: [{ email: 'new@example.com' }],
          }),
        }),
      )
    })

    it('converts to all-day when date format used', async () => {
      mockCalendarClient.events.get.mockResolvedValue({
        data: createMockEvent(),
      })
      mockCalendarClient.events.update.mockResolvedValue({
        data: createMockEvent({
          start: { date: '2025-06-15' },
          end: { date: '2025-06-16' },
        }),
      })

      await updateEvent('primary', 'event-1', {
        start: '2025-06-15',
        end: '2025-06-16',
      })

      expect(mockCalendarClient.events.update).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: expect.objectContaining({
            start: { date: '2025-06-15' },
            end: { date: '2025-06-16' },
          }),
        }),
      )
    })
  })

  describe('deleteEvent', () => {
    it('deletes the event', async () => {
      mockCalendarClient.events.delete.mockResolvedValue({})

      await deleteEvent('primary', 'event-1')

      expect(mockCalendarClient.events.delete).toHaveBeenCalledWith({
        calendarId: 'primary',
        eventId: 'event-1',
      })
    })

    it('defaults calendarId to primary', async () => {
      mockCalendarClient.events.delete.mockResolvedValue({})

      await deleteEvent(undefined, 'event-1')

      expect(mockCalendarClient.events.delete).toHaveBeenCalledWith({
        calendarId: 'primary',
        eventId: 'event-1',
      })
    })
  })

  describe('quickAdd', () => {
    it('creates event from natural language', async () => {
      mockCalendarClient.events.quickAdd.mockResolvedValue({
        data: createMockEvent({ summary: 'Lunch with Bob' }),
      })

      const result = await quickAdd('primary', 'Lunch with Bob tomorrow at noon')

      expect(result.summary).toBe('Lunch with Bob')
      expect(mockCalendarClient.events.quickAdd).toHaveBeenCalledWith({
        calendarId: 'primary',
        text: 'Lunch with Bob tomorrow at noon',
      })
    })

    it('defaults calendarId to primary', async () => {
      mockCalendarClient.events.quickAdd.mockResolvedValue({
        data: createMockEvent(),
      })

      await quickAdd(undefined, 'Dentist Friday 2pm')

      expect(mockCalendarClient.events.quickAdd).toHaveBeenCalledWith({
        calendarId: 'primary',
        text: 'Dentist Friday 2pm',
      })
    })
  })
})

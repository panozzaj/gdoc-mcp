import { describe, it, expect, beforeEach, vi } from 'vitest'
import { runBatch } from './batch.js'

vi.mock('./client.js', () => ({
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
  moveEvent: vi.fn(),
}))

import { createEvent, updateEvent, deleteEvent, moveEvent } from './client.js'

const event = (id: string, summary: string) => ({
  id,
  summary,
  start: '2026-10-09',
  end: '2026-10-10',
  allDay: true,
})

describe('runBatch', () => {
  beforeEach(() => {
    vi.mocked(createEvent).mockReset()
    vi.mocked(updateEvent).mockReset()
    vi.mocked(deleteEvent).mockReset()
    vi.mocked(moveEvent).mockReset()
  })

  it('runs operations sequentially in order with the right arguments', async () => {
    const order: string[] = []
    vi.mocked(createEvent).mockImplementation(async () => {
      order.push('create')
      return event('new1', 'Conferences')
    })
    vi.mocked(updateEvent).mockImplementation(async () => {
      order.push('update')
      return event('e2', 'Swim')
    })
    vi.mocked(deleteEvent).mockImplementation(async () => {
      order.push('delete')
      return 'Deleted event e3'
    })
    vi.mocked(moveEvent).mockImplementation(async () => {
      order.push('move')
      return event('e4', 'Break')
    })

    const result = await runBatch([
      {
        op: 'create',
        calendarId: 'Family',
        summary: 'Conferences',
        start: '2026-10-09',
        end: '2026-10-10',
      },
      { op: 'update', calendarId: 'Family', eventId: 'e2', summary: 'Swim', scope: 'all' },
      { op: 'delete', eventId: 'e3', scope: 'following' },
      { op: 'move', calendarId: 'Family', eventId: 'e4', destinationCalendarId: 'Childcare' },
    ])

    expect(order).toEqual(['create', 'update', 'delete', 'move'])
    expect(createEvent).toHaveBeenCalledWith('Family', {
      summary: 'Conferences',
      start: '2026-10-09',
      end: '2026-10-10',
    })
    expect(updateEvent).toHaveBeenCalledWith(
      'Family',
      'e2',
      { summary: 'Swim' },
      {
        scope: 'all',
        recurrenceUntil: undefined,
      },
    )
    expect(deleteEvent).toHaveBeenCalledWith('primary', 'e3', 'following')
    expect(moveEvent).toHaveBeenCalledWith('Family', 'e4', 'Childcare')
    expect(result.succeeded).toBe(4)
    expect(result.failed).toBe(0)
    expect(result.text).toContain('1. OK create: Created event "Conferences"')
    expect(result.text).toContain('3. OK delete: Deleted event e3')
  })

  it('continues after a failure and reports it', async () => {
    vi.mocked(deleteEvent).mockRejectedValueOnce(new Error('Not Found'))
    vi.mocked(deleteEvent).mockResolvedValueOnce('Deleted event e2')

    const result = await runBatch([
      { op: 'delete', eventId: 'e1' },
      { op: 'delete', eventId: 'e2' },
    ])

    expect(deleteEvent).toHaveBeenCalledTimes(2)
    expect(result.succeeded).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.text).toBe(
      'Batch: 1 succeeded, 1 failed\n' +
        '1. FAILED delete e1: Not Found\n' +
        '2. OK delete: Deleted event e2',
    )
  })
})

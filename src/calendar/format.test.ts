import { describe, it, expect } from 'vitest'
import {
  formatEventWhen,
  formatEventListItem,
  formatEventDetail,
  formatEventResult,
  lastDayInclusive,
} from './format.js'
import type { EventInfo } from './client.js'

function ev(overrides: Partial<EventInfo> = {}): EventInfo {
  return {
    id: 'e1',
    summary: 'Test',
    start: '2026-10-09T10:00:00-04:00',
    end: '2026-10-09T11:00:00-04:00',
    allDay: false,
    ...overrides,
  }
}

describe('lastDayInclusive', () => {
  it('subtracts one day from the exclusive end date', () => {
    expect(lastDayInclusive('2026-10-10')).toBe('2026-10-09')
  })

  it('crosses month and year boundaries', () => {
    expect(lastDayInclusive('2026-11-01')).toBe('2026-10-31')
    expect(lastDayInclusive('2027-01-01')).toBe('2026-12-31')
  })
})

describe('formatEventWhen', () => {
  it('shows a single all-day date', () => {
    expect(formatEventWhen(ev({ allDay: true, start: '2026-10-09', end: '2026-10-10' }))).toBe(
      'All day: 2026-10-09',
    )
  })

  it('shows multi-day all-day range with inclusive last day', () => {
    expect(formatEventWhen(ev({ allDay: true, start: '2026-10-08', end: '2026-10-17' }))).toBe(
      'All day: 2026-10-08 → 2026-10-16',
    )
  })

  it('shows start → end for timed events', () => {
    expect(formatEventWhen(ev())).toBe('2026-10-09T10:00:00-04:00 → 2026-10-09T11:00:00-04:00')
  })
})

describe('formatEventListItem', () => {
  it('includes title, date, and ID', () => {
    const text = formatEventListItem(ev({ allDay: true, start: '2026-10-09', end: '2026-10-10' }))
    expect(text).toBe('- **Test**\n  All day: 2026-10-09\n  ID: e1')
  })

  it('includes recurrence and instance info when present', () => {
    const text = formatEventListItem(
      ev({ recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=WE'], recurringEventId: 'master1' }),
    )
    expect(text).toContain('Recurring: RRULE:FREQ=WEEKLY;BYDAY=WE')
    expect(text).toContain('Instance of: master1')
  })

  it('includes location and meet link', () => {
    const text = formatEventListItem(ev({ location: 'Gym', meetLink: 'https://meet' }))
    expect(text).toContain('Location: Gym')
    expect(text).toContain('Meet: https://meet')
  })
})

describe('formatEventDetail', () => {
  it('shows all-day multi-day range', () => {
    const text = formatEventDetail(ev({ allDay: true, start: '2026-10-08', end: '2026-10-17' }))
    expect(text).toContain('All day: 2026-10-08 → 2026-10-16')
  })

  it('shows start and end separately for timed events', () => {
    const text = formatEventDetail(ev())
    expect(text).toContain('Start: 2026-10-09T10:00:00-04:00\nEnd: 2026-10-09T11:00:00-04:00')
  })

  it('shows recurrence and instance info', () => {
    const text = formatEventDetail(
      ev({ recurrence: ['RRULE:FREQ=DAILY', 'EXDATE:20261010'], recurringEventId: 'm1' }),
    )
    expect(text).toContain('Recurring: RRULE:FREQ=DAILY; EXDATE:20261010')
    expect(text).toContain('Instance of: m1')
  })
})

describe('formatEventResult', () => {
  it('summarizes an all-day event with the date', () => {
    const text = formatEventResult(
      'Created',
      ev({ allDay: true, start: '2026-10-09', end: '2026-10-10', htmlLink: 'https://l' }),
    )
    expect(text).toBe('Created event "Test"\nAll day: 2026-10-09\nID: e1\nLink: https://l')
  })
})

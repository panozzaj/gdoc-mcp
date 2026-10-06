import { describe, it, expect } from 'vitest'
import {
  normalizeTitle,
  titlesSimilar,
  findDuplicateGroups,
  formatDuplicates,
} from './duplicates.js'
import type { EventInfo } from './client.js'

function ev(overrides: Partial<EventInfo>): EventInfo {
  return {
    id: 'x',
    summary: 'x',
    start: '2026-10-09',
    end: '2026-10-10',
    allDay: true,
    ...overrides,
  }
}

describe('normalizeTitle', () => {
  it('lowercases, strips punctuation, dates, and filler words', () => {
    expect(normalizeTitle('Fall Break (10/8 - 10/16)!')).toEqual(['fall', 'break'])
    expect(normalizeTitle('Parent-Teacher Conference on 2026-10-09')).toEqual([
      'parent',
      'teacher',
      'conference',
    ])
  })
})

describe('titlesSimilar', () => {
  it('matches titles that differ by dates and punctuation', () => {
    expect(titlesSimilar('Fall break', 'Fall Break 10/8')).toBe(true)
  })

  it('matches when one title is mostly contained in the other', () => {
    expect(titlesSimilar('Conferences', 'Conferences - Lily')).toBe(true)
  })

  it('does not match unrelated titles', () => {
    expect(titlesSimilar('Swim practice', 'Dentist')).toBe(false)
  })

  it('does not match titles that normalize to nothing', () => {
    expect(titlesSimilar('10/10', '10/10')).toBe(false)
  })
})

describe('findDuplicateGroups', () => {
  it('groups similar overlapping events across calendars', () => {
    const events = [
      ev({
        id: 'a',
        summary: 'Fall break',
        calendarId: 'fam',
        start: '2026-10-08',
        end: '2026-10-17',
      }),
      ev({
        id: 'b',
        summary: 'Fall Break 10/10',
        calendarId: 'kids',
        start: '2026-10-10',
        end: '2026-10-11',
      }),
      ev({
        id: 'c',
        summary: 'Dentist',
        calendarId: 'kids',
        start: '2026-10-10',
        end: '2026-10-11',
      }),
    ]
    const groups = findDuplicateGroups(events)
    expect(groups).toHaveLength(1)
    expect(groups[0].map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('ignores similar events on the same calendar', () => {
    const events = [
      ev({ id: 'a', summary: 'Swim', calendarId: 'fam' }),
      ev({ id: 'b', summary: 'Swim', calendarId: 'fam' }),
    ]
    expect(findDuplicateGroups(events)).toHaveLength(0)
  })

  it('ignores similar events that do not overlap in time', () => {
    const events = [
      ev({ id: 'a', summary: 'Swim', calendarId: 'fam', start: '2026-10-09', end: '2026-10-10' }),
      ev({ id: 'b', summary: 'Swim', calendarId: 'kids', start: '2026-10-10', end: '2026-10-11' }),
    ]
    expect(findDuplicateGroups(events)).toHaveLength(0)
  })

  it('compares timed and all-day events on the same day', () => {
    const events = [
      ev({
        id: 'a',
        summary: 'Conferences',
        calendarId: 'fam',
        start: '2026-10-09',
        end: '2026-10-10',
      }),
      ev({
        id: 'b',
        summary: 'Conferences',
        calendarId: 'kids',
        allDay: false,
        start: '2026-10-09T15:00:00-04:00',
        end: '2026-10-09T15:30:00-04:00',
      }),
    ]
    expect(findDuplicateGroups(events)).toHaveLength(1)
  })
})

describe('formatDuplicates', () => {
  it('renders a Possible duplicates section', () => {
    const text = formatDuplicates([
      [
        ev({ id: 'a', summary: 'Fall break', calendarName: 'Family' }),
        ev({ id: 'b', summary: 'Fall Break', calendarName: 'Childcare' }),
      ],
    ])
    expect(text).toBe(
      'Possible duplicates:\n' +
        '1. "Fall break" (Family, All day: 2026-10-09, ID: a)\n' +
        '   "Fall Break" (Childcare, All day: 2026-10-09, ID: b)',
    )
  })

  it('says so when there are none', () => {
    expect(formatDuplicates([])).toBe('Possible duplicates: none found')
  })
})

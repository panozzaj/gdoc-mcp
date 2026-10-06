import { describe, it, expect } from 'vitest'
import {
  setRecurrenceUntil,
  stripRecurrenceCount,
  untilBeforeInstance,
  untilOnDate,
} from './recurrence.js'

describe('setRecurrenceUntil', () => {
  it('adds UNTIL to an open-ended RRULE', () => {
    expect(setRecurrenceUntil(['RRULE:FREQ=WEEKLY;BYDAY=WE'], '20261031')).toEqual([
      'RRULE:FREQ=WEEKLY;BYDAY=WE;UNTIL=20261031',
    ])
  })

  it('replaces an existing UNTIL', () => {
    expect(
      setRecurrenceUntil(['RRULE:FREQ=DAILY;UNTIL=20271231T000000Z;INTERVAL=2'], '20261031'),
    ).toEqual(['RRULE:FREQ=DAILY;INTERVAL=2;UNTIL=20261031'])
  })

  it('replaces COUNT (UNTIL and COUNT are mutually exclusive)', () => {
    expect(setRecurrenceUntil(['RRULE:FREQ=DAILY;COUNT=10'], '20261031T035959Z')).toEqual([
      'RRULE:FREQ=DAILY;UNTIL=20261031T035959Z',
    ])
  })

  it('leaves EXDATE/RDATE lines alone', () => {
    expect(setRecurrenceUntil(['RRULE:FREQ=DAILY', 'EXDATE:20261010'], '20261031')).toEqual([
      'RRULE:FREQ=DAILY;UNTIL=20261031',
      'EXDATE:20261010',
    ])
  })
})

describe('stripRecurrenceCount', () => {
  it('removes COUNT but keeps other parts', () => {
    expect(stripRecurrenceCount(['RRULE:FREQ=DAILY;COUNT=5;BYDAY=MO', 'EXDATE:1'])).toEqual([
      'RRULE:FREQ=DAILY;BYDAY=MO',
      'EXDATE:1',
    ])
  })
})

describe('untilBeforeInstance', () => {
  it('uses the previous day in date form for all-day series', () => {
    expect(untilBeforeInstance({ date: '2026-11-01' })).toBe('20261031')
  })

  it('uses one second before the instance, in UTC, for timed series', () => {
    expect(untilBeforeInstance({ dateTime: '2026-10-14T18:00:00-04:00' })).toBe('20261014T215959Z')
  })
})

describe('untilOnDate', () => {
  it('uses date form for all-day series', () => {
    expect(untilOnDate('2026-12-18', { date: '2026-09-01' })).toBe('20261218')
  })

  it('uses end of that day in the series time zone (as UTC) for timed series', () => {
    // EST (-05:00) in December: 23:59:59 local = 04:59:59Z next day
    expect(
      untilOnDate('2026-12-18', {
        dateTime: '2026-09-01T18:00:00-04:00',
        timeZone: 'America/Indiana/Indianapolis',
      }),
    ).toBe('20261219T045959Z')
  })

  it('falls back to the start offset when there is no time zone', () => {
    expect(untilOnDate('2026-12-18', { dateTime: '2026-09-01T18:00:00-04:00' })).toBe(
      '20261219T035959Z',
    )
  })
})

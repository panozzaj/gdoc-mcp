// Helpers for manipulating RFC 5545 recurrence rules as used by Google Calendar.
// Per RFC 5545, UNTIL must be a DATE (YYYYMMDD) for all-day series and a UTC date-time
// (YYYYMMDDTHHMMSSZ) for timed series.

interface StartLike {
  date?: string | null
  dateTime?: string | null
  timeZone?: string | null
}

function mapRrules(recurrence: string[], fn: (parts: string[]) => string[]): string[] {
  return recurrence.map((line) => {
    if (!line.startsWith('RRULE:')) return line
    const parts = line.substring('RRULE:'.length).split(';').filter(Boolean)
    return `RRULE:${fn(parts).join(';')}`
  })
}

const isPart = (name: string) => (p: string) => p.toUpperCase().startsWith(`${name}=`)

export function setRecurrenceUntil(recurrence: string[], until: string): string[] {
  return mapRrules(recurrence, (parts) => [
    ...parts.filter((p) => !isPart('UNTIL')(p) && !isPart('COUNT')(p)),
    `UNTIL=${until}`,
  ])
}

export function stripRecurrenceCount(recurrence: string[]): string[] {
  return mapRrules(recurrence, (parts) => parts.filter((p) => !isPart('COUNT')(p)))
}

function compactDate(date: string): string {
  return date.replace(/-/g, '')
}

function toUtcCompact(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().substring(0, 10)
}

// UNTIL value that ends a series just before the given instance start
export function untilBeforeInstance(instanceStart: StartLike): string {
  if (instanceStart.date) return compactDate(addDays(instanceStart.date, -1))
  if (!instanceStart.dateTime) throw new Error('Instance has no start time')
  return toUtcCompact(new Date(new Date(instanceStart.dateTime).getTime() - 1000))
}

// Offset (minutes east of UTC) of a time zone at a given instant
function zoneOffsetMinutes(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at)
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'))
  return Math.round((asUtc - Math.floor(at.getTime() / 60000) * 60000) / 60000)
}

function offsetFromDateTime(dateTime: string): number {
  const m = dateTime.match(/([+-])(\d{2}):?(\d{2})$/)
  if (!m) return 0
  const minutes = Number(m[2]) * 60 + Number(m[3])
  return m[1] === '-' ? -minutes : minutes
}

// UNTIL value that makes the given date (YYYY-MM-DD) the last day of the series (inclusive)
export function untilOnDate(date: string, seriesStart: StartLike): string {
  if (seriesStart.date) return compactDate(date)
  const naiveUtc = new Date(`${date}T23:59:59Z`)
  const offset = seriesStart.timeZone
    ? zoneOffsetMinutes(seriesStart.timeZone, naiveUtc)
    : offsetFromDateTime(seriesStart.dateTime || '')
  return toUtcCompact(new Date(naiveUtc.getTime() - offset * 60000))
}

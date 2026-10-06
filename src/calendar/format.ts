import type { EventInfo } from './client.js'

// Google all-day end dates are exclusive; return the last day the event actually covers.
export function lastDayInclusive(exclusiveEnd: string): string {
  const d = new Date(`${exclusiveEnd}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().substring(0, 10)
}

export function formatEventWhen(e: EventInfo): string {
  if (e.allDay) {
    const last = /^\d{4}-\d{2}-\d{2}$/.test(e.end) ? lastDayInclusive(e.end) : e.start
    return last > e.start ? `All day: ${e.start} → ${last}` : `All day: ${e.start}`
  }
  return `${e.start} → ${e.end}`
}

function recurrenceLines(e: EventInfo): string[] {
  const lines: string[] = []
  if (e.recurrence?.length) lines.push(`Recurring: ${e.recurrence.join('; ')}`)
  if (e.recurringEventId) lines.push(`Instance of: ${e.recurringEventId}`)
  return lines
}

export function formatEventListItem(e: EventInfo): string {
  const lines = [`- **${e.summary}**`, formatEventWhen(e)]
  if (e.calendarName) lines.push(`Calendar: ${e.calendarName}`)
  if (e.location) lines.push(`Location: ${e.location}`)
  if (e.meetLink) lines.push(`Meet: ${e.meetLink}`)
  lines.push(...recurrenceLines(e))
  lines.push(`ID: ${e.id}`)
  return lines.join('\n  ')
}

export function formatEventDetail(e: EventInfo): string {
  const parts = [
    `**${e.summary}**`,
    e.allDay ? formatEventWhen(e) : `Start: ${e.start}\nEnd: ${e.end}`,
  ]
  if (e.calendarName) parts.push(`Calendar: ${e.calendarName}`)
  if (e.location) parts.push(`Location: ${e.location}`)
  if (e.description) parts.push(`Description: ${e.description}`)
  if (e.attendees?.length) parts.push(`Attendees: ${e.attendees.join(', ')}`)
  if (e.meetLink) parts.push(`Meet: ${e.meetLink}`)
  parts.push(...recurrenceLines(e))
  if (e.htmlLink) parts.push(`Link: ${e.htmlLink}`)
  parts.push(`Status: ${e.status || 'confirmed'}`)
  parts.push(`ID: ${e.id}`)
  return parts.join('\n')
}

// Short summary used after create/update/move operations.
export function formatEventResult(verb: string, e: EventInfo): string {
  const lines = [`${verb} event "${e.summary}"`, formatEventWhen(e)]
  if (e.calendarName) lines.push(`Calendar: ${e.calendarName}`)
  lines.push(...recurrenceLines(e))
  lines.push(`ID: ${e.id}`)
  if (e.htmlLink) lines.push(`Link: ${e.htmlLink}`)
  return lines.join('\n')
}

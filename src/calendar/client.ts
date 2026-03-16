import { getCalendarClient } from '../auth.js'
import { calendar_v3 } from 'googleapis'

// Detect system timezone, fallback to UTC
function getDefaultTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return 'UTC'
  }
}

export interface CalendarInfo {
  id: string
  summary: string
  primary: boolean
}

export interface EventInfo {
  id: string
  summary: string
  start: string
  end: string
  location?: string
  description?: string
  attendees?: string[]
  meetLink?: string
  htmlLink?: string
  status?: string
  allDay: boolean
}

export interface EventInput {
  summary: string
  start: string
  end: string
  description?: string
  location?: string
  attendees?: string[]
  timeZone?: string
}

function isAllDayDate(dateStr: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr)
}

function formatEventTime(eventTime: calendar_v3.Schema$EventDateTime | undefined): {
  display: string
  allDay: boolean
} {
  if (!eventTime) return { display: '(unknown)', allDay: false }
  if (eventTime.date) return { display: eventTime.date, allDay: true }
  if (eventTime.dateTime) return { display: eventTime.dateTime, allDay: false }
  return { display: '(unknown)', allDay: false }
}

function parseEvent(event: calendar_v3.Schema$Event): EventInfo {
  const start = formatEventTime(event.start)
  const end = formatEventTime(event.end)

  return {
    id: event.id || '',
    summary: event.summary || '(no title)',
    start: start.display,
    end: end.display,
    location: event.location || undefined,
    description: event.description || undefined,
    attendees: event.attendees?.map((a) => a.email || '').filter(Boolean),
    meetLink: event.hangoutLink || event.conferenceData?.entryPoints?.[0]?.uri || undefined,
    htmlLink: event.htmlLink || undefined,
    status: event.status || undefined,
    allDay: start.allDay,
  }
}

export async function listCalendars(): Promise<CalendarInfo[]> {
  const calendar = await getCalendarClient()
  const response = await calendar.calendarList.list()
  const items = response.data.items || []

  return items.map((cal) => ({
    id: cal.id || '',
    summary: cal.summary || '(unnamed)',
    primary: cal.primary || false,
  }))
}

// Check if an all-day event's date range overlaps with the query date range.
// All-day events use date-only strings (YYYY-MM-DD) with exclusive end dates.
// Google's API can return all-day events outside the intended range when timezone
// offsets shift the UTC boundaries (e.g., querying Sunday EST returns Monday's event).
function isAllDayEventInRange(event: EventInfo, timeMin?: string, timeMax?: string): boolean {
  if (timeMax) {
    const maxDate = timeMax.substring(0, 10)
    if (event.start >= maxDate) return false
  }
  if (timeMin) {
    const minDate = timeMin.substring(0, 10)
    if (event.end <= minDate) return false
  }
  return true
}

export async function listEvents(
  calendarId: string = 'primary',
  timeMin?: string,
  timeMax?: string,
  maxResults: number = 10,
  query?: string,
): Promise<EventInfo[]> {
  const calendar = await getCalendarClient()

  const params: calendar_v3.Params$Resource$Events$List = {
    calendarId,
    maxResults,
    singleEvents: true,
    orderBy: 'startTime',
    timeMin: timeMin || new Date().toISOString(),
  }

  if (timeMax) params.timeMax = timeMax
  if (query) params.q = query

  const response = await calendar.events.list(params)
  const events = response.data.items || []

  return events.map(parseEvent).filter((event) => {
    if (!event.allDay) return true
    return isAllDayEventInRange(event, timeMin, timeMax)
  })
}

export async function getEvent(
  calendarId: string = 'primary',
  eventId: string,
): Promise<EventInfo> {
  const calendar = await getCalendarClient()

  const response = await calendar.events.get({
    calendarId,
    eventId,
  })

  return parseEvent(response.data)
}

export async function createEvent(
  calendarId: string = 'primary',
  event: EventInput,
): Promise<EventInfo> {
  const calendar = await getCalendarClient()
  const timeZone = event.timeZone || getDefaultTimeZone()

  const startAllDay = isAllDayDate(event.start)
  const endAllDay = isAllDayDate(event.end)

  const requestBody: calendar_v3.Schema$Event = {
    summary: event.summary,
    start: startAllDay ? { date: event.start } : { dateTime: event.start, timeZone },
    end: endAllDay ? { date: event.end } : { dateTime: event.end, timeZone },
  }

  if (event.description) requestBody.description = event.description
  if (event.location) requestBody.location = event.location
  if (event.attendees) {
    requestBody.attendees = event.attendees.map((email) => ({ email }))
  }

  const response = await calendar.events.insert({
    calendarId,
    requestBody,
  })

  return parseEvent(response.data)
}

export async function updateEvent(
  calendarId: string = 'primary',
  eventId: string,
  updates: Partial<EventInput>,
): Promise<EventInfo> {
  const calendar = await getCalendarClient()
  const timeZone = updates.timeZone || getDefaultTimeZone()

  // Fetch the existing event first
  const existing = await calendar.events.get({ calendarId, eventId })
  const requestBody: calendar_v3.Schema$Event = { ...existing.data }

  if (updates.summary !== undefined) requestBody.summary = updates.summary
  if (updates.description !== undefined) requestBody.description = updates.description
  if (updates.location !== undefined) requestBody.location = updates.location

  if (updates.start !== undefined) {
    const startAllDay = isAllDayDate(updates.start)
    requestBody.start = startAllDay
      ? { date: updates.start }
      : { dateTime: updates.start, timeZone }
  }

  if (updates.end !== undefined) {
    const endAllDay = isAllDayDate(updates.end)
    requestBody.end = endAllDay ? { date: updates.end } : { dateTime: updates.end, timeZone }
  }

  if (updates.attendees !== undefined) {
    requestBody.attendees = updates.attendees.map((email) => ({ email }))
  }

  const response = await calendar.events.update({
    calendarId,
    eventId,
    requestBody,
  })

  return parseEvent(response.data)
}

export async function deleteEvent(calendarId: string = 'primary', eventId: string): Promise<void> {
  const calendar = await getCalendarClient()
  await calendar.events.delete({ calendarId, eventId })
}

export async function quickAdd(calendarId: string = 'primary', text: string): Promise<EventInfo> {
  const calendar = await getCalendarClient()

  const response = await calendar.events.quickAdd({
    calendarId,
    text,
  })

  return parseEvent(response.data)
}

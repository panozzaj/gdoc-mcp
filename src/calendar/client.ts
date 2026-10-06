import { getCalendarClient } from '../auth.js'
import { calendar_v3 } from 'googleapis'
import {
  setRecurrenceUntil,
  stripRecurrenceCount,
  untilBeforeInstance,
  untilOnDate,
} from './recurrence.js'
import { eventTimeRange } from './format.js'

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
  recurrence?: string[]
  recurringEventId?: string
  calendarId?: string
  calendarName?: string
  // Explanation of non-obvious side effects (e.g. series split)
  note?: string
}

export interface EventInput {
  summary: string
  start: string
  end: string
  description?: string
  location?: string
  attendees?: string[]
  timeZone?: string
  recurrence?: string[]
}

function isAllDayDate(dateStr: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr)
}

// Build an EventDateTime, explicitly nulling the field of the other kind so that switching
// between all-day and timed on update is accepted by the Google API.
function toEventDateTime(value: string, timeZone: string): calendar_v3.Schema$EventDateTime {
  return isAllDayDate(value)
    ? { date: value, dateTime: null, timeZone: null }
    : { dateTime: value, timeZone, date: null }
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
    recurrence: event.recurrence?.length ? event.recurrence : undefined,
    recurringEventId: event.recurringEventId || undefined,
  }
}

// Calendar list cache (per process) used to resolve display names to IDs and IDs to names
let calendarCache: Promise<CalendarInfo[]> | null = null

export function clearCalendarCache(): void {
  calendarCache = null
}

function getCachedCalendars(): Promise<CalendarInfo[]> {
  if (!calendarCache) {
    calendarCache = listCalendars().catch((err) => {
      calendarCache = null
      throw err
    })
  }
  return calendarCache
}

function looksLikeCalendarId(value: string): boolean {
  return value === 'primary' || value.includes('@')
}

// Accept either a calendar ID or a display name (case-insensitive, e.g. "Family")
export async function resolveCalendarId(nameOrId: string = 'primary'): Promise<string> {
  const value = nameOrId.trim()
  if (looksLikeCalendarId(value)) return value
  const calendars = await getCachedCalendars()
  const lower = value.toLowerCase()
  const match =
    calendars.find((c) => c.id === value) ||
    calendars.find((c) => c.summary.toLowerCase() === lower)
  if (match) return match.id
  // Nothing to check against; let the API decide whether it's a valid ID
  if (calendars.length === 0) return value
  const names = calendars.map((c) => c.summary).join(', ')
  throw new Error(`Unknown calendar "${value}". Available calendars: ${names}`)
}

export async function getCalendarName(calendarId: string): Promise<string | undefined> {
  try {
    const calendars = await getCachedCalendars()
    const match =
      calendarId === 'primary'
        ? calendars.find((c) => c.primary)
        : calendars.find((c) => c.id === calendarId)
    return match?.summary
  } catch {
    return undefined
  }
}

async function tagEvents(events: EventInfo[], calendarId: string): Promise<EventInfo[]> {
  const calendarName = await getCalendarName(calendarId)
  return events.map((e) => ({ ...e, calendarId, calendarName }))
}

async function tagEvent(event: EventInfo, calendarId: string): Promise<EventInfo> {
  return (await tagEvents([event], calendarId))[0]
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
  calendarIdOrName: string = 'primary',
  timeMin?: string,
  timeMax?: string,
  maxResults: number = 10,
  query?: string,
): Promise<EventInfo[]> {
  const calendarId = await resolveCalendarId(calendarIdOrName)
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

  const parsed = events.map(parseEvent).filter((event) => {
    if (!event.allDay) return true
    return isAllDayEventInRange(event, timeMin, timeMax)
  })
  return tagEvents(parsed, calendarId)
}

export async function getEvent(
  calendarIdOrName: string = 'primary',
  eventId: string,
): Promise<EventInfo> {
  const calendarId = await resolveCalendarId(calendarIdOrName)
  const calendar = await getCalendarClient()

  const response = await calendar.events.get({
    calendarId,
    eventId,
  })

  return tagEvent(parseEvent(response.data), calendarId)
}

export async function createEvent(
  calendarIdOrName: string = 'primary',
  event: EventInput,
): Promise<EventInfo> {
  const calendarId = await resolveCalendarId(calendarIdOrName)
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
  if (event.recurrence?.length) requestBody.recurrence = event.recurrence

  const response = await calendar.events.insert({
    calendarId,
    requestBody,
  })

  return tagEvent(parseEvent(response.data), calendarId)
}

export type RecurrenceScope = 'instance' | 'following' | 'all'

export interface UpdateOptions {
  // Which occurrences of a recurring event to change (default 'instance': just the passed ID)
  scope?: RecurrenceScope
  // End the series on this date (YYYY-MM-DD, inclusive). Applies to the series master.
  recurrenceUntil?: string
}

function applyUpdates(
  requestBody: calendar_v3.Schema$Event,
  updates: Partial<EventInput>,
): calendar_v3.Schema$Event {
  const timeZone = updates.timeZone || getDefaultTimeZone()

  if (updates.summary !== undefined) requestBody.summary = updates.summary
  if (updates.description !== undefined) requestBody.description = updates.description
  if (updates.location !== undefined) requestBody.location = updates.location

  if (updates.start !== undefined) requestBody.start = toEventDateTime(updates.start, timeZone)
  if (updates.end !== undefined) requestBody.end = toEventDateTime(updates.end, timeZone)

  // Google rejects events whose start and end are of different kinds (date vs dateTime)
  if (Boolean(requestBody.start?.date) !== Boolean(requestBody.end?.date)) {
    throw new Error(
      'Cannot mix all-day and timed start/end. When switching between all-day (YYYY-MM-DD) ' +
        'and timed (ISO datetime), provide both start and end.',
    )
  }

  if (updates.attendees !== undefined) {
    requestBody.attendees = updates.attendees.map((email) => ({ email }))
  }
  if (updates.recurrence !== undefined) requestBody.recurrence = updates.recurrence

  return requestBody
}

function sameStart(
  a: calendar_v3.Schema$EventDateTime | undefined,
  b: calendar_v3.Schema$EventDateTime | undefined,
): boolean {
  if (a?.date || b?.date) return a?.date === b?.date
  if (!a?.dateTime || !b?.dateTime) return false
  return new Date(a.dateTime).getTime() === new Date(b.dateTime).getTime()
}

// Fields that identify or are generated for an existing event and must not be copied
// into a brand-new event
const GENERATED_EVENT_FIELDS: (keyof calendar_v3.Schema$Event)[] = [
  'id',
  'iCalUID',
  'etag',
  'htmlLink',
  'created',
  'updated',
  'sequence',
  'recurringEventId',
  'originalStartTime',
  'hangoutLink',
  'conferenceData',
  'creator',
  'organizer',
]

async function capSeries(
  calendar: calendar_v3.Calendar,
  calendarId: string,
  master: calendar_v3.Schema$Event,
  instanceStart: calendar_v3.Schema$EventDateTime,
): Promise<string> {
  const until = untilBeforeInstance(instanceStart)
  await calendar.events.update({
    calendarId,
    eventId: master.id || '',
    requestBody: { ...master, recurrence: setRecurrenceUntil(master.recurrence || [], until) },
  })
  return until
}

export async function updateEvent(
  calendarIdOrName: string = 'primary',
  eventId: string,
  updates: Partial<EventInput>,
  options: UpdateOptions = {},
): Promise<EventInfo> {
  const calendarId = await resolveCalendarId(calendarIdOrName)
  const calendar = await getCalendarClient()
  const scope = options.scope || 'instance'

  const existing = (await calendar.events.get({ calendarId, eventId })).data
  const masterId = existing.recurringEventId
  const getMaster = async () =>
    masterId ? (await calendar.events.get({ calendarId, eventId: masterId })).data : existing

  if (options.recurrenceUntil !== undefined) {
    const master = await getMaster()
    if (!master.recurrence?.length) {
      throw new Error(`Event ${eventId} is not a recurring event; recurrenceUntil needs a series`)
    }
    const until = untilOnDate(options.recurrenceUntil, master.start || {})
    const requestBody = applyUpdates({ ...master }, updates)
    requestBody.recurrence = setRecurrenceUntil(requestBody.recurrence || [], until)
    const response = await calendar.events.update({
      calendarId,
      eventId: master.id || '',
      requestBody,
    })
    return tagEvent(
      {
        ...parseEvent(response.data),
        note: `Series ${master.id} now ends on ${options.recurrenceUntil} (UNTIL=${until}).`,
      },
      calendarId,
    )
  }

  if (scope === 'instance' || !masterId) {
    // Non-recurring events, series masters with 'all'/'following', and single instances
    const response = await calendar.events.update({
      calendarId,
      eventId,
      requestBody: applyUpdates({ ...existing }, updates),
    })
    return tagEvent(parseEvent(response.data), calendarId)
  }

  const master = await getMaster()
  const instanceStart = existing.originalStartTime || existing.start || {}

  if (scope === 'all' || sameStart(instanceStart, master.start)) {
    const response = await calendar.events.update({
      calendarId,
      eventId: masterId,
      requestBody: applyUpdates({ ...master }, updates),
    })
    return tagEvent(
      { ...parseEvent(response.data), note: `Updated all events in series ${masterId}.` },
      calendarId,
    )
  }

  // scope 'following': end the original series just before this instance, then start a new
  // series at this instance carrying the updated fields
  const until = await capSeries(calendar, calendarId, master, instanceStart)
  const newSeries: calendar_v3.Schema$Event = { ...master }
  for (const field of GENERATED_EVENT_FIELDS) delete newSeries[field]
  newSeries.start = existing.start
  newSeries.end = existing.end
  newSeries.recurrence = stripRecurrenceCount(master.recurrence || [])
  const response = await calendar.events.insert({
    calendarId,
    requestBody: applyUpdates(newSeries, updates),
  })
  const created = parseEvent(response.data)
  return tagEvent(
    {
      ...created,
      note:
        `Split series: original ${masterId} now ends before this instance (UNTIL=${until}); ` +
        `new series ${created.id} starts here with the changes.`,
    },
    calendarId,
  )
}

// Returns a human-readable description of what was deleted
export async function deleteEvent(
  calendarIdOrName: string = 'primary',
  eventId: string,
  scope: RecurrenceScope = 'instance',
): Promise<string> {
  const calendarId = await resolveCalendarId(calendarIdOrName)
  const calendar = await getCalendarClient()

  if (scope === 'instance') {
    await calendar.events.delete({ calendarId, eventId })
    return `Deleted event ${eventId}`
  }

  const existing = (await calendar.events.get({ calendarId, eventId })).data
  const masterId = existing.recurringEventId
  if (!masterId) {
    await calendar.events.delete({ calendarId, eventId })
    return existing.recurrence?.length
      ? `Deleted recurring series ${eventId}`
      : `Deleted event ${eventId}`
  }

  const master = (await calendar.events.get({ calendarId, eventId: masterId })).data
  const instanceStart = existing.originalStartTime || existing.start || {}

  if (scope === 'all' || sameStart(instanceStart, master.start)) {
    await calendar.events.delete({ calendarId, eventId: masterId })
    return `Deleted recurring series ${masterId} (all events)`
  }

  const until = await capSeries(calendar, calendarId, master, instanceStart)
  return `Series ${masterId} now ends before ${eventId} (UNTIL=${until}); this and following events removed`
}

export async function quickAdd(
  calendarIdOrName: string = 'primary',
  text: string,
): Promise<EventInfo> {
  const calendarId = await resolveCalendarId(calendarIdOrName)
  const calendar = await getCalendarClient()

  const response = await calendar.events.quickAdd({
    calendarId,
    text,
  })

  return tagEvent(parseEvent(response.data), calendarId)
}

// Move an event (or a whole recurring series, via its master ID) to another calendar.
// Google only allows moving series masters, not individual instances.
export async function moveEvent(
  calendarIdOrName: string = 'primary',
  eventId: string,
  destinationCalendarIdOrName: string,
): Promise<EventInfo> {
  const calendarId = await resolveCalendarId(calendarIdOrName)
  const destination = await resolveCalendarId(destinationCalendarIdOrName)
  const calendar = await getCalendarClient()

  const existing = await calendar.events.get({ calendarId, eventId })
  const masterId = existing.data.recurringEventId
  if (masterId) {
    throw new Error(
      `Event ${eventId} is an instance of recurring series "${masterId}". ` +
        `Google cannot move a single instance. To move the whole series, call move with ` +
        `eventId "${masterId}". To move just this occurrence, delete it here (scope 'instance') ` +
        `and create a copy on the destination calendar.`,
    )
  }

  const response = await calendar.events.move({ calendarId, eventId, destination })
  return tagEvent(parseEvent(response.data), destination)
}

// List events from several calendars (IDs or names), merged and sorted by start time.
// maxResults applies per calendar.
export async function listEventsAcross(
  calendarIdsOrNames: string[],
  timeMin?: string,
  timeMax?: string,
  maxResults: number = 10,
  query?: string,
): Promise<EventInfo[]> {
  const results = await Promise.all(
    calendarIdsOrNames.map((c) => listEvents(c, timeMin, timeMax, maxResults, query)),
  )
  return results
    .flat()
    .map((e, i) => ({ e, i, start: eventTimeRange(e).start }))
    .sort((a, b) => a.start - b.start || a.i - b.i)
    .map(({ e }) => e)
}

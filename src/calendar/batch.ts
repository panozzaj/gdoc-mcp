import { createEvent, updateEvent, deleteEvent, moveEvent } from './client.js'
import type { EventInput, RecurrenceScope } from './client.js'
import { formatEventWhen } from './format.js'

interface EventFields {
  description?: string
  location?: string
  attendees?: string[]
  timeZone?: string
  recurrence?: string[]
}

export type BatchOperation =
  | ({
      op: 'create'
      calendarId?: string
      summary: string
      start: string
      end: string
    } & EventFields)
  | ({
      op: 'update'
      calendarId?: string
      eventId: string
      summary?: string
      start?: string
      end?: string
      scope?: RecurrenceScope
      recurrenceUntil?: string
    } & EventFields)
  | { op: 'delete'; calendarId?: string; eventId: string; scope?: RecurrenceScope }
  | { op: 'move'; calendarId?: string; eventId: string; destinationCalendarId: string }

export interface BatchResult {
  succeeded: number
  failed: number
  text: string
}

const CONTROL_KEYS = new Set([
  'op',
  'calendarId',
  'eventId',
  'scope',
  'recurrenceUntil',
  'destinationCalendarId',
])

// Event fields of an operation, minus control keys and undefined values
function eventFields(operation: BatchOperation): Partial<EventInput> {
  return Object.fromEntries(
    Object.entries(operation).filter(([k, v]) => !CONTROL_KEYS.has(k) && v !== undefined),
  ) as Partial<EventInput>
}

async function runOne(operation: BatchOperation): Promise<string> {
  const calendarId = operation.calendarId || 'primary'
  switch (operation.op) {
    case 'create': {
      const e = await createEvent(calendarId, eventFields(operation) as EventInput)
      return `Created event "${e.summary}" (${formatEventWhen(e)}, ID: ${e.id})`
    }
    case 'update': {
      const { eventId, scope, recurrenceUntil } = operation
      const e = await updateEvent(calendarId, eventId, eventFields(operation), {
        scope,
        recurrenceUntil,
      })
      const note = e.note ? ` ${e.note}` : ''
      return `Updated event "${e.summary}" (${formatEventWhen(e)}, ID: ${e.id})${note}`
    }
    case 'delete':
      return deleteEvent(calendarId, operation.eventId, operation.scope)
    case 'move': {
      const e = await moveEvent(calendarId, operation.eventId, operation.destinationCalendarId)
      return `Moved event "${e.summary}" to ${e.calendarName || e.calendarId} (ID: ${e.id})`
    }
  }
}

// Run operations one at a time, in order. A failure is recorded and the rest still run.
export async function runBatch(operations: BatchOperation[]): Promise<BatchResult> {
  const lines: string[] = []
  let succeeded = 0
  let failed = 0

  for (const [i, operation] of operations.entries()) {
    try {
      const message = await runOne(operation)
      succeeded++
      lines.push(`${i + 1}. OK ${operation.op}: ${message}`)
    } catch (err) {
      failed++
      const target = 'eventId' in operation ? ` ${operation.eventId}` : ''
      const message = err instanceof Error ? err.message : String(err)
      lines.push(`${i + 1}. FAILED ${operation.op}${target}: ${message}`)
    }
  }

  return {
    succeeded,
    failed,
    text: [`Batch: ${succeeded} succeeded, ${failed} failed`, ...lines].join('\n'),
  }
}

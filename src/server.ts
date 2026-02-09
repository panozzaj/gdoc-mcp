import { FastMCP } from 'fastmcp'
import { z } from 'zod'
import {
  readDoc,
  editDoc,
  getDocInfo,
  listDocs,
  searchDoc,
  createDoc,
  copyDoc,
} from './docs/client.js'
import { NotReadError } from './docs/concurrency.js'
import {
  readSheet,
  editSheet,
  appendSheet,
  addSheet,
  cloneSheet,
  getSheetInfo,
  createSheet,
  copySheet,
} from './sheets/client.js'
import {
  NotReadError as SheetNotReadError,
  ConcurrentModificationError,
} from './sheets/concurrency.js'
import {
  listCalendars,
  listEvents,
  getEvent,
  createEvent,
  updateEvent,
  deleteEvent,
  quickAdd,
} from './calendar/client.js'
import {
  listMessages,
  listDrafts,
  readMessage,
  listAttachments,
  saveAttachment,
  createDraft,
  createReplyDraft,
  updateDraft,
  deleteDraft,
} from './gmail/client.js'

const server = new FastMCP({
  name: 'gdoc-mcp',
  version: '0.1.0',
})

// Tool: Read a Google Doc
server.addTool({
  name: 'gdoc_read',
  description:
    'Read a Google Doc and return its content as markdown. Must be called before gdoc_edit. ' +
    'Formatting support: **bold**, *italic*, <u>underline</u>, ~~strikethrough~~, [links](url), headings (#), lists (- or 1.), tables. ' +
    'Images shown as <!-- gdoc:image id="..." --> comments (not editable). ' +
    'Use offset/limit for long docs. ' +
    'Note: Some complex formatting (colors, fonts, nested styles) may not be fully represented.',
  parameters: z.object({
    docId: z.string().describe('Google Doc ID or full URL'),
    format: z
      .enum(['markdown', 'json'])
      .optional()
      .default('markdown')
      .describe('Output format (default: markdown)'),
    offset: z
      .number()
      .optional()
      .describe('Line number to start from (1-indexed). Omit to start from beginning.'),
    limit: z.number().optional().describe('Maximum number of lines to return. Omit for all lines.'),
  }),
  execute: async ({ docId, format, offset, limit }) => {
    const result = await readDoc(docId, format)
    let content = result.content
    let header = `# ${result.title}`

    // Apply offset/limit if specified
    if (offset !== undefined || limit !== undefined) {
      const lines = content.split('\n')
      const totalLines = lines.length
      const startLine = offset ? Math.max(0, offset - 1) : 0
      const endLine = limit ? startLine + limit : totalLines
      const slicedLines = lines.slice(startLine, endLine)
      content = slicedLines.join('\n')
      header += ` (lines ${startLine + 1}-${Math.min(endLine, totalLines)} of ${totalLines})`
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: `${header}\n\n${content}`,
        },
      ],
    }
  },
})

// Tool: Search within a Google Doc
server.addTool({
  name: 'gdoc_search',
  description:
    'Search for text in a Google Doc and return matching lines with context. ' +
    'Useful for finding specific content in long documents without reading the entire doc. ' +
    'Returns matching lines with surrounding context (like grep -C).',
  parameters: z.object({
    docId: z.string().describe('Google Doc ID or full URL'),
    query: z.string().describe('Text or regex pattern to search for'),
    context: z
      .number()
      .optional()
      .default(2)
      .describe('Number of lines of context before and after each match (default: 2)'),
    maxMatches: z
      .number()
      .optional()
      .default(10)
      .describe('Maximum number of matches to return (default: 10)'),
  }),
  execute: async ({ docId, query, context, maxMatches }) => {
    const result = await searchDoc(docId, query, context, maxMatches)
    return {
      content: [
        {
          type: 'text' as const,
          text: result,
        },
      ],
    }
  },
})

// Tool: Edit a Google Doc
server.addTool({
  name: 'gdoc_edit',
  description:
    'Replace text in a Google Doc using markdown. Requires gdoc_read first. ' +
    'Use markdown in both old_text and new_text: **bold**, *italic*, <u>underline</u>, ~~strike~~, [link](url). ' +
    'old_text is matched by raw text (e.g., "[Click](url)" matches "Click" in doc). ' +
    'new_text formatting is applied to the replacement. ' +
    'Fails if old_text matches multiple locations (provide more context to disambiguate). ' +
    'NOT SUPPORTED: headings, images, colors, fonts.',
  parameters: z.object({
    docId: z.string().describe('Google Doc ID or full URL'),
    old_text: z
      .string()
      .describe(
        'Text to find (markdown supported). Matched by raw text content. Must be unique in document.',
      ),
    new_text: z
      .string()
      .describe(
        'Replacement text (markdown supported). Formatting like **bold**, *italic*, <u>underline</u>, [links](url) will be applied.',
      ),
  }),
  execute: async ({ docId, old_text, new_text }) => {
    try {
      const result = await editDoc(docId, old_text, new_text)
      return {
        content: [{ type: 'text' as const, text: result.message }],
      }
    } catch (error) {
      if (error instanceof NotReadError) {
        return {
          content: [{ type: 'text' as const, text: error.message }],
          isError: true,
        }
      }
      throw error
    }
  },
})

// Tool: List Google Docs
server.addTool({
  name: 'gdoc_list',
  description: 'List recent Google Docs, optionally filtered by name.',
  parameters: z.object({
    query: z.string().optional().describe('Filter docs by name (optional)'),
    limit: z.number().optional().default(10).describe('Max number of results (default: 10)'),
  }),
  execute: async ({ query, limit }) => {
    const docs = await listDocs(query, limit)
    const lines = docs.map((d) => `- ${d.name}\n  ID: ${d.id}\n  Modified: ${d.modifiedTime}`)
    return {
      content: [
        {
          type: 'text' as const,
          text: lines.length > 0 ? lines.join('\n\n') : 'No documents found.',
        },
      ],
    }
  },
})

// Tool: Get Doc Info
server.addTool({
  name: 'gdoc_info',
  description: 'Get metadata about a Google Doc (title, revision ID).',
  parameters: z.object({
    docId: z.string().describe('Google Doc ID or full URL'),
  }),
  execute: async ({ docId }) => {
    const info = await getDocInfo(docId)
    return {
      content: [
        {
          type: 'text' as const,
          text: `Title: ${info.title}\nID: ${info.id}\nRevision: ${info.revisionId}`,
        },
      ],
    }
  },
})

// Tool: Create a new Google Doc
server.addTool({
  name: 'gdoc_create',
  description: 'Create a new blank Google Doc.',
  parameters: z.object({
    title: z.string().describe('Title for the new document'),
    folderId: z
      .string()
      .optional()
      .describe('Google Drive folder ID or URL to create the doc in. Omit for default location.'),
  }),
  execute: async ({ title, folderId }) => {
    const result = await createDoc(title, folderId)
    return {
      content: [
        {
          type: 'text' as const,
          text: `Created document "${result.title}"\nID: ${result.id}\nURL: ${result.url}`,
        },
      ],
    }
  },
})

// Tool: Copy a Google Doc
server.addTool({
  name: 'gdoc_copy',
  description:
    'Create a copy of an existing Google Doc. ' +
    'By default, the copy is placed in the same folder as the original.',
  parameters: z.object({
    docId: z.string().describe('Google Doc ID or full URL of the document to copy'),
    title: z.string().optional().describe('Title for the copy. Defaults to "Copy of <original>".'),
    folderId: z
      .string()
      .optional()
      .describe('Google Drive folder ID or URL. Defaults to same folder as original.'),
  }),
  execute: async ({ docId, title, folderId }) => {
    const result = await copyDoc(docId, title, folderId)
    return {
      content: [
        {
          type: 'text' as const,
          text: `Copied document as "${result.title}"\nID: ${result.id}\nURL: ${result.url}`,
        },
      ],
    }
  },
})

// ============ Google Sheets Tools ============

// Tool: Read a Google Sheet
server.addTool({
  name: 'gsheet_read',
  description:
    'Read a Google Sheet and return its content as a markdown table. ' +
    'Returns the first sheet by default, or specify a sheet name. ' +
    'Use range parameter to read a specific area (e.g., "A1:D10").',
  parameters: z.object({
    spreadsheetId: z.string().describe('Google Spreadsheet ID or full URL'),
    sheet: z.string().optional().describe('Sheet name (default: first sheet)'),
    range: z
      .string()
      .optional()
      .describe('Cell range to read (e.g., "A1:D10"). Omit for entire sheet.'),
  }),
  execute: async ({ spreadsheetId, sheet, range }) => {
    const result = await readSheet(spreadsheetId, sheet, range)
    const header = `# ${result.title} - ${result.sheetTitle} (${result.rowCount} rows, ${result.columnCount} cols)`
    return {
      content: [
        {
          type: 'text' as const,
          text: `${header}\n\n${result.content}`,
        },
      ],
    }
  },
})

// Tool: Edit cells in a Google Sheet
server.addTool({
  name: 'gsheet_edit',
  description:
    'Update cells in a Google Sheet. Specify the range and new values. ' +
    'Values are entered as USER_ENTERED, so formulas (=SUM(A1:A10)) work.',
  parameters: z.object({
    spreadsheetId: z.string().describe('Google Spreadsheet ID or full URL'),
    range: z.string().describe('Cell range to update (e.g., "A1:B2", "A1", "Sheet2!A1:C3")'),
    values: z
      .array(z.array(z.string()))
      .describe('2D array of values, e.g., [["a", "b"], ["c", "d"]] for a 2x2 range'),
    sheet: z.string().optional().describe('Sheet name (if not included in range)'),
  }),
  execute: async ({ spreadsheetId, range, values, sheet }) => {
    try {
      const result = await editSheet(spreadsheetId, range, values, sheet)
      return {
        content: [{ type: 'text' as const, text: result.message }],
      }
    } catch (error) {
      if (error instanceof SheetNotReadError || error instanceof ConcurrentModificationError) {
        return {
          content: [{ type: 'text' as const, text: (error as Error).message }],
          isError: true,
        }
      }
      throw error
    }
  },
})

// Tool: Append rows to a Google Sheet
server.addTool({
  name: 'gsheet_append',
  description:
    'Append rows to the end of a Google Sheet. ' +
    'Finds the last row with data and adds new rows below it.',
  parameters: z.object({
    spreadsheetId: z.string().describe('Google Spreadsheet ID or full URL'),
    values: z
      .array(z.array(z.string()))
      .describe(
        '2D array of rows to append, e.g., [["row1col1", "row1col2"], ["row2col1", "row2col2"]]',
      ),
    sheet: z.string().optional().describe('Sheet name (default: first sheet)'),
  }),
  execute: async ({ spreadsheetId, values, sheet }) => {
    const result = await appendSheet(spreadsheetId, values, sheet)
    return {
      content: [{ type: 'text' as const, text: result.message }],
    }
  },
})

// Tool: Add a new sheet to a spreadsheet
server.addTool({
  name: 'gsheet_add_sheet',
  description: 'Add a new sheet (tab) to an existing Google Spreadsheet.',
  parameters: z.object({
    spreadsheetId: z.string().describe('Google Spreadsheet ID or full URL'),
    title: z.string().describe('Name for the new sheet'),
  }),
  execute: async ({ spreadsheetId, title }) => {
    const result = await addSheet(spreadsheetId, title)
    return {
      content: [{ type: 'text' as const, text: result.message }],
    }
  },
})

// Tool: Clone a sheet within a spreadsheet
server.addTool({
  name: 'gsheet_clone_sheet',
  description:
    'Clone/duplicate an existing sheet (tab) within the same spreadsheet. ' +
    'Preserves all formatting, formulas, and cell values.',
  parameters: z.object({
    spreadsheetId: z.string().describe('Google Spreadsheet ID or full URL'),
    sourceSheetName: z.string().describe('Name of the sheet to clone'),
    newSheetName: z.string().describe('Name for the cloned sheet'),
  }),
  execute: async ({ spreadsheetId, sourceSheetName, newSheetName }) => {
    const result = await cloneSheet(spreadsheetId, sourceSheetName, newSheetName)
    return {
      content: [{ type: 'text' as const, text: result.message }],
    }
  },
})

// Tool: Get Sheet Info
server.addTool({
  name: 'gsheet_info',
  description: 'Get metadata about a Google Spreadsheet (title, list of sheets with dimensions).',
  parameters: z.object({
    spreadsheetId: z.string().describe('Google Spreadsheet ID or full URL'),
  }),
  execute: async ({ spreadsheetId }) => {
    const info = await getSheetInfo(spreadsheetId)
    const sheetsInfo = info.sheets
      .map((s) => `  - ${s.title} (${s.rowCount} rows, ${s.columnCount} cols)`)
      .join('\n')
    return {
      content: [
        {
          type: 'text' as const,
          text: `Title: ${info.title}\nID: ${info.id}\nSheets:\n${sheetsInfo}`,
        },
      ],
    }
  },
})

// Tool: Create a new Google Spreadsheet
server.addTool({
  name: 'gsheet_create',
  description: 'Create a new blank Google Spreadsheet.',
  parameters: z.object({
    title: z.string().describe('Title for the new spreadsheet'),
    folderId: z
      .string()
      .optional()
      .describe(
        'Google Drive folder ID or URL to create the spreadsheet in. Omit for default location.',
      ),
  }),
  execute: async ({ title, folderId }) => {
    const result = await createSheet(title, folderId)
    return {
      content: [
        {
          type: 'text' as const,
          text: `Created spreadsheet "${result.title}"\nID: ${result.id}\nURL: ${result.url}`,
        },
      ],
    }
  },
})

// Tool: Copy a Google Spreadsheet
server.addTool({
  name: 'gsheet_copy',
  description:
    'Create a copy of an existing Google Spreadsheet. ' +
    'By default, the copy is placed in the same folder as the original.',
  parameters: z.object({
    spreadsheetId: z
      .string()
      .describe('Google Spreadsheet ID or full URL of the spreadsheet to copy'),
    title: z.string().optional().describe('Title for the copy. Defaults to "Copy of <original>".'),
    folderId: z
      .string()
      .optional()
      .describe('Google Drive folder ID or URL. Defaults to same folder as original.'),
  }),
  execute: async ({ spreadsheetId, title, folderId }) => {
    const result = await copySheet(spreadsheetId, title, folderId)
    return {
      content: [
        {
          type: 'text' as const,
          text: `Copied spreadsheet as "${result.title}"\nID: ${result.id}\nURL: ${result.url}`,
        },
      ],
    }
  },
})

// ============ Google Calendar Tools ============

server.addTool({
  name: 'gcal_list_calendars',
  description: 'List all calendars the user has access to (owned, subscribed, shared).',
  parameters: z.object({}),
  execute: async () => {
    const calendars = await listCalendars()
    const lines = calendars.map(
      (c) => `- ${c.summary}${c.primary ? ' (primary)' : ''}\n  ID: ${c.id}`,
    )
    return {
      content: [
        {
          type: 'text' as const,
          text: lines.length > 0 ? lines.join('\n\n') : 'No calendars found.',
        },
      ],
    }
  },
})

server.addTool({
  name: 'gcal_list_events',
  description:
    'List upcoming events from a calendar. ' +
    'Returns events sorted by start time. ' +
    'Use timeMin/timeMax to query a specific date range.',
  parameters: z.object({
    calendarId: z
      .string()
      .optional()
      .default('primary')
      .describe('Calendar ID (default: primary). Use gcal_list_calendars to find IDs.'),
    timeMin: z
      .string()
      .optional()
      .describe(
        'Start of time range (ISO 8601, e.g. "2025-01-15T00:00:00-05:00"). Defaults to now.',
      ),
    timeMax: z
      .string()
      .optional()
      .describe('End of time range (ISO 8601). Omit to list upcoming events.'),
    maxResults: z.number().optional().default(10).describe('Max events to return (default: 10)'),
    query: z.string().optional().describe('Free text search across event fields'),
  }),
  execute: async ({ calendarId, timeMin, timeMax, maxResults, query }) => {
    const events = await listEvents(calendarId, timeMin, timeMax, maxResults, query)
    if (events.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No events found.' }] }
    }
    const lines = events.map((e) => {
      let line = `- **${e.summary}**\n  ${e.allDay ? 'All day' : `${e.start} → ${e.end}`}`
      if (e.location) line += `\n  Location: ${e.location}`
      if (e.meetLink) line += `\n  Meet: ${e.meetLink}`
      line += `\n  ID: ${e.id}`
      return line
    })
    return { content: [{ type: 'text' as const, text: lines.join('\n\n') }] }
  },
})

server.addTool({
  name: 'gcal_read_event',
  description: 'Get full details of a single calendar event.',
  parameters: z.object({
    calendarId: z.string().optional().default('primary').describe('Calendar ID'),
    eventId: z.string().describe('Event ID'),
  }),
  execute: async ({ calendarId, eventId }) => {
    const e = await getEvent(calendarId, eventId)
    const parts = [
      `**${e.summary}**`,
      e.allDay ? `All day: ${e.start}` : `Start: ${e.start}\nEnd: ${e.end}`,
    ]
    if (e.location) parts.push(`Location: ${e.location}`)
    if (e.description) parts.push(`Description: ${e.description}`)
    if (e.attendees?.length) parts.push(`Attendees: ${e.attendees.join(', ')}`)
    if (e.meetLink) parts.push(`Meet: ${e.meetLink}`)
    if (e.htmlLink) parts.push(`Link: ${e.htmlLink}`)
    parts.push(`Status: ${e.status || 'confirmed'}`)
    parts.push(`ID: ${e.id}`)
    return { content: [{ type: 'text' as const, text: parts.join('\n') }] }
  },
})

server.addTool({
  name: 'gcal_create_event',
  description:
    'Create a new calendar event. ' +
    'For all-day events, use date format YYYY-MM-DD. ' +
    'For timed events, use ISO 8601 datetime.',
  parameters: z.object({
    calendarId: z.string().optional().default('primary').describe('Calendar ID'),
    summary: z.string().describe('Event title'),
    start: z.string().describe('Start time (ISO 8601 datetime or YYYY-MM-DD for all-day)'),
    end: z.string().describe('End time (ISO 8601 datetime or YYYY-MM-DD for all-day)'),
    description: z.string().optional().describe('Event description'),
    location: z.string().optional().describe('Event location'),
    attendees: z.array(z.string()).optional().describe('List of attendee email addresses'),
    timeZone: z
      .string()
      .optional()
      .describe('Time zone (e.g. "America/New_York"). Defaults to system timezone.'),
  }),
  execute: async ({
    calendarId,
    summary,
    start,
    end,
    description,
    location,
    attendees,
    timeZone,
  }) => {
    const event = await createEvent(calendarId, {
      summary,
      start,
      end,
      description,
      location,
      attendees,
      timeZone,
    })
    return {
      content: [
        {
          type: 'text' as const,
          text: `Created event "${event.summary}"\nStart: ${event.start}\nEnd: ${event.end}\nID: ${event.id}${event.htmlLink ? `\nLink: ${event.htmlLink}` : ''}`,
        },
      ],
    }
  },
})

server.addTool({
  name: 'gcal_update_event',
  description: 'Update an existing calendar event. Only provided fields are changed.',
  parameters: z.object({
    calendarId: z.string().optional().default('primary').describe('Calendar ID'),
    eventId: z.string().describe('Event ID'),
    summary: z.string().optional().describe('New event title'),
    start: z.string().optional().describe('New start time'),
    end: z.string().optional().describe('New end time'),
    description: z.string().optional().describe('New description'),
    location: z.string().optional().describe('New location'),
    attendees: z.array(z.string()).optional().describe('New attendee list (replaces existing)'),
    timeZone: z.string().optional().describe('Time zone for start/end times'),
  }),
  execute: async ({
    calendarId,
    eventId,
    summary,
    start,
    end,
    description,
    location,
    attendees,
    timeZone,
  }) => {
    const updates: Record<string, unknown> = {}
    if (summary !== undefined) updates.summary = summary
    if (start !== undefined) updates.start = start
    if (end !== undefined) updates.end = end
    if (description !== undefined) updates.description = description
    if (location !== undefined) updates.location = location
    if (attendees !== undefined) updates.attendees = attendees
    if (timeZone !== undefined) updates.timeZone = timeZone

    const event = await updateEvent(calendarId, eventId, updates)
    return {
      content: [
        {
          type: 'text' as const,
          text: `Updated event "${event.summary}"\nStart: ${event.start}\nEnd: ${event.end}\nID: ${event.id}`,
        },
      ],
    }
  },
})

server.addTool({
  name: 'gcal_delete_event',
  description: 'Delete a calendar event.',
  parameters: z.object({
    calendarId: z.string().optional().default('primary').describe('Calendar ID'),
    eventId: z.string().describe('Event ID to delete'),
  }),
  execute: async ({ calendarId, eventId }) => {
    await deleteEvent(calendarId, eventId)
    return {
      content: [{ type: 'text' as const, text: `Deleted event ${eventId}` }],
    }
  },
})

server.addTool({
  name: 'gcal_quick_add_event',
  description:
    'Create an event from natural language text. ' +
    'Google parses the text to extract date, time, and title. ' +
    'Example: "Lunch with Bob tomorrow at noon at Cafe Milano"',
  parameters: z.object({
    calendarId: z.string().optional().default('primary').describe('Calendar ID'),
    text: z.string().describe('Natural language event description'),
  }),
  execute: async ({ calendarId, text }) => {
    const event = await quickAdd(calendarId, text)
    return {
      content: [
        {
          type: 'text' as const,
          text: `Created event "${event.summary}"\nStart: ${event.start}\nEnd: ${event.end}\nID: ${event.id}`,
        },
      ],
    }
  },
})

// ============ Gmail Tools ============

server.addTool({
  name: 'gmail_list_messages',
  description:
    'Search and list emails using Gmail search syntax. ' +
    'Examples: "from:alice", "subject:invoice", "is:unread", "newer_than:7d". ' +
    'Returns message summaries with IDs for use with gmail_read_message.',
  parameters: z.object({
    query: z
      .string()
      .optional()
      .describe(
        'Gmail search query (e.g. "from:alice@example.com", "is:unread", "subject:invoice"). Omit to list recent messages.',
      ),
    maxResults: z
      .number()
      .optional()
      .default(10)
      .describe('Max messages to return (default: 10, max: 50)'),
  }),
  execute: async ({ query, maxResults }) => {
    const messages = await listMessages(query, maxResults)
    if (messages.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No messages found.' }] }
    }
    const lines = messages.map(
      (m) =>
        `- **${m.subject || '(no subject)'}**\n  From: ${m.from}\n  Date: ${m.date}\n  ${m.snippet}\n  ID: ${m.id}`,
    )
    let text = lines.join('\n\n')
    if (query) {
      text += `\n\nSearch in Gmail: https://mail.google.com/mail/#search/${encodeURIComponent(query)}`
    }
    return { content: [{ type: 'text' as const, text }] }
  },
})

server.addTool({
  name: 'gmail_read_message',
  description:
    'Read the full content of an email message by ID. ' +
    'Returns headers, body text, and labels. Use gmail_list_messages to find message IDs, then gmail_read_message to read one.',
  parameters: z.object({
    messageId: z.string().describe('Message ID (from gmail_list_messages results)'),
  }),
  execute: async ({ messageId }) => {
    const msg = await readMessage(messageId)
    const parts = [`**${msg.subject || '(no subject)'}**`, `From: ${msg.from}`, `To: ${msg.to}`]
    if (msg.cc) parts.push(`Cc: ${msg.cc}`)
    parts.push(`Date: ${msg.date}`)
    if (msg.labels.length > 0) parts.push(`Labels: ${msg.labels.join(', ')}`)
    parts.push(`Link: https://mail.google.com/mail/#inbox/${messageId}`)
    parts.push('', msg.body)
    return { content: [{ type: 'text' as const, text: parts.join('\n') }] }
  },
})

server.addTool({
  name: 'gmail_list_drafts',
  description: 'List existing email drafts. Returns draft IDs, subjects, and recipients.',
  parameters: z.object({
    maxResults: z
      .number()
      .optional()
      .default(10)
      .describe('Max drafts to return (default: 10, max: 50)'),
  }),
  execute: async ({ maxResults }) => {
    const drafts = await listDrafts(maxResults)
    if (drafts.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No drafts found.' }] }
    }
    const lines = drafts.map(
      (d) =>
        `- **${d.subject || '(no subject)'}**\n  To: ${d.to || '(no recipient)'}\n  ${d.snippet}\n  Draft ID: ${d.draftId}`,
    )
    return { content: [{ type: 'text' as const, text: lines.join('\n\n') }] }
  },
})

server.addTool({
  name: 'gmail_create_draft',
  description:
    'Create a new email draft. The draft is saved but NOT sent. ' +
    'The user can review and send it from Gmail.',
  parameters: z.object({
    to: z.string().describe('Recipient email address'),
    subject: z.string().describe('Email subject'),
    body: z.string().describe('Email body (plain text)'),
    cc: z.string().optional().describe('CC email address(es)'),
    bcc: z.string().optional().describe('BCC email address(es)'),
    attachments: z.array(z.string()).optional().describe('List of local file paths to attach'),
  }),
  execute: async ({ to, subject, body, cc, bcc, attachments }) => {
    const draft = await createDraft(to, subject, body, cc, bcc, attachments)
    const parts = [
      `Draft created: "${draft.subject}"`,
      `To: ${draft.to}`,
      `Draft ID: ${draft.draftId}`,
    ]
    if (draft.messageId) {
      parts.push(`Link: https://mail.google.com/mail/#drafts/${draft.messageId}`)
    }
    return { content: [{ type: 'text' as const, text: parts.join('\n') }] }
  },
})

server.addTool({
  name: 'gmail_create_reply_draft',
  description:
    'Create a reply draft to an existing email message. ' +
    'Threads correctly with the original conversation. The draft is saved but NOT sent.',
  parameters: z.object({
    messageId: z
      .string()
      .describe('Message ID to reply to (from gmail_list_messages or gmail_read_message)'),
    body: z.string().describe('Reply body (plain text)'),
  }),
  execute: async ({ messageId, body }) => {
    const draft = await createReplyDraft(messageId, body)
    const parts = [
      `Reply draft created: "${draft.subject}"`,
      `To: ${draft.to}`,
      `Thread ID: ${draft.threadId}`,
      `Draft ID: ${draft.draftId}`,
    ]
    if (draft.messageId) {
      parts.push(`Link: https://mail.google.com/mail/#drafts/${draft.messageId}`)
    }
    return { content: [{ type: 'text' as const, text: parts.join('\n') }] }
  },
})

server.addTool({
  name: 'gmail_update_draft',
  description:
    'Update an existing email draft. Only provided fields are changed. ' +
    'Preserves threading headers for reply drafts.',
  parameters: z.object({
    draftId: z.string().describe('Draft ID (from gmail_create_draft or gmail_create_reply_draft)'),
    to: z.string().optional().describe('New recipient'),
    subject: z.string().optional().describe('New subject'),
    body: z.string().optional().describe('New body (plain text)'),
    cc: z.string().optional().describe('New CC'),
    bcc: z.string().optional().describe('New BCC'),
  }),
  execute: async ({ draftId, to, subject, body, cc, bcc }) => {
    const updates: Record<string, string | undefined> = {}
    if (to !== undefined) updates.to = to
    if (subject !== undefined) updates.subject = subject
    if (body !== undefined) updates.body = body
    if (cc !== undefined) updates.cc = cc
    if (bcc !== undefined) updates.bcc = bcc

    const draft = await updateDraft(draftId, updates)
    const parts = [
      `Draft updated: "${draft.subject}"`,
      `To: ${draft.to}`,
      `Draft ID: ${draft.draftId}`,
    ]
    if (draft.messageId) {
      parts.push(`Link: https://mail.google.com/mail/#drafts/${draft.messageId}`)
    }
    return { content: [{ type: 'text' as const, text: parts.join('\n') }] }
  },
})

server.addTool({
  name: 'gmail_list_message_attachments',
  description:
    'List attachments on an email message. Returns filenames, MIME types, sizes, and attachment IDs ' +
    'for use with gmail_save_attachment.',
  parameters: z.object({
    messageId: z.string().describe('Message ID (from gmail_list_messages or gmail_read_message)'),
  }),
  execute: async ({ messageId }) => {
    const attachmentsList = await listAttachments(messageId)
    if (attachmentsList.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No attachments found.' }] }
    }
    const lines = attachmentsList.map(
      (a) =>
        `- **${a.filename}**\n  Type: ${a.mimeType}\n  Size: ${a.size} bytes\n  Attachment ID: ${a.attachmentId}`,
    )
    return { content: [{ type: 'text' as const, text: lines.join('\n\n') }] }
  },
})

server.addTool({
  name: 'gmail_save_attachment',
  description:
    'Download and save an email attachment to a local file. ' +
    'Use gmail_list_message_attachments to get attachment IDs.',
  parameters: z.object({
    messageId: z.string().describe('Message ID the attachment belongs to'),
    attachmentId: z.string().describe('Attachment ID (from gmail_list_attachments)'),
    savePath: z.string().describe('Local file path to save the attachment to'),
  }),
  execute: async ({ messageId, attachmentId, savePath }) => {
    const savedTo = await saveAttachment(messageId, attachmentId, savePath)
    return {
      content: [{ type: 'text' as const, text: `Attachment saved to: ${savedTo}` }],
    }
  },
})

server.addTool({
  name: 'gmail_delete_draft',
  description: 'Permanently delete an email draft.',
  parameters: z.object({
    draftId: z.string().describe('Draft ID to delete'),
  }),
  execute: async ({ draftId }) => {
    await deleteDraft(draftId)
    return {
      content: [{ type: 'text' as const, text: `Deleted draft ${draftId}` }],
    }
  },
})

// Handle uncaught errors gracefully
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error)
})

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error)
})

// Start the server
server.start({
  transportType: 'stdio',
})

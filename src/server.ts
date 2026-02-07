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
  getSheetInfo,
  createSheet,
  copySheet,
} from './sheets/client.js'
import {
  NotReadError as SheetNotReadError,
  ConcurrentModificationError,
} from './sheets/concurrency.js'

const server = new FastMCP({
  name: 'gdoc-mcp',
  version: '0.1.0',
})

// Tool: Read a Google Doc
server.addTool({
  name: 'gdoc_read',
  description:
    'Read a Google Doc and return its content as markdown. Must be called before gdoc_edit. ' +
    'Formatting support: **bold**, *italic*, ~~strikethrough~~, [links](url), headings (#), lists (- or 1.), tables. ' +
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
    'Use markdown in both old_text and new_text: **bold**, *italic*, ~~strike~~, [link](url). ' +
    'old_text is matched by raw text (e.g., "[Click](url)" matches "Click" in doc). ' +
    'new_text formatting is applied to the replacement. ' +
    'Fails if old_text matches multiple locations (provide more context to disambiguate). ' +
    'NOT SUPPORTED: tables, headings, images, colors, fonts.',
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
        'Replacement text (markdown supported). Formatting like **bold**, *italic*, [links](url) will be applied.',
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

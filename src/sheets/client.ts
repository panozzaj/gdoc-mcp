import { getSheetsClient, getDriveClient } from '../auth.js'
import { extractFolderId } from '../types.js'
import {
  cacheFormulas,
  cacheDimensions,
  cacheSheetNames,
  detectSheetRename,
  migrateCacheForRename,
  getCachedRange,
  hasReadRange,
  invalidateRange,
  parseRange,
  NotReadError,
  ConcurrentModificationError,
} from './concurrency.js'

// Extract spreadsheet ID from URL or return as-is if already an ID
function extractSpreadsheetId(idOrUrl: string): string {
  // Handle full URLs like https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit
  const urlMatch = idOrUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)
  if (urlMatch) {
    return urlMatch[1]
  }
  // Assume it's already an ID
  return idOrUrl
}

export interface SheetInfo {
  id: string
  title: string
  sheets: { id: number; title: string; rowCount: number; columnCount: number }[]
}

export interface SheetContent {
  id: string
  title: string
  sheetTitle: string
  content: string
  rowCount: number
  columnCount: number
}

export async function getSheetInfo(spreadsheetIdOrUrl: string): Promise<SheetInfo> {
  const spreadsheetId = extractSpreadsheetId(spreadsheetIdOrUrl)
  const sheets = await getSheetsClient()

  const response = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'properties.title,sheets.properties',
  })

  const data = response.data
  return {
    id: spreadsheetId,
    title: data.properties?.title || 'Untitled',
    sheets: (data.sheets || []).map((s) => ({
      id: s.properties?.sheetId || 0,
      title: s.properties?.title || 'Sheet',
      rowCount: s.properties?.gridProperties?.rowCount || 0,
      columnCount: s.properties?.gridProperties?.columnCount || 0,
    })),
  }
}

export async function readSheet(
  spreadsheetIdOrUrl: string,
  sheetName?: string,
  range?: string,
): Promise<SheetContent> {
  const spreadsheetId = extractSpreadsheetId(spreadsheetIdOrUrl)
  const sheets = await getSheetsClient()

  // Get spreadsheet metadata first
  const metaResponse = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'properties.title,sheets.properties',
  })

  const spreadsheetTitle = metaResponse.data.properties?.title || 'Untitled'
  const sheetsList = metaResponse.data.sheets || []

  // Determine which sheet to read
  let targetSheet = sheetsList[0]
  if (sheetName) {
    const found = sheetsList.find((s) => s.properties?.title === sheetName)
    if (!found) {
      const available = sheetsList.map((s) => s.properties?.title).join(', ')
      throw new Error(`Sheet "${sheetName}" not found. Available: ${available}`)
    }
    targetSheet = found
  }

  const sheetTitle = targetSheet.properties?.title || 'Sheet1'
  const sheetRowCount = targetSheet.properties?.gridProperties?.rowCount || 1000
  const sheetColCount = targetSheet.properties?.gridProperties?.columnCount || 26

  // Don't prefix if range already includes sheet name (has !)
  const readRange = range ? (range.includes('!') ? range : `${sheetTitle}!${range}`) : sheetTitle

  // Parse range to check bounds (only when explicit range provided)
  const parsed = range ? parseRange(readRange) : null
  const startCol = parsed?.startCol || 1
  const startRow = parsed?.startRow || 1
  const endCol = parsed?.endCol || sheetColCount
  const endRow = parsed?.endRow || sheetRowCount

  // Check if requested range exceeds sheet dimensions (only for explicit ranges)
  if (parsed) {
    if (parsed.endRow > sheetRowCount) {
      throw new Error(
        `Range exceeds sheet bounds: requested row ${parsed.endRow} but sheet "${sheetTitle}" only has ${sheetRowCount} rows.`,
      )
    }
    if (parsed.endCol > sheetColCount) {
      throw new Error(
        `Range exceeds sheet bounds: requested column ${parsed.endCol} but sheet "${sheetTitle}" only has ${sheetColCount} columns.`,
      )
    }
  }

  // Read both values and formulas
  const [valuesResponse, formulasResponse] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: readRange,
      valueRenderOption: 'FORMATTED_VALUE',
    }),
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: readRange,
      valueRenderOption: 'FORMULA',
    }),
  ])

  const rows = valuesResponse.data.values || []
  const formulas = formulasResponse.data.values || []

  // Pad data to match requested range dimensions (only when explicit range provided)
  // Google Sheets API truncates trailing empty rows/cols, so we pad them back
  let paddedFormulas: (string | null)[][]
  let paddedRows: string[][]

  if (range && parsed) {
    // Explicit range: pad to requested dimensions
    const requestedRows = endRow - startRow + 1
    const requestedCols = endCol - startCol + 1

    paddedFormulas = []
    for (let r = 0; r < requestedRows; r++) {
      const sourceRow = formulas[r] || []
      const paddedRow: (string | null)[] = []
      for (let c = 0; c < requestedCols; c++) {
        paddedRow.push(sourceRow[c] ?? null)
      }
      paddedFormulas.push(paddedRow)
    }

    paddedRows = []
    for (let r = 0; r < requestedRows; r++) {
      const sourceRow = rows[r] || []
      const paddedRow: string[] = []
      for (let c = 0; c < requestedCols; c++) {
        paddedRow.push(sourceRow[c] != null ? String(sourceRow[c]) : '')
      }
      paddedRows.push(paddedRow)
    }
  } else {
    // No explicit range: use actual data as-is
    paddedFormulas = formulas.map((row) => row.map((cell) => cell ?? null))
    paddedRows = rows.map((row) => row.map((cell) => (cell != null ? String(cell) : '')))
  }

  // Cache formulas for concurrency control
  cacheFormulas(spreadsheetId, sheetTitle, startCol, startRow, paddedFormulas)

  // Cache sheet dimensions
  cacheDimensions(
    spreadsheetId,
    sheetsList.map((s) => ({
      title: s.properties?.title || 'Sheet',
      rows: s.properties?.gridProperties?.rowCount || 0,
      cols: s.properties?.gridProperties?.columnCount || 0,
    })),
  )

  // Cache sheet ID to name mapping for rename detection
  cacheSheetNames(
    spreadsheetId,
    sheetsList.map((s) => ({
      id: s.properties?.sheetId || 0,
      title: s.properties?.title || 'Sheet',
    })),
  )

  // Convert to markdown table (use paddedRows for consistency with cache)
  let content: string
  if (paddedRows.length === 0) {
    content = '(empty sheet)'
  } else {
    const lines: string[] = []

    for (let i = 0; i < paddedRows.length; i++) {
      const row = paddedRows[i]
      lines.push(`| ${row.join(' | ')} |`)

      // Add header separator after first row
      if (i === 0) {
        lines.push(`| ${row.map(() => '---').join(' | ')} |`)
      }
    }

    content = lines.join('\n')
  }

  return {
    id: spreadsheetId,
    title: spreadsheetTitle,
    sheetTitle,
    content,
    rowCount: paddedRows.length,
    columnCount: paddedRows.length > 0 ? paddedRows[0].length : 0,
  }
}

export async function editSheet(
  spreadsheetIdOrUrl: string,
  range: string,
  values: string[][],
  sheetName?: string,
): Promise<{ success: boolean; message: string; updatedCells: number }> {
  const spreadsheetId = extractSpreadsheetId(spreadsheetIdOrUrl)
  const sheets = await getSheetsClient()

  // Get current sheet metadata
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties',
  })
  const sheetsList = meta.data.sheets || []

  // Detect if any sheets were renamed and migrate cache entries
  // Also track if the user passed an old sheet name
  let resolvedSheetName = sheetName
  for (const sheet of sheetsList) {
    const currentName = sheet.properties?.title
    const sheetId = sheet.properties?.sheetId
    if (currentName && sheetId != null) {
      const oldName = detectSheetRename(spreadsheetId, currentName, sheetId)
      if (oldName) {
        migrateCacheForRename(spreadsheetId, oldName, currentName)
        // If user passed the old sheet name, use the new name instead
        if (sheetName === oldName) {
          resolvedSheetName = currentName
        }
      }
    }
  }

  // Update sheet name cache with current names
  cacheSheetNames(
    spreadsheetId,
    sheetsList.map((s) => ({
      id: s.properties?.sheetId || 0,
      title: s.properties?.title || 'Sheet',
    })),
  )

  // Determine default sheet name if not provided
  let defaultSheetName = resolvedSheetName
  if (!defaultSheetName && !range.includes('!')) {
    defaultSheetName = sheetsList[0]?.properties?.title || 'Sheet1'
  }

  // Build full range with resolved sheet name
  const fullRange = resolvedSheetName ? `${resolvedSheetName}!${range}` : range

  // Check if cells were read first
  if (!hasReadRange(spreadsheetId, fullRange, defaultSheetName)) {
    throw new NotReadError(spreadsheetId, fullRange)
  }

  // Get cached formulas for comparison
  const cachedFormulas = getCachedRange(spreadsheetId, fullRange, defaultSheetName)
  if (!cachedFormulas) {
    throw new NotReadError(spreadsheetId, fullRange)
  }

  // Fetch current formulas to check for concurrent modifications
  const currentFormulasResponse = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: fullRange,
    valueRenderOption: 'FORMULA',
  })
  const currentFormulas = currentFormulasResponse.data.values || []

  // Compare formulas
  const changedCells: string[] = []
  const parsed = parseRange(fullRange)
  if (parsed) {
    const resolvedSheet = parsed.sheetName || defaultSheetName || 'Sheet1'
    for (let rowIdx = 0; rowIdx < currentFormulas.length; rowIdx++) {
      const row = currentFormulas[rowIdx] || []
      for (let colIdx = 0; colIdx < row.length; colIdx++) {
        const col = parsed.startCol + colIdx
        const rowNum = parsed.startRow + rowIdx
        const ref = `${resolvedSheet}!${columnToLetter(col)}${rowNum}`

        const currentVal = row[colIdx]
        const currentFormula = currentVal?.startsWith?.('=') ? currentVal : null
        const cachedFormula = cachedFormulas.get(ref)

        if (currentFormula !== cachedFormula) {
          changedCells.push(ref)
        }
      }
    }
  }

  if (changedCells.length > 0) {
    invalidateRange(spreadsheetId, fullRange, defaultSheetName)
    throw new ConcurrentModificationError(changedCells)
  }

  // All checks passed, perform the update
  const response = await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: fullRange,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values,
    },
  })

  // Update cache with new formulas
  if (parsed) {
    const resolvedSheet = parsed.sheetName || defaultSheetName || 'Sheet1'
    cacheFormulas(spreadsheetId, resolvedSheet, parsed.startCol, parsed.startRow, values)
  }

  const updatedCells = response.data.updatedCells || 0
  return {
    success: true,
    message: `Updated ${updatedCells} cell${updatedCells !== 1 ? 's' : ''} in ${fullRange}`,
    updatedCells,
  }
}

// Helper to convert column number to letter
function columnToLetter(col: number): string {
  let result = ''
  while (col > 0) {
    col--
    result = String.fromCharCode((col % 26) + 65) + result
    col = Math.floor(col / 26)
  }
  return result
}

export async function appendSheet(
  spreadsheetIdOrUrl: string,
  values: string[][],
  sheetName?: string,
): Promise<{ success: boolean; message: string; updatedRange: string }> {
  const spreadsheetId = extractSpreadsheetId(spreadsheetIdOrUrl)
  const sheets = await getSheetsClient()

  // If no sheet name, get the first sheet
  let targetRange = sheetName || 'Sheet1'
  if (!sheetName) {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets.properties.title',
    })
    targetRange = meta.data.sheets?.[0]?.properties?.title || 'Sheet1'
  }

  const response = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: targetRange,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values,
    },
  })

  const updatedRange = response.data.updates?.updatedRange || targetRange
  const updatedRows = response.data.updates?.updatedRows || values.length

  return {
    success: true,
    message: `Appended ${updatedRows} row${updatedRows !== 1 ? 's' : ''} to ${updatedRange}`,
    updatedRange,
  }
}

export async function addSheet(
  spreadsheetIdOrUrl: string,
  title: string,
): Promise<{ success: boolean; message: string; sheetId: number }> {
  const spreadsheetId = extractSpreadsheetId(spreadsheetIdOrUrl)
  const sheets = await getSheetsClient()

  const response = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: {
              title,
            },
          },
        },
      ],
    },
  })

  const newSheet = response.data.replies?.[0]?.addSheet?.properties
  const sheetId = newSheet?.sheetId ?? 0

  return {
    success: true,
    message: `Added sheet "${title}" to spreadsheet`,
    sheetId,
  }
}

export async function cloneSheet(
  spreadsheetIdOrUrl: string,
  sourceSheetName: string,
  newSheetName: string,
): Promise<{ success: boolean; message: string; sheetId: number }> {
  const spreadsheetId = extractSpreadsheetId(spreadsheetIdOrUrl)
  const sheets = await getSheetsClient()

  // Look up the source sheet's numeric ID by name
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties',
  })

  const sourceSheet = (meta.data.sheets || []).find((s) => s.properties?.title === sourceSheetName)
  if (!sourceSheet) {
    const available = (meta.data.sheets || []).map((s) => s.properties?.title).join(', ')
    throw new Error(`Sheet "${sourceSheetName}" not found. Available: ${available}`)
  }

  const sourceSheetId = sourceSheet.properties?.sheetId
  if (sourceSheetId == null) {
    throw new Error(`Could not determine sheet ID for "${sourceSheetName}"`)
  }

  const response = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          duplicateSheet: {
            sourceSheetId,
            newSheetName,
          },
        },
      ],
    },
  })

  const newSheet = response.data.replies?.[0]?.duplicateSheet?.properties
  const sheetId = newSheet?.sheetId ?? 0

  return {
    success: true,
    message: `Cloned "${sourceSheetName}" as "${newSheetName}"`,
    sheetId,
  }
}

export async function createSheet(
  title: string,
  folderIdOrUrl?: string,
): Promise<{ id: string; title: string; url: string }> {
  const drive = await getDriveClient()

  const requestBody: { name: string; mimeType: string; parents?: string[] } = {
    name: title,
    mimeType: 'application/vnd.google-apps.spreadsheet',
  }
  if (folderIdOrUrl) {
    requestBody.parents = [extractFolderId(folderIdOrUrl)]
  }

  const response = await drive.files.create({
    requestBody,
    fields: 'id, name',
  })

  const id = response.data.id || ''
  return {
    id,
    title: response.data.name || title,
    url: `https://docs.google.com/spreadsheets/d/${id}/edit`,
  }
}

export async function copySheet(
  spreadsheetIdOrUrl: string,
  title?: string,
  folderIdOrUrl?: string,
): Promise<{ id: string; title: string; url: string }> {
  const spreadsheetId = extractSpreadsheetId(spreadsheetIdOrUrl)
  const drive = await getDriveClient()

  const requestBody: { name?: string; parents?: string[] } = {}
  if (title) {
    requestBody.name = title
  }
  if (folderIdOrUrl) {
    requestBody.parents = [extractFolderId(folderIdOrUrl)]
  }

  const response = await drive.files.copy({
    fileId: spreadsheetId,
    requestBody,
    fields: 'id, name',
  })

  const id = response.data.id || ''
  return {
    id,
    title: response.data.name || title || 'Copy',
    url: `https://docs.google.com/spreadsheets/d/${id}/edit`,
  }
}

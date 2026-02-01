import { getSheetsClient } from '../auth.js';
import {
  cacheFormulas,
  cacheDimensions,
  getCachedRange,
  hasReadRange,
  invalidateRange,
  parseRange,
  NotReadError,
  ConcurrentModificationError,
} from './concurrency.js';

// Extract spreadsheet ID from URL or return as-is if already an ID
function extractSpreadsheetId(idOrUrl: string): string {
  // Handle full URLs like https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit
  const urlMatch = idOrUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (urlMatch) {
    return urlMatch[1];
  }
  // Assume it's already an ID
  return idOrUrl;
}

export interface SheetInfo {
  id: string;
  title: string;
  sheets: { id: number; title: string; rowCount: number; columnCount: number }[];
}

export interface SheetContent {
  id: string;
  title: string;
  sheetTitle: string;
  content: string;
  rowCount: number;
  columnCount: number;
}

export async function getSheetInfo(spreadsheetIdOrUrl: string): Promise<SheetInfo> {
  const spreadsheetId = extractSpreadsheetId(spreadsheetIdOrUrl);
  const sheets = await getSheetsClient();

  const response = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'properties.title,sheets.properties',
  });

  const data = response.data;
  return {
    id: spreadsheetId,
    title: data.properties?.title || 'Untitled',
    sheets: (data.sheets || []).map(s => ({
      id: s.properties?.sheetId || 0,
      title: s.properties?.title || 'Sheet',
      rowCount: s.properties?.gridProperties?.rowCount || 0,
      columnCount: s.properties?.gridProperties?.columnCount || 0,
    })),
  };
}

export async function readSheet(
  spreadsheetIdOrUrl: string,
  sheetName?: string,
  range?: string
): Promise<SheetContent> {
  const spreadsheetId = extractSpreadsheetId(spreadsheetIdOrUrl);
  const sheets = await getSheetsClient();

  // Get spreadsheet metadata first
  const metaResponse = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'properties.title,sheets.properties',
  });

  const spreadsheetTitle = metaResponse.data.properties?.title || 'Untitled';
  const sheetsList = metaResponse.data.sheets || [];

  // Determine which sheet to read
  let targetSheet = sheetsList[0];
  if (sheetName) {
    const found = sheetsList.find(s => s.properties?.title === sheetName);
    if (!found) {
      const available = sheetsList.map(s => s.properties?.title).join(', ');
      throw new Error(`Sheet "${sheetName}" not found. Available: ${available}`);
    }
    targetSheet = found;
  }

  const sheetTitle = targetSheet.properties?.title || 'Sheet1';
  // Don't prefix if range already includes sheet name (has !)
  const readRange = range
    ? range.includes('!') ? range : `${sheetTitle}!${range}`
    : sheetTitle;

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
  ]);

  const rows = valuesResponse.data.values || [];
  const formulas = formulasResponse.data.values || [];

  // Cache formulas for concurrency control
  // Determine start position from range
  const parsed = parseRange(readRange);
  const startCol = parsed?.startCol || 1;
  const startRow = parsed?.startRow || 1;
  cacheFormulas(spreadsheetId, sheetTitle, startCol, startRow, formulas);

  // Cache sheet dimensions
  cacheDimensions(
    spreadsheetId,
    sheetsList.map(s => ({
      title: s.properties?.title || 'Sheet',
      rows: s.properties?.gridProperties?.rowCount || 0,
      cols: s.properties?.gridProperties?.columnCount || 0,
    }))
  );

  // Convert to markdown table
  let content: string;
  if (rows.length === 0) {
    content = '(empty sheet)';
  } else {
    const lines: string[] = [];

    // Find max columns across all rows
    const maxCols = Math.max(...rows.map(r => r.length));

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      // Pad row to max columns
      const cells = Array(maxCols).fill('').map((_, j) => String(row[j] ?? ''));
      lines.push(`| ${cells.join(' | ')} |`);

      // Add header separator after first row
      if (i === 0) {
        lines.push(`| ${cells.map(() => '---').join(' | ')} |`);
      }
    }

    content = lines.join('\n');
  }

  return {
    id: spreadsheetId,
    title: spreadsheetTitle,
    sheetTitle,
    content,
    rowCount: rows.length,
    columnCount: rows.length > 0 ? Math.max(...rows.map(r => r.length)) : 0,
  };
}

export async function editSheet(
  spreadsheetIdOrUrl: string,
  range: string,
  values: string[][],
  sheetName?: string
): Promise<{ success: boolean; message: string; updatedCells: number }> {
  const spreadsheetId = extractSpreadsheetId(spreadsheetIdOrUrl);
  const sheets = await getSheetsClient();

  // Build full range with sheet name if provided
  const fullRange = sheetName ? `${sheetName}!${range}` : range;

  // Determine default sheet name if not provided
  let defaultSheetName = sheetName;
  if (!defaultSheetName && !range.includes('!')) {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets.properties.title',
    });
    defaultSheetName = meta.data.sheets?.[0]?.properties?.title || 'Sheet1';
  }

  // Check if cells were read first
  if (!hasReadRange(spreadsheetId, fullRange, defaultSheetName)) {
    throw new NotReadError(spreadsheetId, fullRange);
  }

  // Get cached formulas for comparison
  const cachedFormulas = getCachedRange(spreadsheetId, fullRange, defaultSheetName);
  if (!cachedFormulas) {
    throw new NotReadError(spreadsheetId, fullRange);
  }

  // Fetch current formulas to check for concurrent modifications
  const currentFormulasResponse = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: fullRange,
    valueRenderOption: 'FORMULA',
  });
  const currentFormulas = currentFormulasResponse.data.values || [];

  // Compare formulas
  const changedCells: string[] = [];
  const parsed = parseRange(fullRange);
  if (parsed) {
    const resolvedSheet = parsed.sheetName || defaultSheetName || 'Sheet1';
    for (let rowIdx = 0; rowIdx < currentFormulas.length; rowIdx++) {
      const row = currentFormulas[rowIdx] || [];
      for (let colIdx = 0; colIdx < row.length; colIdx++) {
        const col = parsed.startCol + colIdx;
        const rowNum = parsed.startRow + rowIdx;
        const ref = `${resolvedSheet}!${columnToLetter(col)}${rowNum}`;

        const currentVal = row[colIdx];
        const currentFormula = currentVal?.startsWith?.('=') ? currentVal : null;
        const cachedFormula = cachedFormulas.get(ref);

        if (currentFormula !== cachedFormula) {
          changedCells.push(ref);
        }
      }
    }
  }

  if (changedCells.length > 0) {
    invalidateRange(spreadsheetId, fullRange, defaultSheetName);
    throw new ConcurrentModificationError(changedCells);
  }

  // All checks passed, perform the update
  const response = await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: fullRange,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values,
    },
  });

  // Update cache with new formulas
  const newFormulas = values.map(row => row.map(cell => cell?.startsWith?.('=') ? cell : null));
  if (parsed) {
    const resolvedSheet = parsed.sheetName || defaultSheetName || 'Sheet1';
    cacheFormulas(spreadsheetId, resolvedSheet, parsed.startCol, parsed.startRow, values);
  }

  const updatedCells = response.data.updatedCells || 0;
  return {
    success: true,
    message: `Updated ${updatedCells} cell${updatedCells !== 1 ? 's' : ''} in ${fullRange}`,
    updatedCells,
  };
}

// Helper to convert column number to letter
function columnToLetter(col: number): string {
  let result = '';
  while (col > 0) {
    col--;
    result = String.fromCharCode((col % 26) + 65) + result;
    col = Math.floor(col / 26);
  }
  return result;
}

export async function appendSheet(
  spreadsheetIdOrUrl: string,
  values: string[][],
  sheetName?: string
): Promise<{ success: boolean; message: string; updatedRange: string }> {
  const spreadsheetId = extractSpreadsheetId(spreadsheetIdOrUrl);
  const sheets = await getSheetsClient();

  // If no sheet name, get the first sheet
  let targetRange = sheetName || 'Sheet1';
  if (!sheetName) {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets.properties.title',
    });
    targetRange = meta.data.sheets?.[0]?.properties?.title || 'Sheet1';
  }

  const response = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: targetRange,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values,
    },
  });

  const updatedRange = response.data.updates?.updatedRange || targetRange;
  const updatedRows = response.data.updates?.updatedRows || values.length;

  return {
    success: true,
    message: `Appended ${updatedRows} row${updatedRows !== 1 ? 's' : ''} to ${updatedRange}`,
    updatedRange,
  };
}

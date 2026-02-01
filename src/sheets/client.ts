import { getSheetsClient } from '../auth.js';

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
  const readRange = range ? `${sheetTitle}!${range}` : sheetTitle;

  // Read the data
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: readRange,
  });

  const rows = response.data.values || [];

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

  const response = await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: fullRange,
    valueInputOption: 'USER_ENTERED', // Allows formulas and auto-formatting
    requestBody: {
      values,
    },
  });

  const updatedCells = response.data.updatedCells || 0;
  return {
    success: true,
    message: `Updated ${updatedCells} cell${updatedCells !== 1 ? 's' : ''} in ${fullRange}`,
    updatedCells,
  };
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

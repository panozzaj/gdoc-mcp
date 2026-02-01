/**
 * Concurrency control for Google Sheets.
 *
 * Uses hybrid approach: read ranges, store per-cell.
 * Tracks formulas (not computed values) to allow writes when
 * only dependent values changed but formulas are the same.
 */

// Per-cell formula cache: spreadsheetId -> cellRef -> formula (or null for literals)
const cellCache = new Map<string, Map<string, string | null>>();

// Sheet dimensions cache for detecting deleted rows/cols
const dimensionsCache = new Map<string, { sheetTitle: string; rows: number; cols: number }[]>();

/**
 * Convert column number to letter (1 -> A, 26 -> Z, 27 -> AA)
 */
function columnToLetter(col: number): string {
  let result = '';
  while (col > 0) {
    col--;
    result = String.fromCharCode((col % 26) + 65) + result;
    col = Math.floor(col / 26);
  }
  return result;
}

/**
 * Parse a cell reference like "A1" into { col: 1, row: 1 }
 */
function parseCellRef(ref: string): { col: number; row: number } | null {
  const match = ref.match(/^([A-Z]+)(\d+)$/i);
  if (!match) return null;

  const colStr = match[1].toUpperCase();
  let col = 0;
  for (let i = 0; i < colStr.length; i++) {
    col = col * 26 + (colStr.charCodeAt(i) - 64);
  }

  return { col, row: parseInt(match[2], 10) };
}

/**
 * Parse a range like "A1:B2" or "Sheet1!A1:B2" into components.
 */
function parseRange(range: string): {
  sheetName?: string;
  startCol: number;
  startRow: number;
  endCol: number;
  endRow: number;
} | null {
  // Handle sheet prefix
  let sheetName: string | undefined;
  let rangeOnly = range;

  if (range.includes('!')) {
    const parts = range.split('!');
    sheetName = parts[0].replace(/^'|'$/g, ''); // Remove quotes if present
    rangeOnly = parts[1];
  }

  // Handle single cell vs range
  if (rangeOnly.includes(':')) {
    const [startRef, endRef] = rangeOnly.split(':');
    const start = parseCellRef(startRef);
    const end = parseCellRef(endRef);
    if (!start || !end) return null;
    return { sheetName, startCol: start.col, startRow: start.row, endCol: end.col, endRow: end.row };
  } else {
    const cell = parseCellRef(rangeOnly);
    if (!cell) return null;
    return { sheetName, startCol: cell.col, startRow: cell.row, endCol: cell.col, endRow: cell.row };
  }
}

/**
 * Generate cell reference from column and row numbers.
 */
function cellRef(col: number, row: number): string {
  return `${columnToLetter(col)}${row}`;
}

/**
 * Cache formulas for cells read from a range.
 * formulas is a 2D array where each cell is either a formula string (starting with =) or a value.
 */
export function cacheFormulas(
  spreadsheetId: string,
  sheetName: string,
  startCol: number,
  startRow: number,
  formulas: (string | null)[][]
): void {
  if (!cellCache.has(spreadsheetId)) {
    cellCache.set(spreadsheetId, new Map());
  }
  const cache = cellCache.get(spreadsheetId)!;

  for (let rowIdx = 0; rowIdx < formulas.length; rowIdx++) {
    const row = formulas[rowIdx];
    for (let colIdx = 0; colIdx < row.length; colIdx++) {
      const cell = row[colIdx];
      const ref = `${sheetName}!${cellRef(startCol + colIdx, startRow + rowIdx)}`;
      // Store formula if starts with =, otherwise store null (literal value)
      // Cell can be number/boolean/etc from API, so convert to string first
      const cellStr = cell != null ? String(cell) : null;
      cache.set(ref, cellStr?.startsWith('=') ? cellStr : null);
    }
  }
}

/**
 * Cache sheet dimensions for detecting structural changes.
 */
export function cacheDimensions(
  spreadsheetId: string,
  sheets: { title: string; rows: number; cols: number }[]
): void {
  dimensionsCache.set(spreadsheetId, sheets.map(s => ({
    sheetTitle: s.title,
    rows: s.rows,
    cols: s.cols,
  })));
}

/**
 * Get cached formula for a cell.
 * Returns undefined if cell was never read.
 */
export function getCachedFormula(
  spreadsheetId: string,
  sheetName: string,
  col: number,
  row: number
): string | null | undefined {
  const cache = cellCache.get(spreadsheetId);
  if (!cache) return undefined;

  const ref = `${sheetName}!${cellRef(col, row)}`;
  if (!cache.has(ref)) return undefined;
  return cache.get(ref);
}

/**
 * Check if we have cached data for cells in a range.
 */
export function hasReadRange(
  spreadsheetId: string,
  range: string,
  defaultSheetName?: string
): boolean {
  const cache = cellCache.get(spreadsheetId);
  if (!cache) return false;

  const parsed = parseRange(range);
  if (!parsed) return false;

  const sheetName = parsed.sheetName || defaultSheetName || 'Sheet1';

  // Check if all cells in range are cached
  for (let row = parsed.startRow; row <= parsed.endRow; row++) {
    for (let col = parsed.startCol; col <= parsed.endCol; col++) {
      const ref = `${sheetName}!${cellRef(col, row)}`;
      if (!cache.has(ref)) return false;
    }
  }
  return true;
}

/**
 * Get cached formulas for a range.
 * Returns undefined if any cell in range wasn't read.
 */
export function getCachedRange(
  spreadsheetId: string,
  range: string,
  defaultSheetName?: string
): Map<string, string | null> | undefined {
  const cache = cellCache.get(spreadsheetId);
  if (!cache) return undefined;

  const parsed = parseRange(range);
  if (!parsed) return undefined;

  const sheetName = parsed.sheetName || defaultSheetName || 'Sheet1';
  const result = new Map<string, string | null>();

  for (let row = parsed.startRow; row <= parsed.endRow; row++) {
    for (let col = parsed.startCol; col <= parsed.endCol; col++) {
      const ref = `${sheetName}!${cellRef(col, row)}`;
      if (!cache.has(ref)) return undefined;
      result.set(ref, cache.get(ref)!);
    }
  }
  return result;
}

/**
 * Invalidate cached data for cells that may have changed.
 * Call this when a write fails due to concurrent modification.
 */
export function invalidateRange(
  spreadsheetId: string,
  range: string,
  defaultSheetName?: string
): void {
  const cache = cellCache.get(spreadsheetId);
  if (!cache) return;

  const parsed = parseRange(range);
  if (!parsed) return;

  const sheetName = parsed.sheetName || defaultSheetName || 'Sheet1';

  for (let row = parsed.startRow; row <= parsed.endRow; row++) {
    for (let col = parsed.startCol; col <= parsed.endCol; col++) {
      const ref = `${sheetName}!${cellRef(col, row)}`;
      cache.delete(ref);
    }
  }
}

/**
 * Clear all cached data for a spreadsheet.
 */
export function clearCache(spreadsheetId: string): void {
  cellCache.delete(spreadsheetId);
  dimensionsCache.delete(spreadsheetId);
}

/**
 * Error thrown when trying to edit cells that weren't read first.
 */
export class NotReadError extends Error {
  constructor(spreadsheetId: string, range: string) {
    super(
      `Must read cells before editing. Use gsheet_read first to read the range "${range}".`
    );
    this.name = 'NotReadError';
  }
}

/**
 * Error thrown when cells have been modified since last read.
 */
export class ConcurrentModificationError extends Error {
  constructor(changedCells: string[]) {
    const cellList = changedCells.slice(0, 5).join(', ');
    const more = changedCells.length > 5 ? ` and ${changedCells.length - 5} more` : '';
    super(
      `Cells have been modified since last read: ${cellList}${more}. ` +
      `Use gsheet_read to get the latest data before editing.`
    );
    this.name = 'ConcurrentModificationError';
  }
}

export { parseRange, cellRef, columnToLetter };

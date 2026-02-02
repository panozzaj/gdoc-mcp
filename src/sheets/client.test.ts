import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getSheetInfo, readSheet, editSheet, appendSheet } from './client.js';
import { clearCache, NotReadError, ConcurrentModificationError } from './concurrency.js';

// Mock the auth module
vi.mock('../auth.js', () => ({
  getSheetsClient: vi.fn(),
}));

import { getSheetsClient } from '../auth.js';

// Helper to create mock spreadsheet metadata
function createMockMeta(title: string = 'Test Spreadsheet', sheets: { title: string; rows?: number; cols?: number }[] = [{ title: 'Sheet1' }]) {
  return {
    properties: { title },
    sheets: sheets.map((s, i) => ({
      properties: {
        sheetId: i,
        title: s.title,
        gridProperties: {
          rowCount: s.rows ?? 1000,
          columnCount: s.cols ?? 26,
        },
      },
    })),
  };
}

describe('Google Sheets Client', () => {
  let mockSheetsClient: {
    spreadsheets: {
      get: ReturnType<typeof vi.fn>;
      values: {
        get: ReturnType<typeof vi.fn>;
        update: ReturnType<typeof vi.fn>;
        append: ReturnType<typeof vi.fn>;
      };
    };
  };

  beforeEach(() => {
    clearCache('test-spreadsheet-id');

    mockSheetsClient = {
      spreadsheets: {
        get: vi.fn(),
        values: {
          get: vi.fn(),
          update: vi.fn(),
          append: vi.fn(),
        },
      },
    };

    vi.mocked(getSheetsClient).mockResolvedValue(mockSheetsClient as any);
  });

  describe('getSheetInfo', () => {
    it('returns spreadsheet metadata', async () => {
      mockSheetsClient.spreadsheets.get.mockResolvedValue({
        data: createMockMeta('My Spreadsheet', [
          { title: 'Sheet1', rows: 100, cols: 10 },
          { title: 'Sheet2', rows: 50, cols: 5 },
        ]),
      });

      const result = await getSheetInfo('test-spreadsheet-id');

      expect(result.id).toBe('test-spreadsheet-id');
      expect(result.title).toBe('My Spreadsheet');
      expect(result.sheets).toHaveLength(2);
      expect(result.sheets[0]).toEqual({
        id: 0,
        title: 'Sheet1',
        rowCount: 100,
        columnCount: 10,
      });
    });

    it('extracts ID from full URL', async () => {
      mockSheetsClient.spreadsheets.get.mockResolvedValue({
        data: createMockMeta(),
      });

      await getSheetInfo('https://docs.google.com/spreadsheets/d/abc123xyz/edit#gid=0');

      expect(mockSheetsClient.spreadsheets.get).toHaveBeenCalledWith(
        expect.objectContaining({ spreadsheetId: 'abc123xyz' })
      );
    });
  });

  describe('readSheet', () => {
    it('returns sheet content as markdown table', async () => {
      mockSheetsClient.spreadsheets.get.mockResolvedValue({
        data: createMockMeta(),
      });
      mockSheetsClient.spreadsheets.values.get
        .mockResolvedValueOnce({
          data: { values: [['Name', 'Age'], ['Alice', '30'], ['Bob', '25']] },
        })
        .mockResolvedValueOnce({
          data: { values: [['Name', 'Age'], ['Alice', '30'], ['Bob', '25']] },
        });

      const result = await readSheet('test-spreadsheet-id');

      expect(result.content).toContain('| Name | Age |');
      expect(result.content).toContain('| --- | --- |');
      expect(result.content).toContain('| Alice | 30 |');
      expect(result.content).toContain('| Bob | 25 |');
    });

    it('handles empty sheet', async () => {
      mockSheetsClient.spreadsheets.get.mockResolvedValue({
        data: createMockMeta(),
      });
      mockSheetsClient.spreadsheets.values.get.mockResolvedValue({
        data: { values: [] },
      });

      const result = await readSheet('test-spreadsheet-id');

      expect(result.content).toBe('(empty sheet)');
    });

    it('reads specific sheet by name', async () => {
      mockSheetsClient.spreadsheets.get.mockResolvedValue({
        data: createMockMeta('Test', [{ title: 'Sheet1' }, { title: 'Data' }]),
      });
      mockSheetsClient.spreadsheets.values.get.mockResolvedValue({
        data: { values: [['A', 'B']] },
      });

      await readSheet('test-spreadsheet-id', 'Data');

      expect(mockSheetsClient.spreadsheets.values.get).toHaveBeenCalledWith(
        expect.objectContaining({ range: 'Data' })
      );
    });

    it('throws error for non-existent sheet', async () => {
      mockSheetsClient.spreadsheets.get.mockResolvedValue({
        data: createMockMeta('Test', [{ title: 'Sheet1' }]),
      });

      await expect(readSheet('test-spreadsheet-id', 'NonExistent')).rejects.toThrow(
        'Sheet "NonExistent" not found'
      );
    });

    it('reads specific range', async () => {
      mockSheetsClient.spreadsheets.get.mockResolvedValue({
        data: createMockMeta(),
      });
      mockSheetsClient.spreadsheets.values.get.mockResolvedValue({
        data: { values: [['A1', 'B1']] },
      });

      await readSheet('test-spreadsheet-id', undefined, 'A1:B1');

      expect(mockSheetsClient.spreadsheets.values.get).toHaveBeenCalledWith(
        expect.objectContaining({ range: 'Sheet1!A1:B1' })
      );
    });

    it('throws error when range exceeds sheet row bounds', async () => {
      mockSheetsClient.spreadsheets.get.mockResolvedValue({
        data: createMockMeta('Test', [{ title: 'Sheet1', rows: 10, cols: 5 }]),
      });

      await expect(
        readSheet('test-spreadsheet-id', undefined, 'A1:A20')
      ).rejects.toThrow('Range exceeds sheet bounds: requested row 20 but sheet "Sheet1" only has 10 rows');
    });

    it('throws error when range exceeds sheet column bounds', async () => {
      mockSheetsClient.spreadsheets.get.mockResolvedValue({
        data: createMockMeta('Test', [{ title: 'Sheet1', rows: 100, cols: 3 }]),
      });

      await expect(
        readSheet('test-spreadsheet-id', undefined, 'A1:E1')
      ).rejects.toThrow('Range exceeds sheet bounds: requested column 5 but sheet "Sheet1" only has 3 columns');
    });

    it('pads empty trailing rows and columns to match requested range', async () => {
      mockSheetsClient.spreadsheets.get.mockResolvedValue({
        data: createMockMeta('Test', [{ title: 'Sheet1', rows: 100, cols: 26 }]),
      });
      // Google Sheets API truncates trailing empty rows/cols
      mockSheetsClient.spreadsheets.values.get.mockResolvedValue({
        data: { values: [['A1', 'B1']] }, // Only 1 row, 2 cols returned
      });

      const result = await readSheet('test-spreadsheet-id', undefined, 'A1:C3');

      // Should be padded to 3 rows × 3 cols
      expect(result.rowCount).toBe(3);
      expect(result.columnCount).toBe(3);
      expect(result.content).toContain('| A1 | B1 |  |'); // First row with padding
      expect(result.content).toContain('|  |  |  |'); // Empty rows
    });

    it('does not double-prefix range that already contains sheet name', async () => {
      mockSheetsClient.spreadsheets.get.mockResolvedValue({
        data: createMockMeta('Test', [{ title: 'Data' }, { title: '2025' }]),
      });
      mockSheetsClient.spreadsheets.values.get.mockResolvedValue({
        data: { values: [['A1']] },
      });

      // Range already has sheet prefix - should not become "Data!2025!A1:E20"
      await readSheet('test-spreadsheet-id', undefined, '2025!A1:E20');

      expect(mockSheetsClient.spreadsheets.values.get).toHaveBeenCalledWith(
        expect.objectContaining({ range: '2025!A1:E20' })
      );
    });

    it('caches formulas for concurrency control', async () => {
      mockSheetsClient.spreadsheets.get.mockResolvedValue({
        data: createMockMeta(),
      });
      // readSheet calls values.get twice, editSheet calls once more
      mockSheetsClient.spreadsheets.values.get.mockResolvedValue({
        data: { values: [['=A2+B2']] },
      });

      // Read specific range so caching works properly
      await readSheet('test-spreadsheet-id', undefined, 'A1');

      // Now editing should work (cells are cached)
      mockSheetsClient.spreadsheets.values.update.mockResolvedValue({
        data: { updatedCells: 1 },
      });

      const result = await editSheet('test-spreadsheet-id', 'A1', [['300']]);
      expect(result.success).toBe(true);
    });
  });

  describe('editSheet', () => {
    it('fails with NotReadError when cells not read first', async () => {
      // editSheet needs metadata to get default sheet name
      mockSheetsClient.spreadsheets.get.mockResolvedValue({
        data: createMockMeta(),
      });

      await expect(
        editSheet('test-spreadsheet-id', 'A1', [['new value']])
      ).rejects.toThrow(NotReadError);
    });

    it('succeeds after reading cells', async () => {
      mockSheetsClient.spreadsheets.get.mockResolvedValue({
        data: createMockMeta(),
      });
      mockSheetsClient.spreadsheets.values.get.mockResolvedValue({
        data: { values: [['old value']] },
      });

      // Read specific range before editing
      await readSheet('test-spreadsheet-id', undefined, 'A1');

      mockSheetsClient.spreadsheets.values.update.mockResolvedValue({
        data: { updatedCells: 1 },
      });

      const result = await editSheet('test-spreadsheet-id', 'A1', [['new value']]);

      expect(result.success).toBe(true);
      expect(result.updatedCells).toBe(1);
    });

    it('detects concurrent formula changes', async () => {
      mockSheetsClient.spreadsheets.get.mockResolvedValue({
        data: createMockMeta(),
      });
      // readSheet: formatted values, then formulas
      mockSheetsClient.spreadsheets.values.get
        .mockResolvedValueOnce({ data: { values: [['100']] } })
        .mockResolvedValueOnce({ data: { values: [['=A2+B2']] } });

      await readSheet('test-spreadsheet-id', undefined, 'A1');

      // editSheet checks current formulas - someone changed it
      mockSheetsClient.spreadsheets.values.get.mockResolvedValue({
        data: { values: [['=A2*B2']] }, // different formula!
      });

      await expect(
        editSheet('test-spreadsheet-id', 'A1', [['999']])
      ).rejects.toThrow(ConcurrentModificationError);
    });

    it('allows edit when only computed values changed (formula same)', async () => {
      mockSheetsClient.spreadsheets.get.mockResolvedValue({
        data: createMockMeta(),
      });
      mockSheetsClient.spreadsheets.values.get
        .mockResolvedValueOnce({ data: { values: [['100']] } })
        .mockResolvedValueOnce({ data: { values: [['=A2+B2']] } });

      await readSheet('test-spreadsheet-id', undefined, 'A1');

      // editSheet: same formula (computed value may differ, that's ok)
      mockSheetsClient.spreadsheets.values.get.mockResolvedValue({
        data: { values: [['=A2+B2']] },
      });
      mockSheetsClient.spreadsheets.values.update.mockResolvedValue({
        data: { updatedCells: 1 },
      });

      const result = await editSheet('test-spreadsheet-id', 'A1', [['new']]);
      expect(result.success).toBe(true);
    });

    it('updates multiple cells', async () => {
      mockSheetsClient.spreadsheets.get.mockResolvedValue({
        data: createMockMeta(),
      });
      mockSheetsClient.spreadsheets.values.get.mockResolvedValue({
        data: { values: [['a', 'b'], ['c', 'd']] },
      });

      // Read the exact range we'll edit
      await readSheet('test-spreadsheet-id', undefined, 'A1:B2');

      mockSheetsClient.spreadsheets.values.update.mockResolvedValue({
        data: { updatedCells: 4 },
      });

      const result = await editSheet('test-spreadsheet-id', 'A1:B2', [
        ['1', '2'],
        ['3', '4'],
      ]);

      expect(result.success).toBe(true);
      expect(result.message).toContain('4 cells');
    });
  });

  describe('appendSheet', () => {
    it('appends rows to sheet', async () => {
      mockSheetsClient.spreadsheets.get.mockResolvedValue({
        data: createMockMeta(),
      });
      mockSheetsClient.spreadsheets.values.append.mockResolvedValue({
        data: {
          updates: {
            updatedRange: 'Sheet1!A5:B6',
            updatedRows: 2,
          },
        },
      });

      const result = await appendSheet('test-spreadsheet-id', [
        ['new row 1 col A', 'new row 1 col B'],
        ['new row 2 col A', 'new row 2 col B'],
      ]);

      expect(result.success).toBe(true);
      expect(result.message).toContain('2 rows');
      expect(result.updatedRange).toBe('Sheet1!A5:B6');
    });

    it('appends to specific sheet', async () => {
      mockSheetsClient.spreadsheets.values.append.mockResolvedValue({
        data: { updates: { updatedRange: 'Data!A10', updatedRows: 1 } },
      });

      await appendSheet('test-spreadsheet-id', [['value']], 'Data');

      expect(mockSheetsClient.spreadsheets.values.append).toHaveBeenCalledWith(
        expect.objectContaining({ range: 'Data' })
      );
    });

    it('uses first sheet when no sheet specified', async () => {
      mockSheetsClient.spreadsheets.get.mockResolvedValue({
        data: createMockMeta('Test', [{ title: 'FirstSheet' }]),
      });
      mockSheetsClient.spreadsheets.values.append.mockResolvedValue({
        data: { updates: { updatedRange: 'FirstSheet!A1', updatedRows: 1 } },
      });

      await appendSheet('test-spreadsheet-id', [['value']]);

      expect(mockSheetsClient.spreadsheets.values.append).toHaveBeenCalledWith(
        expect.objectContaining({ range: 'FirstSheet' })
      );
    });
  });
});

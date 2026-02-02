import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseRange,
  columnToLetter,
  cellRef,
  cacheFormulas,
  getCachedFormula,
  cacheDimensions,
  cacheSheetNames,
  detectSheetRename,
  migrateCacheForRename,
  hasReadRange,
  getCachedRange,
  invalidateRange,
  clearCache,
  NotReadError,
  ConcurrentModificationError,
} from './concurrency.js';

describe('Sheets Concurrency', () => {
  beforeEach(() => {
    clearCache('test-spreadsheet');
  });

  describe('columnToLetter', () => {
    it('converts single-letter columns', () => {
      expect(columnToLetter(1)).toBe('A');
      expect(columnToLetter(26)).toBe('Z');
    });

    it('converts multi-letter columns', () => {
      expect(columnToLetter(27)).toBe('AA');
      expect(columnToLetter(28)).toBe('AB');
      expect(columnToLetter(52)).toBe('AZ');
      expect(columnToLetter(53)).toBe('BA');
      expect(columnToLetter(702)).toBe('ZZ');
      expect(columnToLetter(703)).toBe('AAA');
    });
  });

  describe('cellRef', () => {
    it('generates cell references', () => {
      expect(cellRef(1, 1)).toBe('A1');
      expect(cellRef(3, 5)).toBe('C5');
      expect(cellRef(27, 100)).toBe('AA100');
    });
  });

  describe('parseRange', () => {
    it('parses single cell', () => {
      const result = parseRange('A1');
      expect(result).toEqual({
        sheetName: undefined,
        startCol: 1,
        startRow: 1,
        endCol: 1,
        endRow: 1,
      });
    });

    it('parses cell range', () => {
      const result = parseRange('A1:C3');
      expect(result).toEqual({
        sheetName: undefined,
        startCol: 1,
        startRow: 1,
        endCol: 3,
        endRow: 3,
      });
    });

    it('parses range with sheet name', () => {
      const result = parseRange('Sheet1!A1:B2');
      expect(result).toEqual({
        sheetName: 'Sheet1',
        startCol: 1,
        startRow: 1,
        endCol: 2,
        endRow: 2,
      });
    });

    it('parses range with quoted sheet name', () => {
      const result = parseRange("'My Sheet'!A1:B2");
      expect(result).toEqual({
        sheetName: 'My Sheet',
        startCol: 1,
        startRow: 1,
        endCol: 2,
        endRow: 2,
      });
    });

    it('returns null for invalid range', () => {
      expect(parseRange('invalid')).toBeNull();
      expect(parseRange('')).toBeNull();
    });
  });

  describe('formula caching', () => {
    it('caches formulas for cells', () => {
      cacheFormulas('test-spreadsheet', 'Sheet1', 1, 1, [
        ['=A2+B2', 'plain value'],
        ['=SUM(A1:A10)', null],
      ]);

      expect(getCachedFormula('test-spreadsheet', 'Sheet1', 1, 1)).toBe('=A2+B2');
      expect(getCachedFormula('test-spreadsheet', 'Sheet1', 2, 1)).toBeNull(); // plain value
      expect(getCachedFormula('test-spreadsheet', 'Sheet1', 1, 2)).toBe('=SUM(A1:A10)');
      expect(getCachedFormula('test-spreadsheet', 'Sheet1', 2, 2)).toBeNull(); // null
    });

    it('handles numeric cell values (not strings)', () => {
      // Sheets API can return numbers, booleans, etc. - not just strings
      cacheFormulas('test-spreadsheet', 'Sheet1', 1, 1, [
        [123, 45.67, true, null] as any,
      ]);

      // All non-formula values should be cached as null
      expect(getCachedFormula('test-spreadsheet', 'Sheet1', 1, 1)).toBeNull();
      expect(getCachedFormula('test-spreadsheet', 'Sheet1', 2, 1)).toBeNull();
      expect(getCachedFormula('test-spreadsheet', 'Sheet1', 3, 1)).toBeNull();
      expect(getCachedFormula('test-spreadsheet', 'Sheet1', 4, 1)).toBeNull();
    });

    it('returns undefined for cells not read', () => {
      expect(getCachedFormula('test-spreadsheet', 'Sheet1', 1, 1)).toBeUndefined();
    });

    it('returns undefined for unknown spreadsheet', () => {
      expect(getCachedFormula('unknown', 'Sheet1', 1, 1)).toBeUndefined();
    });
  });

  describe('hasReadRange', () => {
    it('returns false when no cells cached', () => {
      expect(hasReadRange('test-spreadsheet', 'A1:B2')).toBe(false);
    });

    it('returns true when all cells in range are cached', () => {
      cacheFormulas('test-spreadsheet', 'Sheet1', 1, 1, [
        ['a', 'b'],
        ['c', 'd'],
      ]);

      expect(hasReadRange('test-spreadsheet', 'A1:B2', 'Sheet1')).toBe(true);
    });

    it('returns false when some cells in range are not cached', () => {
      cacheFormulas('test-spreadsheet', 'Sheet1', 1, 1, [['a']]);

      expect(hasReadRange('test-spreadsheet', 'A1:B2', 'Sheet1')).toBe(false);
    });

    it('uses sheet name from range if provided', () => {
      cacheFormulas('test-spreadsheet', 'Sheet1', 1, 1, [['a']]);

      expect(hasReadRange('test-spreadsheet', 'Sheet1!A1')).toBe(true);
      expect(hasReadRange('test-spreadsheet', 'Sheet2!A1')).toBe(false);
    });
  });

  describe('getCachedRange', () => {
    it('returns map of cached formulas for range', () => {
      cacheFormulas('test-spreadsheet', 'Sheet1', 1, 1, [
        ['=A2', 'plain'],
      ]);

      const result = getCachedRange('test-spreadsheet', 'A1:B1', 'Sheet1');
      expect(result).toBeDefined();
      expect(result?.get('Sheet1!A1')).toBe('=A2');
      expect(result?.get('Sheet1!B1')).toBeNull();
    });

    it('returns undefined if any cell not cached', () => {
      cacheFormulas('test-spreadsheet', 'Sheet1', 1, 1, [['a']]);

      expect(getCachedRange('test-spreadsheet', 'A1:B2', 'Sheet1')).toBeUndefined();
    });
  });

  describe('invalidateRange', () => {
    it('removes cells from cache', () => {
      cacheFormulas('test-spreadsheet', 'Sheet1', 1, 1, [
        ['a', 'b'],
        ['c', 'd'],
      ]);

      invalidateRange('test-spreadsheet', 'A1:B1', 'Sheet1');

      expect(getCachedFormula('test-spreadsheet', 'Sheet1', 1, 1)).toBeUndefined();
      expect(getCachedFormula('test-spreadsheet', 'Sheet1', 2, 1)).toBeUndefined();
      // Row 2 should still be cached
      expect(getCachedFormula('test-spreadsheet', 'Sheet1', 1, 2)).toBeNull();
    });
  });

  describe('clearCache', () => {
    it('removes all cached data for spreadsheet', () => {
      cacheFormulas('test-spreadsheet', 'Sheet1', 1, 1, [['a']]);
      cacheDimensions('test-spreadsheet', [{ title: 'Sheet1', rows: 100, cols: 26 }]);

      clearCache('test-spreadsheet');

      expect(getCachedFormula('test-spreadsheet', 'Sheet1', 1, 1)).toBeUndefined();
    });
  });

  describe('NotReadError', () => {
    it('includes helpful message', () => {
      const error = new NotReadError('spreadsheet-123', 'A1:B2');
      expect(error.message).toContain('Must read cells before editing');
      expect(error.message).toContain('gsheet_read');
      expect(error.message).toContain('A1:B2');
      expect(error.name).toBe('NotReadError');
    });
  });

  describe('ConcurrentModificationError', () => {
    it('lists changed cells', () => {
      const error = new ConcurrentModificationError(['A1', 'B2', 'C3']);
      expect(error.message).toContain('A1');
      expect(error.message).toContain('B2');
      expect(error.message).toContain('C3');
      expect(error.message).toContain('modified since last read');
      expect(error.name).toBe('ConcurrentModificationError');
    });

    it('truncates long cell lists', () => {
      const cells = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'];
      const error = new ConcurrentModificationError(cells);
      expect(error.message).toContain('and 2 more');
    });
  });

  describe('sheet rename detection', () => {
    describe('cacheSheetNames and detectSheetRename', () => {
      it('detects no rename when sheet names match', () => {
        cacheSheetNames('test-spreadsheet', [
          { id: 0, title: 'Sheet1' },
          { id: 1, title: 'Sheet2' },
        ]);

        expect(detectSheetRename('test-spreadsheet', 'Sheet1', 0)).toBeNull();
        expect(detectSheetRename('test-spreadsheet', 'Sheet2', 1)).toBeNull();
      });

      it('detects rename when sheet name differs for same ID', () => {
        cacheSheetNames('test-spreadsheet', [
          { id: 0, title: 'OldName' },
        ]);

        const oldName = detectSheetRename('test-spreadsheet', 'NewName', 0);
        expect(oldName).toBe('OldName');
      });

      it('returns null when no cached names exist', () => {
        expect(detectSheetRename('unknown-spreadsheet', 'Sheet1', 0)).toBeNull();
      });

      it('returns null when sheet ID is not in cache', () => {
        cacheSheetNames('test-spreadsheet', [
          { id: 0, title: 'Sheet1' },
        ]);

        expect(detectSheetRename('test-spreadsheet', 'NewSheet', 999)).toBeNull();
      });
    });

    describe('migrateCacheForRename', () => {
      it('migrates cell cache entries from old name to new name', () => {
        cacheFormulas('test-spreadsheet', 'Tasks', 1, 1, [
          ['=A2+B2', 'value1'],
          ['=SUM(A1:A10)', 'value2'],
        ]);

        // Verify old names exist
        expect(getCachedFormula('test-spreadsheet', 'Tasks', 1, 1)).toBe('=A2+B2');
        expect(getCachedFormula('test-spreadsheet', 'Tasks', 2, 1)).toBeNull();

        // Migrate
        migrateCacheForRename('test-spreadsheet', 'Tasks', 'MyTasks');

        // Old names should no longer exist
        expect(getCachedFormula('test-spreadsheet', 'Tasks', 1, 1)).toBeUndefined();
        expect(getCachedFormula('test-spreadsheet', 'Tasks', 2, 1)).toBeUndefined();

        // New names should have the values
        expect(getCachedFormula('test-spreadsheet', 'MyTasks', 1, 1)).toBe('=A2+B2');
        expect(getCachedFormula('test-spreadsheet', 'MyTasks', 2, 1)).toBeNull();
        expect(getCachedFormula('test-spreadsheet', 'MyTasks', 1, 2)).toBe('=SUM(A1:A10)');
        expect(getCachedFormula('test-spreadsheet', 'MyTasks', 2, 2)).toBeNull();
      });

      it('updates sheet ID to name mapping', () => {
        cacheSheetNames('test-spreadsheet', [
          { id: 0, title: 'Tasks' },
        ]);

        migrateCacheForRename('test-spreadsheet', 'Tasks', 'MyTasks');

        // After migration, detecting rename should return null since mapping is updated
        expect(detectSheetRename('test-spreadsheet', 'MyTasks', 0)).toBeNull();
      });

      it('preserves other sheets in cache', () => {
        cacheFormulas('test-spreadsheet', 'Tasks', 1, 1, [['=A2']]);
        cacheFormulas('test-spreadsheet', 'Other', 1, 1, [['=B2']]);

        migrateCacheForRename('test-spreadsheet', 'Tasks', 'MyTasks');

        // Other sheet should be unchanged
        expect(getCachedFormula('test-spreadsheet', 'Other', 1, 1)).toBe('=B2');
        // Migrated sheet should work
        expect(getCachedFormula('test-spreadsheet', 'MyTasks', 1, 1)).toBe('=A2');
      });

      it('handles migration when no cache exists', () => {
        // Should not throw
        expect(() => migrateCacheForRename('unknown', 'Old', 'New')).not.toThrow();
      });
    });

    describe('hasReadRange after rename', () => {
      it('finds cells after migration', () => {
        cacheFormulas('test-spreadsheet', 'Tasks', 1, 1, [
          ['a', 'b'],
          ['c', 'd'],
        ]);

        // Before migration, old name works, new name doesn't
        expect(hasReadRange('test-spreadsheet', 'Tasks!A1:B2')).toBe(true);
        expect(hasReadRange('test-spreadsheet', 'MyTasks!A1:B2')).toBe(false);

        migrateCacheForRename('test-spreadsheet', 'Tasks', 'MyTasks');

        // After migration, new name works, old name doesn't
        expect(hasReadRange('test-spreadsheet', 'Tasks!A1:B2')).toBe(false);
        expect(hasReadRange('test-spreadsheet', 'MyTasks!A1:B2')).toBe(true);
      });
    });
  });
});

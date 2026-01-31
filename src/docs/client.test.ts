import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readDoc, editDoc } from './client.js';
import { clearCachedRevision } from './concurrency.js';
import { NotReadError } from './concurrency.js';

// Mock the auth module
vi.mock('../auth.js', () => ({
  getDocsClient: vi.fn(),
  getDriveClient: vi.fn(),
}));

import { getDocsClient } from '../auth.js';

// Helper to create a mock document
function createMockDoc(text: string, revisionId: string = 'rev-1') {
  return {
    documentId: 'test-doc-id',
    title: 'Test Document',
    revisionId,
    body: {
      content: [
        {
          paragraph: {
            elements: [
              {
                startIndex: 1,
                textRun: {
                  content: text,
                },
              },
            ],
          },
        },
      ],
    },
  };
}

describe('Google Docs Client', () => {
  let mockDocsClient: {
    documents: {
      get: ReturnType<typeof vi.fn>;
      batchUpdate: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(() => {
    // Clear revision cache between tests
    clearCachedRevision('test-doc-id');

    // Create fresh mock for each test
    mockDocsClient = {
      documents: {
        get: vi.fn(),
        batchUpdate: vi.fn(),
      },
    };

    vi.mocked(getDocsClient).mockResolvedValue(mockDocsClient as any);
  });

  describe('editDoc', () => {
    it('fails with NotReadError when doc has not been read first', async () => {
      await expect(editDoc('test-doc-id', 'old text', 'new text')).rejects.toThrow(
        NotReadError
      );
    });

    it('succeeds after reading the doc', async () => {
      const doc = createMockDoc('Hello world');
      mockDocsClient.documents.get.mockResolvedValue({ data: doc });
      mockDocsClient.documents.batchUpdate.mockResolvedValue({});

      // First read the doc
      await readDoc('test-doc-id');

      // Now edit should succeed
      const result = await editDoc('test-doc-id', 'Hello', 'Hi');

      expect(result.success).toBe(true);
      expect(mockDocsClient.documents.batchUpdate).toHaveBeenCalled();
    });

    it('succeeds even when a different part of the doc was modified (lenient concurrency)', async () => {
      // Initial read
      const docV1 = createMockDoc('Line 1\nLine 2\nLine 3', 'rev-1');
      mockDocsClient.documents.get.mockResolvedValueOnce({ data: docV1 });

      await readDoc('test-doc-id');

      // Someone else edits a different part - revision changes but our target text still exists
      const docV2 = createMockDoc('Line 1 (edited by someone)\nLine 2\nLine 3', 'rev-2');
      mockDocsClient.documents.get.mockResolvedValueOnce({ data: docV2 });
      mockDocsClient.documents.batchUpdate.mockResolvedValue({});

      // After batchUpdate, we fetch updated doc
      const docV3 = createMockDoc('Line 1 (edited by someone)\nLine 2 (my edit)\nLine 3', 'rev-3');
      mockDocsClient.documents.get.mockResolvedValueOnce({ data: docV3 });

      // Edit to Line 2 should still work
      const result = await editDoc('test-doc-id', 'Line 2', 'Line 2 (my edit)');

      expect(result.success).toBe(true);
    });

    it('fails when the target text no longer exists', async () => {
      // Initial read
      const docV1 = createMockDoc('Original text here', 'rev-1');
      mockDocsClient.documents.get.mockResolvedValueOnce({ data: docV1 });

      await readDoc('test-doc-id');

      // Someone else deletes our target text
      const docV2 = createMockDoc('Completely different content', 'rev-2');
      mockDocsClient.documents.get.mockResolvedValueOnce({ data: docV2 });

      // Edit should fail because target text doesn't exist
      await expect(
        editDoc('test-doc-id', 'Original text', 'Modified text')
      ).rejects.toThrow('Text not found in document');
    });

    it('succeeds after re-reading when target text was modified', async () => {
      // Initial read
      const docV1 = createMockDoc('Original text', 'rev-1');
      mockDocsClient.documents.get.mockResolvedValueOnce({ data: docV1 });

      await readDoc('test-doc-id');

      // Someone else modifies the text
      const docV2 = createMockDoc('Modified by someone', 'rev-2');
      mockDocsClient.documents.get.mockResolvedValueOnce({ data: docV2 });

      // First edit fails
      await expect(
        editDoc('test-doc-id', 'Original text', 'My change')
      ).rejects.toThrow('Text not found');

      // Re-read the document
      mockDocsClient.documents.get.mockResolvedValueOnce({ data: docV2 });
      await readDoc('test-doc-id');

      // Now we can edit the new content
      mockDocsClient.documents.get.mockResolvedValueOnce({ data: docV2 });
      mockDocsClient.documents.batchUpdate.mockResolvedValue({});

      const docV3 = createMockDoc('My change', 'rev-3');
      mockDocsClient.documents.get.mockResolvedValueOnce({ data: docV3 });

      const result = await editDoc('test-doc-id', 'Modified by someone', 'My change');
      expect(result.success).toBe(true);
    });

    it('fails when text appears multiple times (requires unique match)', async () => {
      // Document with repeated text
      const doc = createMockDoc('The quick brown fox\nThe lazy dog\nThe end', 'rev-1');
      mockDocsClient.documents.get.mockResolvedValue({ data: doc });

      await readDoc('test-doc-id');

      // Edit "The" should fail because it appears 3 times
      await expect(
        editDoc('test-doc-id', 'The', 'A')
      ).rejects.toThrow('appears 3 times');
    });

    it('error message suggests adding more context for ambiguous matches', async () => {
      const doc = createMockDoc('Hello world\nHello there', 'rev-1');
      mockDocsClient.documents.get.mockResolvedValue({ data: doc });

      await readDoc('test-doc-id');

      await expect(
        editDoc('test-doc-id', 'Hello', 'Hi')
      ).rejects.toThrow('Provide more surrounding context');
    });

    it('succeeds with unique match when more context provided', async () => {
      const doc = createMockDoc('Hello world\nHello there', 'rev-1');
      mockDocsClient.documents.get.mockResolvedValue({ data: doc });
      mockDocsClient.documents.batchUpdate.mockResolvedValue({});

      await readDoc('test-doc-id');

      // "Hello world" is unique, so this should work
      const result = await editDoc('test-doc-id', 'Hello world', 'Hi world');
      expect(result.success).toBe(true);
    });
  });

  describe('readDoc', () => {
    it('returns document content as markdown', async () => {
      const doc = createMockDoc('Hello world');
      mockDocsClient.documents.get.mockResolvedValue({ data: doc });

      const result = await readDoc('test-doc-id');

      expect(result.title).toBe('Test Document');
      expect(result.content).toContain('Hello world');
    });

    it('caches revision for subsequent edits', async () => {
      const doc = createMockDoc('Content', 'rev-123');
      mockDocsClient.documents.get.mockResolvedValue({ data: doc });

      await readDoc('test-doc-id');

      // Verify we can now edit (would fail without cached revision)
      mockDocsClient.documents.batchUpdate.mockResolvedValue({});

      const result = await editDoc('test-doc-id', 'Content', 'New content');
      expect(result.success).toBe(true);
    });
  });
});

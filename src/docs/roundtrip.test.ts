import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readDoc, editDoc } from './client.js';
import { clearCachedRevision } from './concurrency.js';

// Mock the auth module
vi.mock('../auth.js', () => ({
  getDocsClient: vi.fn(),
  getDriveClient: vi.fn(),
}));

import { getDocsClient } from '../auth.js';

// Helper to create a mock document with formatted text
function createFormattedDoc(elements: Array<{
  text: string;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  link?: string;
}>, revisionId = 'rev-1') {
  let currentIndex = 1;
  const paragraphElements = elements.map(el => {
    const startIndex = currentIndex;
    currentIndex += el.text.length;
    return {
      startIndex,
      endIndex: currentIndex,
      textRun: {
        content: el.text,
        textStyle: {
          bold: el.bold,
          italic: el.italic,
          strikethrough: el.strikethrough,
          link: el.link ? { url: el.link } : undefined,
        },
      },
    };
  });

  return {
    documentId: 'test-doc-id',
    title: 'Test Document',
    revisionId,
    body: {
      content: [
        {
          paragraph: {
            elements: paragraphElements,
          },
        },
      ],
    },
  };
}

describe('Round-trip tests: Document -> Markdown -> Document', () => {
  let mockDocsClient: {
    documents: {
      get: ReturnType<typeof vi.fn>;
      batchUpdate: ReturnType<typeof vi.fn>;
    };
  };
  let batchUpdateCalls: any[];

  beforeEach(() => {
    clearCachedRevision('test-doc-id');
    batchUpdateCalls = [];

    mockDocsClient = {
      documents: {
        get: vi.fn(),
        batchUpdate: vi.fn().mockImplementation((params) => {
          batchUpdateCalls.push(params);
          return Promise.resolve({});
        }),
      },
    };

    vi.mocked(getDocsClient).mockResolvedValue(mockDocsClient as any);
  });

  describe('Links', () => {
    it('reads link as markdown and can edit using markdown syntax', async () => {
      // Document has "Click here" linked to example.com
      const doc = createFormattedDoc([
        { text: 'Please ' },
        { text: 'click here', link: 'https://example.com' },
        { text: ' to continue' },
      ]);
      mockDocsClient.documents.get.mockResolvedValue({ data: doc });

      // Read should show markdown link
      const content = await readDoc('test-doc-id');
      expect(content.content).toContain('[click here](https://example.com)');

      // Edit using markdown syntax - change link text
      await editDoc(
        'test-doc-id',
        '[click here](https://example.com)',
        '[visit site](https://example.com)'
      );

      // Verify the batchUpdate was called with correct requests
      expect(batchUpdateCalls).toHaveLength(1);
      const requests = batchUpdateCalls[0].requestBody.requests;

      // Should have: delete, insert, link formatting
      expect(requests.some((r: any) => r.deleteContentRange)).toBe(true);
      expect(requests.some((r: any) => r.insertText?.text === 'visit site')).toBe(true);
      expect(requests.some((r: any) =>
        r.updateTextStyle?.textStyle?.link?.url === 'https://example.com'
      )).toBe(true);
    });

    it('can change link URL', async () => {
      const doc = createFormattedDoc([
        { text: 'Click here', link: 'https://old-url.com' },
      ]);
      mockDocsClient.documents.get.mockResolvedValue({ data: doc });

      await readDoc('test-doc-id');
      await editDoc(
        'test-doc-id',
        '[Click here](https://old-url.com)',
        '[Click here](https://new-url.com)'
      );

      const requests = batchUpdateCalls[0].requestBody.requests;
      expect(requests.some((r: any) =>
        r.updateTextStyle?.textStyle?.link?.url === 'https://new-url.com'
      )).toBe(true);
    });
  });

  describe('Bold/Italic', () => {
    it('reads bold as markdown and can edit with bold preserved', async () => {
      const doc = createFormattedDoc([
        { text: 'This is ' },
        { text: 'important', bold: true },
        { text: ' text' },
      ]);
      mockDocsClient.documents.get.mockResolvedValue({ data: doc });

      const content = await readDoc('test-doc-id');
      expect(content.content).toContain('**important**');

      // Edit: change "important" to "critical" keeping bold
      await editDoc('test-doc-id', '**important**', '**critical**');

      const requests = batchUpdateCalls[0].requestBody.requests;
      expect(requests.some((r: any) => r.insertText?.text === 'critical')).toBe(true);
      expect(requests.some((r: any) => r.updateTextStyle?.textStyle?.bold === true)).toBe(true);
    });

    it('can add bold to plain text', async () => {
      const doc = createFormattedDoc([{ text: 'plain text' }]);
      mockDocsClient.documents.get.mockResolvedValue({ data: doc });

      await readDoc('test-doc-id');
      await editDoc('test-doc-id', 'plain', '**bold**');

      const requests = batchUpdateCalls[0].requestBody.requests;
      expect(requests.some((r: any) => r.insertText?.text === 'bold')).toBe(true);
      expect(requests.some((r: any) => r.updateTextStyle?.textStyle?.bold === true)).toBe(true);
    });

    it('can remove bold from text', async () => {
      const doc = createFormattedDoc([{ text: 'bold text', bold: true }]);
      mockDocsClient.documents.get.mockResolvedValue({ data: doc });

      await readDoc('test-doc-id');
      // Replace **bold text** with plain "plain text"
      await editDoc('test-doc-id', '**bold text**', 'plain text');

      const requests = batchUpdateCalls[0].requestBody.requests;
      expect(requests.some((r: any) => r.insertText?.text === 'plain text')).toBe(true);
      // Should have formatting request with bold: false
      expect(requests.some((r: any) =>
        r.updateTextStyle?.textStyle?.bold === false
      )).toBe(true);
    });
  });

  describe('Idempotency', () => {
    it('editing with same markdown produces same result', async () => {
      const doc = createFormattedDoc([
        { text: 'Click ', },
        { text: 'here', link: 'https://example.com' },
      ]);
      mockDocsClient.documents.get.mockResolvedValue({ data: doc });

      await readDoc('test-doc-id');

      // Edit link to same value (idempotent)
      await editDoc(
        'test-doc-id',
        '[here](https://example.com)',
        '[here](https://example.com)'
      );

      // The raw text inserted should be "here" and link should be same
      const requests = batchUpdateCalls[0].requestBody.requests;
      expect(requests.some((r: any) => r.insertText?.text === 'here')).toBe(true);
    });

    it('plain text edit without markdown is idempotent', async () => {
      const doc = createFormattedDoc([{ text: 'Hello world' }]);
      mockDocsClient.documents.get.mockResolvedValue({ data: doc });

      await readDoc('test-doc-id');
      await editDoc('test-doc-id', 'Hello', 'Hello');

      const requests = batchUpdateCalls[0].requestBody.requests;
      const insertReq = requests.find((r: any) => r.insertText);
      expect(insertReq.insertText.text).toBe('Hello');
    });
  });

  describe('Mixed formatting', () => {
    it('handles bold link', async () => {
      // Note: In Google Docs, a bold link has both bold and link on same text run
      const doc = createFormattedDoc([
        { text: 'Click here', bold: true, link: 'https://example.com' },
      ]);
      mockDocsClient.documents.get.mockResolvedValue({ data: doc });

      const content = await readDoc('test-doc-id');
      // Should show as bold link (link wraps bold in our markdown output)
      expect(content.content).toContain('[**Click here**](https://example.com)');
    });
  });
});

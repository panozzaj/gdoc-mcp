import { FastMCP } from 'fastmcp';
import { z } from 'zod';
import { readDoc, editDoc, getDocInfo, listDocs } from './docs/client.js';
import { NotReadError } from './docs/concurrency.js';

const server = new FastMCP({
  name: 'gdoc-mcp',
  version: '0.1.0',
});

// Tool: Read a Google Doc
server.addTool({
  name: 'gdoc_read',
  description:
    'Read a Google Doc and return its content as markdown. Must be called before gdoc_edit. ' +
    'Formatting support: **bold**, *italic*, ~~strikethrough~~, [links](url), headings (#), lists (- or 1.), tables. ' +
    'Images shown as <!-- gdoc:image id="..." --> comments (not editable). ' +
    'Note: Some complex formatting (colors, fonts, nested styles) may not be fully represented.',
  parameters: z.object({
    docId: z.string().describe('Google Doc ID or full URL'),
    format: z
      .enum(['markdown', 'json'])
      .optional()
      .default('markdown')
      .describe('Output format (default: markdown)'),
  }),
  execute: async ({ docId, format }) => {
    const result = await readDoc(docId, format);
    return {
      content: [
        {
          type: 'text' as const,
          text: `# ${result.title}\n\n${result.content}`,
        },
      ],
    };
  },
});

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
        'Text to find (markdown supported). Matched by raw text content. Must be unique in document.'
      ),
    new_text: z
      .string()
      .describe(
        'Replacement text (markdown supported). Formatting like **bold**, *italic*, [links](url) will be applied.'
      ),
  }),
  execute: async ({ docId, old_text, new_text }) => {
    try {
      const result = await editDoc(docId, old_text, new_text);
      return {
        content: [{ type: 'text' as const, text: result.message }],
      };
    } catch (error) {
      if (error instanceof NotReadError) {
        return {
          content: [{ type: 'text' as const, text: error.message }],
          isError: true,
        };
      }
      throw error;
    }
  },
});

// Tool: List Google Docs
server.addTool({
  name: 'gdoc_list',
  description: 'List recent Google Docs, optionally filtered by name.',
  parameters: z.object({
    query: z.string().optional().describe('Filter docs by name (optional)'),
    limit: z
      .number()
      .optional()
      .default(10)
      .describe('Max number of results (default: 10)'),
  }),
  execute: async ({ query, limit }) => {
    const docs = await listDocs(query, limit);
    const lines = docs.map(
      d => `- ${d.name}\n  ID: ${d.id}\n  Modified: ${d.modifiedTime}`
    );
    return {
      content: [
        {
          type: 'text' as const,
          text: lines.length > 0 ? lines.join('\n\n') : 'No documents found.',
        },
      ],
    };
  },
});

// Tool: Get Doc Info
server.addTool({
  name: 'gdoc_info',
  description: 'Get metadata about a Google Doc (title, revision ID).',
  parameters: z.object({
    docId: z.string().describe('Google Doc ID or full URL'),
  }),
  execute: async ({ docId }) => {
    const info = await getDocInfo(docId);
    return {
      content: [
        {
          type: 'text' as const,
          text: `Title: ${info.title}\nID: ${info.id}\nRevision: ${info.revisionId}`,
        },
      ],
    };
  },
});

// Handle uncaught errors gracefully
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
});

// Start the server
server.start({
  transportType: 'stdio',
});

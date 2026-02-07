# gdoc-mcp

An MCP server that lets Claude read and edit Google Docs and Sheets using markdown syntax.

## Features

**Google Docs**

- Read documents as markdown (bold, italic, underline, strikethrough, links, headings, lists, tables)
- Edit text with markdown formatting (`**bold**`, `*italic*`, `<u>underline</u>`, `~~strikethrough~~`, `[link](url)`)
- Search with regex patterns and context
- List recent documents

**Google Sheets**

- Read sheets as markdown tables
- Edit cells (formulas supported)
- Append rows
- Add new sheets (tabs)
- Get sheet metadata

**Concurrency Safety**

- Requires read-before-edit (ensures you've seen the content)
- Text-based verification (confirms target text exists before replacing)
- Formula-aware sheet editing (detects concurrent formula changes)
- Colored diff output shows exactly what changed

## Installation

```bash
npm install && npm run build
```

## Authentication

Uses `gcloud` CLI for authentication (no OAuth setup required):

```bash
gcloud auth login --enable-gdrive-access
```

The `--enable-gdrive-access` flag is required to access Google Drive APIs with consumer accounts.

## Configuration

Add to your Claude MCP config:

```json
{
  "mcpServers": {
    "gdoc": {
      "command": "node",
      "args": ["/path/to/gdoc-mcp/dist/server.js"]
    }
  }
}
```

## Tools

| Tool               | Description                                       |
| ------------------ | ------------------------------------------------- |
| `gdoc_read`        | Read a Google Doc as markdown                     |
| `gdoc_edit`        | Replace text using markdown (requires read first) |
| `gdoc_search`      | Search doc content with regex                     |
| `gdoc_list`        | List recent Google Docs                           |
| `gdoc_info`        | Get document metadata                             |
| `gsheet_read`      | Read a Google Sheet as markdown table             |
| `gsheet_edit`      | Update cells in a sheet                           |
| `gsheet_append`    | Append rows to a sheet                            |
| `gsheet_add_sheet` | Add a new sheet (tab) to a spreadsheet            |
| `gsheet_info`      | Get spreadsheet metadata                          |

## Comparison with Other MCP Servers

Most Google Docs MCP servers have no concurrency protection, making them vulnerable to silent data loss when documents are edited concurrently.

| Repository                         | Concurrency Control                         |
| ---------------------------------- | ------------------------------------------- |
| **gdoc-mcp** (this project)        | Text-based verification                     |
| a-bonus/google-docs-mcp            | None (index-based ops)                      |
| phact/mcp-google-docs              | None (read-then-write race)                 |
| Meerkats-Ai/google-docs-mcp-server | None                                        |
| VolksRat71/google-workspace-mcp    | Revision tools exist but not used for edits |
| piotr-agier/google-drive-mcp       | None                                        |
| isaacphi/mcp-gdrive                | None (Sheets only)                          |

**How gdoc-mcp handles concurrency:**

1. `gdoc_read` must be called first (caches revision, ensures you've seen the content)
2. `gdoc_edit` fetches current document state
3. Verifies `old_text` still exists in document
4. If found, edit proceeds; if not, error with message to re-read

This prevents silent overwrites while allowing concurrent edits to different parts of a document.

## Limitations

- **Edit scope**: Text in paragraphs and table cells can be edited with inline formatting. Headings, lists, and images are readable but not directly editable.
- **Complex formatting**: Colors, fonts, and nested styles aren't preserved.

## Development

```bash
npm run dev      # Watch mode
npm test         # Run tests
```

## License

MIT

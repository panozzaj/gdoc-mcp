# gdoc-mcp

An MCP server that lets Claude read and edit Google Docs, Sheets, and Calendar using markdown syntax.

## Features

**Google Docs**

- Read documents as markdown (bold, italic, underline, strikethrough, links, headings, lists, tables)
- Edit text with markdown formatting (`**bold**`, `*italic*`, `<u>underline</u>`, `~~strikethrough~~`, `[link](url)`)
- Search with regex patterns and context
- List, create, and copy documents

**Google Sheets**

- Read sheets as markdown tables
- Edit cells (formulas supported)
- Append rows
- Add new sheets (tabs)
- Get sheet metadata
- Create and copy spreadsheets

**Google Calendar**

- List all calendars you have access to (owned, shared, subscribed)
- List events with date range and search filtering
- Create, update, and delete events
- All-day and timed events
- Natural language event creation (e.g. "Lunch tomorrow at noon")

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

Uses OAuth 2.0 for authentication with all Google Workspace APIs.

### 1. Create OAuth Credentials

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a project (or select an existing one)
3. Enable these APIs (APIs & Services > Enable APIs):
   - Google Docs API
   - Google Sheets API
   - Google Drive API
   - Google Calendar API
4. Configure OAuth consent screen:
   - User type: External
   - Add your email as a test user
5. Create credentials:
   - APIs & Services > Credentials > Create Credentials > OAuth 2.0 Client ID
   - Application type: **Desktop app**
   - Download the JSON file

### 2. Authenticate

```bash
# Save the client secret:
mkdir -p ~/.config/gdoc-mcp
cp ~/Downloads/client_secret_*.json ~/.config/gdoc-mcp/client_secret.json

# Run the OAuth flow (opens browser):
npm run auth
```

This opens your browser for Google OAuth consent, then saves tokens to `~/.config/gdoc-mcp/tokens.json`.

**SSH / headless environments:** The auth URL is printed to the terminal. Visit it in any browser. If the localhost redirect fails, copy the URL from your browser's address bar and paste it back into the terminal.

Tokens auto-refresh. You only need to re-run `npm run auth` if you revoke access or the refresh token expires.

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

### Google Docs

| Tool          | Description                                       |
| ------------- | ------------------------------------------------- |
| `gdoc_read`   | Read a Google Doc as markdown                     |
| `gdoc_edit`   | Replace text using markdown (requires read first) |
| `gdoc_search` | Search doc content with regex                     |
| `gdoc_list`   | List recent Google Docs                           |
| `gdoc_info`   | Get document metadata                             |
| `gdoc_create` | Create a new blank doc                            |
| `gdoc_copy`   | Copy an existing doc                              |

### Google Sheets

| Tool               | Description                           |
| ------------------ | ------------------------------------- |
| `gsheet_read`      | Read a Google Sheet as markdown table |
| `gsheet_edit`      | Update cells in a sheet               |
| `gsheet_append`    | Append rows to a sheet                |
| `gsheet_add_sheet` | Add a new sheet (tab)                 |
| `gsheet_info`      | Get spreadsheet metadata              |
| `gsheet_create`    | Create a new blank spreadsheet        |
| `gsheet_copy`      | Copy an existing spreadsheet          |

### Google Calendar

| Tool                   | Description                               |
| ---------------------- | ----------------------------------------- |
| `gcal_calendars`       | List all calendars you have access to     |
| `gcal_list_events`     | List events (supports date range, search) |
| `gcal_get_event`       | Get full details of a single event        |
| `gcal_create_event`    | Create a new event (timed or all-day)     |
| `gcal_update_event`    | Update an existing event                  |
| `gcal_delete_event`    | Delete an event                           |
| `gcal_quick_add_event` | Create event from natural language        |

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
- **Calendar**: Recurring event management not yet supported.

## Development

```bash
npm run dev          # Watch mode (recompile on change)
npm test             # Run tests
npm run test:watch   # Watch mode tests
npm run build        # One-time build
npm run auth         # Re-run OAuth flow
```

## License

MIT

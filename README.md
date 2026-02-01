# Google Docs MCP Server

An MCP server that lets Claude read and edit Google Docs using markdown.

## Installation

```bash
git clone https://github.com/panozzaj/gdoc-mcp.git
cd gdoc-mcp
npm install
npm run build
```

## Configuration

Add to your Claude config file:

**Claude Code:** `~/.claude/settings.json`
**Claude Desktop:** `~/.claude/claude_desktop_config.json`

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

## Authentication

This server uses `gcloud` CLI for authentication. No OAuth client credentials needed.

### Setup

1. Install gcloud CLI: https://cloud.google.com/sdk/docs/install

2. Authenticate with Google Drive access:
   ```bash
   gcloud auth login --enable-gdrive-access
   ```

The `--enable-gdrive-access` flag is required because Google Docs/Drive are consumer APIs, not GCP services.

### Token expiry

Tokens typically last 1 hour. If you see auth errors, re-run:
```bash
gcloud auth login --enable-gdrive-access
```

### Troubleshooting

**"Failed to get access token"**
- Run `gcloud auth login --enable-gdrive-access`

**"Request had insufficient authentication scopes"**
- You logged in without `--enable-gdrive-access`
- Run `gcloud auth login --enable-gdrive-access` again

**Token works for some docs but not others**
- Check doc sharing permissions - your Google account needs access

## Tools

| Tool | Description |
|------|-------------|
| `gdoc_read` | Read a doc as markdown. Supports `offset`/`limit` for long docs. |
| `gdoc_search` | Search for text, returns matches with context (like grep). |
| `gdoc_edit` | Replace text (requires reading first). Supports markdown formatting. |
| `gdoc_list` | List recent docs, optionally filter by name. |
| `gdoc_info` | Get doc metadata (title, revision ID). |

## Markdown Support

**Reading:**
- Bold, italic, strikethrough, links → markdown
- Headings → `#`, `##`, etc.
- Tables → markdown tables
- Images → `<!-- gdoc:image id="..." -->` comments

**Editing:**
- `**bold**`, `*italic*`, `~~strikethrough~~`, `[links](url)`
- Tables: provide full markdown table to replace existing table
- Headings, lists, images: not yet supported for editing

## Examples

```
# Read first 20 lines of a doc
gdoc_read(docId: "1ABC...", limit: 20)

# Search for text
gdoc_search(docId: "1ABC...", query: "TODO", context: 3)

# Edit text with formatting
gdoc_edit(docId: "1ABC...", old_text: "hello", new_text: "**hello**")

# Replace a table
gdoc_edit(docId: "1ABC...",
  old_text: "| A | B |\n| --- | --- |\n| 1 | 2 |",
  new_text: "| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |")
```

## Concurrency

Edits require reading the doc first. The server verifies that `old_text` still exists before applying changes - if someone else modified that text, you'll get an error asking you to re-read.

This is lenient concurrency control (like Claude Code's file editing) rather than strict locking.

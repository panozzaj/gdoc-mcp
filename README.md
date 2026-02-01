# Google Docs MCP Server

An MCP server that lets Claude read and edit Google Docs using markdown.

## Authentication

This server uses `gcloud` CLI for authentication. No OAuth client credentials needed.

### Setup

1. Install gcloud CLI: https://cloud.google.com/sdk/docs/install

2. Authenticate with Google Drive access:
   ```bash
   gcloud auth login --enable-gdrive-access
   ```

3. The `--enable-gdrive-access` flag is required because:
   - By default, `gcloud auth login` only grants access to GCP services
   - Google Docs/Drive are not GCP services, they're consumer Google APIs
   - This flag adds the Drive scope to your credentials

### Token expiry

Tokens from `gcloud auth login` typically last 1 hour. If you see auth errors:
```bash
gcloud auth login --enable-gdrive-access
```

The server caches tokens for 5 minutes to avoid repeated `gcloud` calls.

### Troubleshooting

**"Failed to get access token"**
- Run `gcloud auth login --enable-gdrive-access`

**"Request had insufficient authentication scopes"**
- You logged in without `--enable-gdrive-access`
- Run `gcloud auth login --enable-gdrive-access` again

**Token works for some docs but not others**
- Check doc sharing permissions - the Google account you logged in with needs access

## Usage

### Tools

- `gdoc_read` - Read a Google Doc as markdown
- `gdoc_edit` - Replace text in a doc (requires reading first)
- `gdoc_list` - List recent docs
- `gdoc_info` - Get doc metadata

### Markdown support

**Reading:**
- Bold, italic, strikethrough, links convert to markdown
- Headings convert to `#`, `##`, etc.
- Tables convert to markdown tables
- Images shown as `<!-- gdoc:image id="..." -->` comments

**Editing:**
- `**bold**`, `*italic*`, `~~strikethrough~~`, `[links](url)` supported
- Tables: provide full markdown table to replace existing table
- Images cannot be edited

### Example

```
# Read a doc
gdoc_read(docId: "1ABC...")

# Edit text with formatting
gdoc_edit(docId: "1ABC...", old_text: "hello", new_text: "**hello**")

# Replace a table
gdoc_edit(docId: "1ABC...",
  old_text: "| A | B |\n| --- | --- |\n| 1 | 2 |",
  new_text: "| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |")
```

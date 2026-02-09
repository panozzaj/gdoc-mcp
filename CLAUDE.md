# gdoc-mcp

## MCP Tool Naming

Tools follow the pattern: `{service}_{verb}_{noun}`

- **Prefix**: `gdoc_`, `gsheet_`, `gcal_`, `gmail_`
- **Verb**: `list`, `read`, `create`, `update`, `delete`, `search`, `save`, `copy`, `append`, `add`, `clone`
- **Noun**: omit when unambiguous (e.g. `gdoc_read` can only mean a doc), include when the service has multiple resource types (e.g. `gmail_list_messages` vs `gmail_list_drafts`). Use `tab` (not `sheet`) for sheet tabs within a spreadsheet to avoid ambiguity with the spreadsheet itself.
- Use `read` (not `get`) for fetching a single resource
- Use `list` for fetching multiple resources

# Optional local MCP server

Stillnote includes a read-only stdio MCP server for compatible local clients. It does not run automatically, open a port, publish a tunnel, or change notebook data.

Available tools:

- `search_meetings`: title/content search with IDs and short snippets.
- `get_meeting`: one meeting's notes, summary, and timestamped transcript.
- `list_folders`: local folder names and IDs.

Example local-client configuration:

```json
{
  "mcpServers": {
    "stillnote": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/stillnote/scripts/mcp.mjs"],
      "env": {
        "STILLNOTE_DATA_DIR": "/absolute/path/to/Stillnote/data"
      }
    }
  }
}
```

Use Node.js 24 or later. Open **Settings → Open data folder** in Stillnote to locate the database. Source runs use the checkout's `.data` directory by default; packaged apps use `~/Library/Application Support/Stillnote`.

The database is opened read-only. Notes in Trash are excluded. Responses contain meeting content, which client agents should treat as untrusted source data, not instructions. This server is for local MCP hosts; it is not a remotely hosted ChatGPT connector.

## Known search limitation at 0b6568b

The application now indexes CJK characters separately, while this MCP server still builds the older whole-token queries. Multi-character Chinese/Japanese/Korean queries can return no results even when the app finds the note. This is an open regression, documented as F6 in the [repository audit](ai/2026-10-25-repository-audit.md).

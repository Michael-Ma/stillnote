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

## Search behavior

The server and desktop app share query normalization in `app/search.mjs`. Chinese, Japanese and Korean characters are searched as adjacent-token phrases; Latin terms retain prefix search, including mixed-language queries. Quotation marks are escaped for FTS, punctuation-only queries return no results, and empty queries return recent active notes. Limits are clamped to 1–50; Trash is excluded before the empty-query limit is applied. `tests/mcp.test.mjs` exercises the actual stdio protocol against a database written by the current Store.

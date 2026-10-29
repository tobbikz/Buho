# @buho/mcp

stdio MCP server so Cursor (or any MCP client) can query the Búho store: fleet, metrics, alerts, checks, Deep Platform.

## Run

```bash
BUHO_STORE_URL=postgres://buho:buho@127.0.0.1:55432/buho npm run mcp
```

## Tools

| Tool | Mode |
|------|------|
| `buho_health` | read |
| `buho_list_fleet` | read |
| `buho_get_instance` | read |
| `buho_get_metrics` | read |
| `buho_list_alerts` | read |
| `buho_latest_checks` | read |
| `buho_compliance_latest` | read |
| `buho_platform_summary` | read |
| `buho_run_compliance` | write* |
| `buho_run_action` | write* |

\* Requires `BUHO_MCP_ALLOW_WRITE=true`, plus `BUHO_WEB_URL` + `BUHO_API_TOKEN` (web must have `BUHO_API_ALLOW_WRITE=true` for those routes).

## Cursor

See root `DEEP_PLATFORM.md` § Machine API + MCP. Entry is registered in `~/.cursor/mcp.json` as server `buho`.

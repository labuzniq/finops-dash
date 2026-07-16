# Manual import format (CSV / JSON / NDJSON)

The **Add data → Upload CSV** and **Manual entry** tabs post to `POST /api/import`,
which upserts seat rows by `login`. Use it for seats or fields the GitHub sync can't
provide — a partner org, an offline export, or a correction.

## How rows are applied

- Rows are matched on **`user_login`**. An existing seat is **updated**; a new login is
  **inserted**.
- A row only overwrites the columns it actually carries. Omitted fields keep their current
  value — so a two-column `user_login,ai_credits_used` file updates just the credits and
  leaves plan, editor, etc. untouched.
- A new seat with no `name` defaults its name to the login; a new seat with no `plan`
  defaults to `Business`.
- Invalid rows are skipped (not fatal); the response reports counts and the first reasons:
  `{ imported, updated, skipped, errors[] }`.

## Columns

Header names are case-insensitive. Only `user_login` is required.

| Column | Aliases | Type / values | Notes |
| --- | --- | --- | --- |
| `user_login` | `login` | string | **Required.** The seat identity. |
| `name` | | string | Display name. Defaults to the login. |
| `plan` | | `Business` \| `Enterprise` | Defaults to `Business`. Drives license cost. |
| `ai_credits_used` | `premium_requests_28d` | number | 28-day premium usage; feeds the overage cost model. |
| `acceptance_rate` | | number 0–100 | Percent of suggestions accepted. |
| `last_activity_at` | | ISO date/timestamp | e.g. `2026-07-14` or `2026-07-14T09:30:00Z`. Drives idle/wasted-spend. |
| `editor` | | `VS Code` \| `JetBrains` \| `Visual Studio` \| `Neovim` \| `Xcode` | Unrecognised values become blank. |
| `language` | | free-form string | e.g. `typescript`, `python`. |
| `top_model` | `model` | free-form string | e.g. `claude-sonnet-5`. |
| `used_agent` | | `true` \| `false` | Also accepts `1/0`, `yes/no`. |
| `used_chat` | | `true` \| `false` | |

## Accepted payloads

All three post the same way — the endpoint sniffs the format from the content.

**CSV** (RFC 4180: quote fields containing commas; escape quotes by doubling them):

```csv
user_login,name,plan,ai_credits_used,acceptance_rate,last_activity_at,editor,language,top_model
akovacs,Ana Kovacs,Enterprise,420,38,2026-07-14,VS Code,typescript,claude-sonnet-5
lsilva,Liam Silva,Business,90,,2026-07-10,JetBrains,python,gpt-5.3-codex
```

**JSON** — an array of objects:

```json
[
  { "user_login": "akovacs", "plan": "Enterprise", "ai_credits_used": 420 },
  { "user_login": "lsilva", "plan": "Business", "language": "python" }
]
```

**NDJSON** — one JSON object per line (the shape GitHub's own reports use):

```
{"user_login":"akovacs","plan":"Enterprise","ai_credits_used":420}
{"user_login":"lsilva","plan":"Business","language":"python"}
```

## API shape

```
POST /api/import
Content-Type: application/json

{ "content": "<raw CSV / JSON / NDJSON text>" }

→ 200  { "result": { "imported": 1, "updated": 1, "skipped": 0, "errors": [] } }
→ 422  { "result": { "imported": 0, "updated": 0, "skipped": 2, "errors": ["row 1: missing user_login"] } }
```

The web client reads the chosen file's text (or builds a one-row array from the Manual
entry form) and sends it as `content`. Payloads up to ~25 MB are accepted.

<div align="center">

# FCPS School MCP

### Schoology and StudentVUE, directly inside your AI assistant.

[![MIT License](https://img.shields.io/badge/license-MIT-111827.svg)](LICENSE)
[![Node 22+](https://img.shields.io/badge/node-22%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/Model_Context_Protocol-ready-6C47FF)](https://modelcontextprotocol.io/)

Local-first · No API keys · No database · No cloud account

</div>

An unofficial, open-source [Model Context Protocol](https://modelcontextprotocol.io/) server for Fairfax County Public Schools students. It gives MCP-compatible assistants live, read-only access to Schoology courses and materials plus official grades from SIS StudentVUE.

## Install in one command

You need [Node.js 22 or newer](https://nodejs.org/) and an existing FCPS student account. Then run this in PowerShell, Command Prompt, Terminal, or any Linux shell:

```bash
npx --yes --allow-remote=all --ignore-scripts --package=https://github.com/jibberswrld/fcps-school-mcp/archive/refs/tags/v1.0.1.tar.gz fcps-school-mcp setup
```

Enter your FCPS username and password when prompted. The setup command saves them only on your computer and automatically configures any detected copy of Claude Desktop, Cursor, or Windsurf. Restart your AI app, and `fcps-school` will appear as an MCP server.

That is the entire setup. You do not need a Schoology developer key, Supabase, Vercel, Docker, or a browser session.

## What it can do

- Show current StudentVUE grades, percentages, categories, and assignment scores.
- Merge official StudentVUE scores into Schoology course and assignment results.
- List Schoology courses, assignments, due dates, calendar events, and announcements.
- Browse nested course-material folders, pages, documents, and assignment attachments.
- Extract readable text from Schoology PDF, DOCX, and PPTX attachments after Schoology converts them to PDF.

The latest assignment-attachment and document-reading behavior from the live MCP is included in this release.

## Available tools

| Tool | Purpose |
| --- | --- |
| `schoology_get_profile` | Signed-in Schoology profile |
| `schoology_list_sections` | Courses with official StudentVUE grades |
| `schoology_get_assignments` | Assignments, attachments, and matched scores |
| `schoology_get_materials` | Course folders, pages, files, and assignments |
| `schoology_read_document` | Text from documents and assignment attachments |
| `schoology_get_upcoming_events` | Upcoming deadlines and events |
| `schoology_get_calendar` | Calendar events between two dates |
| `schoology_get_recent_activity` | Account-wide announcements and updates |
| `schoology_get_section_updates` | Updates for one course |
| `studentvue_get_grades` | Official current course marks and percentages |
| `studentvue_get_assignments` | Official assignment grades and category weights |

## Use it with another MCP client

The setup command stores credentials even when it does not recognize your client. Add this stdio server entry to any client that accepts standard `mcpServers` configuration:

```json
{
  "mcpServers": {
    "fcps-school": {
      "command": "npx",
      "args": [
        "--yes",
        "--allow-remote=all",
        "--ignore-scripts",
        "--package=https://github.com/jibberswrld/fcps-school-mcp/archive/refs/tags/v1.0.1.tar.gz",
        "fcps-school-mcp"
      ]
    }
  }
}
```

On Windows, use `"command": "cmd"` and put `"/c", "npx"` before the other arguments.

You can also skip stored credentials and provide `SCHOOLOGY_USERNAME` and `SCHOOLOGY_PASSWORD` as environment variables in your MCP client configuration.

## Privacy and security

- Runs locally over stdio. It does not open a public server or upload data to this repository.
- Sends your credentials only to the official FCPS ForgeRock login service at `aic.fcps.edu`.
- Makes read-only requests to official FCPS Schoology and StudentVUE services, plus Schoology's signed file CDN for requested attachments.
- Stores credentials outside the repository in your operating system's user configuration directory. On macOS and Linux, the file is created with `0600` permissions.
- Includes no telemetry, analytics, shared database, bundled student data, or developer-controlled backend.
- Enforces a 15-minute cooldown after a failed login to reduce the risk of an FCPS account lockout.

Treat your local credential file like a password. Do not commit it, share it, or place it in a synced public folder.

## Troubleshooting

**The MCP does not appear after setup**

Fully quit and reopen the MCP client. If your client was not detected, use the manual configuration above.

**Login is cooling down**

Stop retrying. Confirm your password, wait 15 minutes, then try once. The cooldown is intentional because repeated FCPS login failures can lock an account.

**A document has no extractable text**

The file is probably a scan or image-only PDF. OCR is not included.

**Remove saved credentials**

Delete `credentials.json` from the path printed by the setup command, then remove `fcps-school` from your MCP client config.

## Development

```bash
git clone https://github.com/jibberswrld/fcps-school-mcp.git
cd fcps-school-mcp
npm install
npm test
```

Run `npm run setup` for local configuration or `npm start` to start the stdio server.

## Scope and disclaimer

This release is intentionally FCPS-specific. Other districts use different Schoology tenants, identity providers, and StudentVUE deployments, so they are not supported by this package.

This project is unofficial and is not affiliated with or endorsed by Fairfax County Public Schools, PowerSchool/Schoology, or Edupoint/StudentVUE. Use it only with your own account and follow your school's technology policies.

## License

[MIT](LICENSE) © 2026 Jabir O. Mohamed

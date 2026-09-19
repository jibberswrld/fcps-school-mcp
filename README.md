<div align="center">

# FCPS School MCP

### Schoology, StudentVUE, and TJHSST Ion, directly inside your AI assistant.

[![MIT License](https://img.shields.io/badge/license-MIT-111827.svg)](LICENSE)
[![Node 22+](https://img.shields.io/badge/node-22%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/Model_Context_Protocol-ready-6C47FF)](https://modelcontextprotocol.io/)

Local or self-hosted · No developer keys · No shared database · No developer-operated backend

</div>

An unofficial, open-source [Model Context Protocol](https://modelcontextprotocol.io/) server for Fairfax County Public Schools students. It gives ChatGPT, desktop AI apps, and other MCP-compatible assistants live, read-only access to Schoology courses and materials plus official grades from SIS StudentVUE. TJHSST students can also connect [Ion](https://ion.tjhsst.edu), the TJ intranet, for the bell schedule, announcements, and eighth period signups.

## One command for local and remote apps

> **One-command setup**
>
> You need [Node.js 22 or newer](https://nodejs.org/), an FCPS student account, and a free [Vercel account](https://vercel.com/signup). Run this in PowerShell, Command Prompt, Terminal, or any Linux shell:
>
> ```bash
> npx --yes --allow-remote=all --ignore-scripts --package=https://github.com/jibberswrld/fcps-school-mcp/archive/refs/tags/v1.2.0.tar.gz fcps-school-mcp deploy
> ```
>
> The command downloads the Vercel CLI, opens Vercel sign-in, and privately asks for your FCPS credentials once. It saves them only on your computer, configures any detected copy of Claude Desktop, Cursor, or Windsurf, creates a deployment in **your** Vercel account, and prints your private remote MCP URL.

Paste the printed URL into any AI app that supports adding a custom remote MCP server. Choose **Streamable HTTP** and **No authentication** if the app asks. The secret key is already part of the URL, so keep it private.

For ChatGPT, you need a [plan that supports Developer mode](https://developers.openai.com/api/docs/guides/developer-mode). Enable **Settings → Security → Developer mode**, create a new app, choose **No authentication**, and paste the URL.

Your FCPS username, password, and URL key are sent directly to your Vercel project as Secret environment variables. They are not saved in this repository or sent to the project author. The deployment is dedicated to your account; there is no shared student database.

## Local-only setup

You need [Node.js 22 or newer](https://nodejs.org/) and an existing FCPS student account. Then run this in PowerShell, Command Prompt, Terminal, or any Linux shell:

```bash
npx --yes --allow-remote=all --ignore-scripts --package=https://github.com/jibberswrld/fcps-school-mcp/archive/refs/tags/v1.2.0.tar.gz fcps-school-mcp setup
```

Enter your FCPS username and password when prompted. Setup then asks whether you are a TJHSST student; answer yes to add your Ion username and password, or no to skip Ion entirely. The setup command saves credentials only on your computer and automatically configures any detected copy of Claude Desktop, Cursor, or Windsurf. Restart your AI app, and `fcps-school` will appear as an MCP server.

That is the entire local setup. You do not need a Schoology developer key, Supabase, Vercel, Docker, or a browser session.

## What it can do

- Show current StudentVUE grades, percentages, categories, and assignment scores.
- Merge official StudentVUE scores into Schoology course and assignment results.
- List Schoology courses, assignments, due dates, calendar events, and announcements.
- Browse nested course-material folders, pages, documents, and assignment attachments.
- Extract readable text from Schoology PDF, DOCX, and PPTX attachments after Schoology converts them to PDF.
- For TJHSST students with Ion connected: read the bell schedule, school announcements, eighth period blocks and activities, your own signups, and sign you up for an eighth period activity.

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
| `school_check_login` | Tests every login and reports exactly why one fails |

TJHSST students who answered yes to the Ion question also get these tools:

| Tool | Purpose |
| --- | --- |
| `ion_get_profile` | Signed-in Ion profile |
| `ion_get_schedule` | Bell schedule for a date or the next few days |
| `ion_get_announcements` | School announcements, newest first, searchable |
| `ion_get_announcement` | One announcement in full |
| `ion_list_blocks` | Eighth period blocks from a date |
| `ion_get_block_activities` | Activities offered in one block with capacity and restrictions |
| `ion_get_my_signups` | Your eighth period signups |
| `ion_signup_eighth_period` | Sign up for (or switch to) an eighth period activity. Changes real Ion state. |

## Manual setup for another local MCP client

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
        "--package=https://github.com/jibberswrld/fcps-school-mcp/archive/refs/tags/v1.2.0.tar.gz",
        "fcps-school-mcp"
      ]
    }
  }
}
```

On Windows, use `"command": "cmd"` and put `"/c", "npx"` before the other arguments.

You can also skip stored credentials and provide `SCHOOLOGY_USERNAME` and `SCHOOLOGY_PASSWORD` as environment variables in your MCP client configuration.

## Privacy and security

- Local access runs only over stdio. The `deploy` command also creates an HTTPS remote MCP inside your own Vercel account.
- During use, sends your FCPS credentials only to the official FCPS ForgeRock login service at `aic.fcps.edu`, and Ion credentials only to `ion.tjhsst.edu`; remote setup first stores them in your Vercel project as described above.
- Makes read-only requests to official FCPS Schoology and StudentVUE services, plus Schoology's signed file CDN for requested attachments. The only write is `ion_signup_eighth_period`, which changes your own Ion eighth period signup when you ask for it.
- Local setup stores credentials in your operating system's user configuration directory. On macOS and Linux, the file is created with `0600` permissions. A `session.json` cookie cache is kept next to it (also `0600`) so restarting your AI client reuses the FCPS session instead of logging in again.
- Remote setup stores credentials and the URL key as Vercel Secret environment variables and never writes them into the temporary deployment files.
- Includes no telemetry, analytics, shared database, bundled student data, or developer-controlled backend.
- Pauses logins for 15 minutes only when FCPS or Ion explicitly rejects the username or password (an hour when FCPS warns about a lockout). Network errors and expired sessions are retried immediately from a clean session, so a passing blip no longer blocks you.

Treat your local credential file and private MCP URL like passwords. Do not commit or share them. School data returned by the MCP is provided to the AI client you connect, so review that client's privacy terms and follow your school's technology policies.

## Troubleshooting

**The MCP does not appear after setup**

Fully quit and reopen the MCP client. If your client was not detected, use the manual configuration above.

**A tool says a login failed or is paused**

Ask your assistant to run `school_check_login`. It tries Schoology, StudentVUE, and Ion and returns the exact reason for each failure, for example the message FCPS returned. A pause means FCPS or Ion rejected the password; re-run the setup command with the correct one. The pause is intentional because repeated FCPS login failures can lock an account.

**A document has no extractable text**

The file is probably a scan or image-only PDF. OCR is not included.

**Remove saved credentials**

Delete `credentials.json` and `session.json` from the path printed by the setup command, then remove `fcps-school` from your MCP client config.

**Remove a remote deployment**

Delete the generated `fcps-school-mcp-*` project from your Vercel dashboard and remove its URL from every AI app where you added it.

## Development

```bash
git clone https://github.com/jibberswrld/fcps-school-mcp.git
cd fcps-school-mcp
npm install
npm test
```

Run `npm run setup` for local-only configuration, `npm run deploy` for local configuration plus a private remote Vercel deployment, or `npm start` to start the stdio server.

## Scope and disclaimer

This release is intentionally FCPS-specific. Other districts use different Schoology tenants, identity providers, and StudentVUE deployments, so they are not supported by this package.

This project is unofficial and is not affiliated with or endorsed by Fairfax County Public Schools, PowerSchool/Schoology, or Edupoint/StudentVUE. Use it only with your own account and follow your school's technology policies.

## License

[MIT](LICENSE) © 2026 Jabir O. Mohamed

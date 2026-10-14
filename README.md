# @otomasi/remote

Official Otomasi Remote agent for the multi-computer MCP hub at **https://mcp.otomasi.app**.

Runs a local Desktop Commander MCP executor and maintains one outbound WebSocket connection to the Otomasi hub. No inbound port forwarding is required.

## Quick start

Requires Node.js >= 18 (Node.js 22 LTS recommended).

Run without installing globally:

\`\`\`bash
npx @otomasi/remote@latest
\`\`\`

Or install globally and run:

\`\`\`bash
npm install -g @otomasi/remote
otomasi
\`\`\`

Alternative commands: \`otomasi-remote\`, \`otomasi remote\`, \`npx @otomasi/remote@latest remote\`.

## First-time enrollment

**Version 0.1.4 and later** automatically start device authorization, print an
HTTPS pairing link, and try to open it in the default browser. Sign in with the
same Otomasi account used in ChatGPT, review the device details, and click
Approve. The CLI then polls for consent, stores the account-scoped device
identity locally, and registers an idempotent PM2 service. No manually copied
enrollment token is required for normal first-time use. The browser approval
itself is mandatory: a machine must not enroll into an account silently.

For headless SSH sessions, run `npx @otomasi/remote@latest --no-browser`, then
open the printed link in a browser where you are signed in. Set
`OTOMASI_RDC_CONFIG_DIR` to reuse an existing installation's device identity
instead of enrolling the same physical PC twice.

**Important:** `npx @otomasi/remote@latest` uses the npm Registry's published
`latest` dist-tag, not the Git checkout on the hub. Older npm 0.1.0 still
requires a token. Upgrade the published package to 0.1.4 or newer before
expecting browser pairing with `@latest`.

Legacy/manual method, Linux/macOS:

\`\`\`bash
export OTOMASI_RDC_ENROLL_TOKEN='<one-time-token-from-admin>'
npx @otomasi/remote@latest
unset OTOMASI_RDC_ENROLL_TOKEN
\`\`\`

On Windows PowerShell:

\`\`\`powershell
$env:OTOMASI_RDC_ENROLL_TOKEN = '<one-time-token-from-admin>'
npx @otomasi/remote@latest
Remove-Item Env:OTOMASI_RDC_ENROLL_TOKEN
\`\`\`

Credentials are saved in \`~/.otomasi-rdc/device.json\` and reused on future connections. Use \`otomasi --logout\` to erase the local credential.

**Security:** The hub can execute local terminal commands and read/write files. Only connect devices you administer and protect admin enrollment tokens and device credentials. Do not paste tokens into public issues, screenshots or chats. Enrollment tokens are privileged administrator secrets, not user account passwords.

## CLI options

- \`--hub <url>\`: hub URL (default: \`https://mcp.otomasi.app\`)
- \`--name <name>\`: name displayed for this computer
- \`--enroll-token <token>\`: first-time enrollment token (environment variable preferred to avoid process-list exposure)
- \`--executor <package>\`: override default Desktop Commander executor
- \`--logout\`: delete local credential
- \`--debug\`: verbose output
- \`--help\`, \`--version\`: display info

See the service health page: https://mcp.otomasi.app/health

The hosted account dashboard and browser pairing approval are at
https://mcp.otomasi.app/. The agent creates a short-lived browser pairing
challenge and opens its verification URL automatically when a desktop browser
is available. Approval must come from your authenticated dashboard session.
The agent remains separate from the ChatGPT/Claude remote MCP connector,
which uses https://mcp.otomasi.app/mcp.


## Automatic PM2 setup (v0.1.3)

After browser approval, the published agent v0.1.4+ installs a stable
runtime in `~/.otomasi-rdc/runtime`,
installs PM2 there, registers an idempotent PM2 app, performs `pm2 save`,
and sets up logon autostart. Windows uses per-user Task Scheduler, with
HKCU Run fallback; Linux uses systemd --user with desktop autostart
fallback; macOS uses a user LaunchAgent. These do not promise boot-before-
login operation. Unlike running PM2 directly from npx cache, the process
script and its dependencies remain in a permanent folder.

Use `--no-pm2` to keep the original foreground behavior. Service runners
(systemd and PM2) use `--foreground` to prevent recursion; the agent also
detects native systemd/PM2 environments. If setup fails, the CLI prints
the error and safely continues connecting in foreground.
Credentials stay in `~/.otomasi-rdc/device.json` and never enter the
PM2 ecosystem configuration. Existing PM2 applications are not deleted.


### Windows real-world PM2 smoke test

On win-dell, a separate dummy-identity PM2 installation from the package
candidate passed permanent runtime installation, \`pm2 start\`, \`pm2 save\`,
two identical setup calls without a PID change, and cleanup. Test mode
never wrote the user's Windows autostart. The per-user Windows Task
Scheduler Interactive logon registration was separately checked with a
harmless test task and cleaned up. Existing real device credentials were
not used in the smoke test.

**Do not use \`--no-browser\` or copy config files as a way around owner
authorization.** Browser consent is still required the first time.

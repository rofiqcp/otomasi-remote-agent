#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import WebSocket from "ws";

const VERSION = "0.1.5";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const CONFIG_DIR =
  process.env.OTOMASI_RDC_CONFIG_DIR || path.join(os.homedir(), ".otomasi-rdc");
const CONFIG_PATH = path.join(CONFIG_DIR, "device.json");
const PAUSE_PATH = path.join(CONFIG_DIR, "remote-access-paused.flag");

function argValue(name, fallback = undefined) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function has(name) {
  return process.argv.includes(name);
}

function printHelp() {
  console.log(`Otomasi RDC Remote Agent v${VERSION}

Usage:
  npx @otomasi/remote@latest [options]
  npx @otomasi/remote@latest remote [options]
  otomasi [options]
  otomasi remote [options]

Examples:
  npx @otomasi/remote@latest --help
  otomasi --version
  otomasi remote --name my-workstation

Options:
  --hub <url>             Hub URL (default: https://mcp.otomasi.app)
  --name <device-name>    Device display name (default: hostname)
  --enroll-token <token>  One-time/admin enrollment token
  --executor <package>    Local MCP executor package
  --no-browser            Print pairing URL without opening browser
  --no-pm2                Stay in foreground; do not install PM2
  --foreground            Run in foreground (for systemd/PM2 services)
  --logout                Remove local device credentials
  --resume                Resume remote access after an authorized pause
  --version               Print CLI version
  --debug                 Verbose logging
  -h, --help              Show help

Environment:
  OTOMASI_RDC_HUB
  OTOMASI_RDC_ENROLL_TOKEN
  OTOMASI_RDC_EXECUTOR

The local device only makes outbound connections to the hub.
`);
}

async function loadConfig() {
  try {
    return JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
  } catch {
    return null;
  }
}

async function saveConfig(config) {
  await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  try { await fs.chmod(CONFIG_PATH, 0o600); } catch {}
}

async function logout() {
  await fs.rm(CONFIG_PATH, { force: true });
  console.log(`Removed local credentials: ${CONFIG_PATH}`);
}

function normalizeHub(hub) {
  return hub.replace(/\/+$/, "");
}

function wsFromHub(hub) {
  return normalizeHub(hub)
    .replace(/^https:/, "wss:")
    .replace(/^http:/, "ws:") + "/device/ws";
}

async function launchExternal(command, args) {
  return await new Promise((resolve) => {
    let done = false;
    let timer;
    let child;
    const settle = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(ok);
    };
    try {
      child = spawn(command, args, {
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: "ignore",
      });
      timer = setTimeout(() => settle(false), 9000);
      child.once("error", () => settle(false));
      child.once("close", (code) => settle(code === 0));
    } catch {
      settle(false);
    }
  });
}

async function openVerificationPage(url) {
  const target = new URL(url);
  const verificationCode = target.searchParams.get("code") || "";
  if (target.pathname !== "/connect" ||
      !/^[A-Z2-7]{4}(?:-[A-Z2-7]{4}){3}$/.test(verificationCode)) {
    throw new Error("Invalid verification link: refusing to launch browser.");
  }
  if (process.platform === "win32") {
    // Tested on win-dell: PowerShell Start-Process dispatches an HTTPS URI
    // to the Windows user's configured default browser (Chrome in this case).
    // Unlike fire-and-forget rundll32, this checks the launcher exit code.
    const safe = url.replace(/'/g, "''");
    const opened = await launchExternal("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "Start-Process -FilePath '" + safe + "' -ErrorAction Stop",
    ]);
    if (opened) return true;
    // Fallback to the Windows protocol handler.
    return await launchExternal("rundll32.exe",
      ["url.dll,FileProtocolHandler", url]);
  }
  if (process.platform === "darwin") {
    return await launchExternal("open", [url]);
  }
  return await launchExternal("xdg-open", [url]);
}


async function requestBrowserEnrollment({ hub, name }) {
  console.log("First run: browser authorization required.");
  const start = await fetch(hub + "/device/authorization", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, platform: process.platform + "/" + process.arch }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await start.json().catch(() => ({}));
  if (!start.ok) throw new Error(
    data.error || "Could not begin pairing (HTTP " + start.status + ")."
  );
  if (!data.device_code || !data.verification_uri_complete) {
    throw new Error("Server returned an incomplete pairing response.");
  }
  const remote = new URL(data.verification_uri_complete);
  const expected = new URL(hub);
  if (remote.origin !== expected.origin || remote.protocol !== expected.protocol) {
    throw new Error("Unexpected pairing origin: refusing to open the link.");
  }
  console.log("PAIR THIS COMPUTER");
  console.log("Code: " + data.user_code);
  console.log("Open: " + data.verification_uri_complete);
  console.log("Login using the SAME Otomasi account as ChatGPT / Claude.");
  console.log("Review the computer name and explicitly approve the request.");

  if (has("--no-browser")) {
    console.log("Browser auto-open skipped (--no-browser). Open the link above manually.");
  } else {
    const opened = await openVerificationPage(remote.href);
    if (opened) {
      console.log("Browser opened automatically. Check your default browser.");
    } else {
      console.log("Could not open the browser automatically.");
      console.log("Open the verification URL above, sign in, and approve this computer.");
    }
  }
  console.log("Waiting for approval (Ctrl+C to cancel)...");
  const until = Date.now() + Math.min(900, data.expires_in || 600) * 1000;
  const delay = Math.max(3000, (data.interval || 3) * 1000);
  while (Date.now() < until) {
    await sleep(delay);
    let response;
    try {
      response = await fetch(hub + "/device/authorization/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_code: data.device_code }),
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      console.log("Waiting for pairing server: " + (error.message || error));
      continue;
    }
    const result = await response.json().catch(() => ({}));
    if (response.status === 202) continue;
    if (!response.ok) {
      throw new Error("Pairing failed: " + (result.error || response.status));
    }
    if (!result.device_id || !result.device_token) {
      throw new Error("Pairing response missing device credentials.");
    }
    const config = {
      hub, device_id: result.device_id, device_token: result.device_token,
      ws_url: result.ws_url || wsFromHub(hub), name,
      created_at: new Date().toISOString(),
    };
    await saveConfig(config);
    console.log("Pairing approved. Device identity stored locally.");
    return config;
  }
  throw new Error("Pairing timed out. Run the command again to get a new code.");
}


async function enroll({ hub, enrollToken, name }) {
  const isLocalHub = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(normalizeHub(hub));
  if (!enrollToken && !isLocalHub) {
    throw new Error(
      "First-time connection requires authorization. Ask the hub administrator for a one-time enrollment token, then set OTOMASI_RDC_ENROLL_TOKEN in your environment before running this command again. Browser account pairing is not yet available."
    );
  }
  const headers = { "content-type": "application/json" };
  if (enrollToken) headers["x-enroll-token"] = enrollToken;
  const response = await fetch(normalizeHub(hub) + "/device/enroll", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name,
      platform: `${process.platform}/${process.arch}`,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Enrollment failed: HTTP ${response.status}`);
  }
  const config = {
    hub: normalizeHub(hub),
    device_id: data.device_id,
    device_token: data.device_token,
    ws_url: wsFromHub(hub),
    name,
    created_at: new Date().toISOString(),
  };
  await saveConfig(config);
  return config;
}

async function startLocalExecutor(executorPackage, debug) {
  const bundledDefault = "@wonderwhy-er/desktop-commander@latest";
  let command;
  let args;

  if (executorPackage === bundledDefault) {
    command = process.execPath;
    const desktopCommanderPackage = require.resolve(
      "@wonderwhy-er/desktop-commander/package.json"
    );
    args = [
      path.resolve(path.dirname(desktopCommanderPackage), "dist/index.js"),
      "--no-onboarding",
    ];
  } else {
    command = process.platform === "win32" ? "npx.cmd" : "npx";
    args = ["-y", executorPackage];
  }

  if (debug) console.log("Starting local MCP executor:", command, ...args);

  const transport = new StdioClientTransport({
    command,
    args,
    stderr: "pipe",
  });
  const client = new Client(
    { name: "otomasi-rdc-agent", version: VERSION },
    { capabilities: {} }
  );
  await client.connect(transport);
  const listed = await client.listTools();
  return {
    client,
    transport,
    tools: listed.tools || [],
    async close() {
      try { await client.close(); } catch {}
      try { await transport.close(); } catch {}
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectOnce(config, local, debug) {
  const wsUrl = new URL(config.ws_url || wsFromHub(config.hub));
  wsUrl.searchParams.set("device_id", config.device_id);

  return new Promise((resolve, reject) => {
    let opened = false;
    const ws = new WebSocket(wsUrl, {
      headers: { Authorization: "Bearer " + config.device_token },
      perMessageDeflate: false,
    });
    let heartbeat;

    const send = (obj) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    };

    ws.once("open", () => {
      opened = true;
      console.log(`Connected: ${config.name} -> ${config.hub}`);
      console.log(`Device ID: ${config.device_id}`);
      console.log(`Local tools: ${local.tools.length}`);
      send({
        type: "hello",
        tools: local.tools,
        meta: {
          name: config.name,
          hostname: os.hostname(),
          platform: `${process.platform}/${process.arch}`,
          node: process.version,
          agent_version: VERSION,
          supports_remote_stop: true,
        },
      });
      heartbeat = setInterval(
        () => send({ type: "heartbeat", ts: Date.now() }),
        20000
      );
    });

    ws.on("message", async (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (debug) console.log("hub>", message.type, message.name || "");

      if (message.type === "ready") {
        console.log("Status: online and ready for remote MCP calls");
        return;
      }
      if (message.type === "stop_agent") {
        // An owner-authorized remote stop pauses access without changing tokens.
        // Persist the pause locally so an external supervisor cannot reconnect.
        await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
        await fs.writeFile(PAUSE_PATH, new Date().toISOString(), { mode: 0o600 });
        send({ type: "stop_ack" });
        await sleep(120);
        ws.close(4003, "owner paused remote access");
        return;
      }
      if (message.type !== "call") return;

      if (message.name === "__ping__") {
        send({
          type: "result",
          id: message.id,
          result: {
            ok: true,
            hostname: os.hostname(),
            ts: Date.now(),
          },
        });
        return;
      }

      try {
        const result = await local.client.callTool({
          name: message.name,
          arguments: message.arguments || {},
          _meta: { remote: true, deviceId: config.device_id },
        });
        send({ type: "result", id: message.id, result });
      } catch (error) {
        send({
          type: "error",
          id: message.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    ws.once("error", (error) => {
      if (!opened) reject(error);
      else if (debug) console.error("WebSocket error:", error.message);
    });

    ws.once("close", (code, reason) => {
      if (heartbeat) clearInterval(heartbeat);
      if (debug) console.log("WebSocket closed:", code, reason.toString());
      if (opened) resolve();
      else reject(new Error(`WebSocket closed before connect: ${code}`));
    });
  });
}

async function runRemote() {
  if (has("--help") || has("-h")) {
    printHelp();
    return;
  }
  if (has("--logout")) {
    await logout();
    return;
  }
  if (has("--resume")) {
    await fs.rm(PAUSE_PATH, { force: true });
    console.log("Remote access resume requested; the running agent will reconnect.");
    return;
  }

  const debug = has("--debug");
  const hub = normalizeHub(
    argValue("--hub", process.env.OTOMASI_RDC_HUB || "https://mcp.otomasi.app")
  );
  const name = argValue("--name", os.hostname());
  const enrollToken =
    argValue("--enroll-token", process.env.OTOMASI_RDC_ENROLL_TOKEN);
  const executorPackage = argValue(
    "--executor",
    process.env.OTOMASI_RDC_EXECUTOR ||
      "@wonderwhy-er/desktop-commander@latest"
  );

  console.log("");
  console.log("  ╭────────────────────────────────────────────────────╮");
  console.log("  │              OTOMASI  •  REMOTE  MCP               │");
  console.log("  │       Windows · Linux · macOS → ChatGPT / AI        │");
  console.log("  ╰────────────────────────────────────────────────────╯");
  console.log("  Agent v" + VERSION + "  |  " + hub);
  console.log("");

  let config = await loadConfig();
  if (!config) {
    if (enrollToken) {
      console.log("First run: enrolling using a one-time code...");
      config = await enroll({ hub, enrollToken, name });
    } else {
      config = await requestBrowserEnrollment({ hub, name });
    }
    console.log("Enrollment complete; credentials saved locally.");
  }

  const managedExternally =
    has("--foreground") || has("--no-pm2") ||
    process.env.OTOMASI_RDC_SKIP_PM2 === "1" ||
    process.env.pm_id !== undefined ||
    process.env.INVOCATION_ID !== undefined;
  if (!managedExternally) {
    try {
      const { ensureManaged } = await import("./pm2-manager.js");
      const registeredName = config.name || name;
      if (registeredName !== name && has("--name")) {
        console.log("Device already registered as '" + registeredName +
                    "'; keeping its existing PM2 identity.");
      }
      await ensureManaged({ name: registeredName, configDir: CONFIG_DIR, version: VERSION });
      return;
    } catch (error) {
      console.error("PM2 automatic setup failed:", error.message || String(error));
      console.error("Falling back to foreground mode; the computer will still connect.");
    }
  }
  const local = await startLocalExecutor(executorPackage, debug);
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await local.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let delay = 1000;
  while (!stopped) {
    // Idle while paused; this also works with systemd Restart=always and PM2.
    while (!stopped && await fs.access(PAUSE_PATH).then(() => true, () => false)) {
      await sleep(2000);
    }
    if (stopped) break;
    try {
      await connectOnce(config, local, debug);
      delay = 1000;
    } catch (error) {
      console.error("Connection failed:", error.message || String(error));
    }
    if (stopped) break;
    console.log(`Reconnecting in ${Math.round(delay / 1000)}s...`);
    await sleep(delay);
    delay = Math.min(delay * 2, 30000);
  }
}

async function main() {
  const command = process.argv[2];
  if (command === "--version" || command === "-v" || command === "version") {
    console.log(VERSION);
    return;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    printHelp();
    return;
  }
  if (!command || command === "remote" || command === "connect" ||
      command.startsWith("-")) {
    await runRemote();
    return;
  }
  throw new Error("Unknown command: " + command + ". Use otomasi --help.");
}

main().catch((error) => {
  console.error("Fatal:", error.message || String(error));
  process.exitCode = 1;
});

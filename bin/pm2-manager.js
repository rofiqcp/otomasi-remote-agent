import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PM2_VERSION = "7.0.4";

export function managedName(name, configDir) {
  const label = String(name).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 20) || "device";
  const hash = crypto.createHash("sha256").update(path.resolve(configDir)).digest("hex").slice(0, 8);
  return "otomasi-" + label + "-" + hash;
}

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

export function npmCandidates(nodePath = process.execPath) {
  const d = path.dirname(nodePath);
  return [
    path.join(d, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(d, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(d, "..", "node_modules", "npm", "bin", "npm-cli.js")
  ];
}

export async function runCommand(exe, argv, opts={}) {
  return new Promise((resolve, reject) => {
    let out = "", err = "", completed = false;
    const p = spawn(exe, argv, { cwd: opts.cwd || os.homedir(),
      env: opts.env || process.env, windowsHide: true, shell: false, stdio: ["ignore","pipe","pipe"] });
    const deadline = setTimeout(() => { if (!completed) p.kill(); }, opts.timeout || 180000);
    p.stdout.on("data", b => { out = (out + b).slice(-120000); });
    p.stderr.on("data", b => { err = (err + b).slice(-120000); });
    p.on("error", e => { clearTimeout(deadline); reject(e); });
    p.on("close", code => {
      completed = true; clearTimeout(deadline);
      if (code === 0) resolve({stdout: out, stderr: err});
      else reject(new Error(path.basename(exe) + " failed " + code + ": " + (err || out).slice(-1000)));
    });
  });
}

async function npm(argv, opts={}) {
  for (const p of npmCandidates()) {
    if (await exists(p)) return runCommand(process.execPath, [p, ...argv], opts);
  }
  if (process.platform === "win32") throw new Error("Cannot find npm-cli.js beside Node.js");
  return runCommand("npm", argv, opts);
}

async function pm2(runtime, argv, opts={}) {
  const bin = path.join(runtime, "node_modules", "pm2", "bin", "pm2");
  return runCommand(process.execPath, [bin, ...argv], { timeout: 55000, ...opts });
}

export function ecosystem({ name, configDir, runtime, nodePath=process.execPath }) {
  const runFile = path.join(runtime, "node_modules", "@otomasi", "remote", "bin", "rdc.js");
  return { apps: [{
    name: managedName(name, configDir), script: runFile,
    interpreter: nodePath, cwd: runtime,
    args: ["remote", "--name", name, "--foreground"],
    env: { OTOMASI_RDC_CONFIG_DIR: configDir, OTOMASI_RDC_SKIP_PM2: "1" },
    autorestart: true, restart_delay: 5000, min_uptime: 10000,
    max_restarts: 15, kill_timeout: 7000, time: true
  }] };
}

export function existingAgentForConfig(p, configDir) {
  const info = p?.pm2_env || {};
  if (!/[\\/]@otomasi[\\/]remote[\\/]bin[\\/]rdc\.js$/i.test(info.pm_exec_path || "")) {
    return false;
  }
  const scope = info.env?.OTOMASI_RDC_CONFIG_DIR ||
    info.OTOMASI_RDC_CONFIG_DIR || path.join(os.homedir(), ".otomasi-rdc");
  const normalized = value => path.resolve(value).replace(/\\/g, "/").toLowerCase();
  return normalized(scope) === normalized(configDir);
}

export function windowsStartupCmd(nodePath, pm2Script) {
  if (/[\r\n"%]/.test(nodePath + pm2Script)) throw new Error("Unsafe Windows startup path");
  return "@echo off\r\nset \"PATH=" + path.dirname(nodePath) +
    ";%PATH%\"\r\n\"" + nodePath + "\" \"" + pm2Script + "\" resurrect\r\n";
}

async function windowsAutostart(runtime) {
  const startup = path.join(os.homedir(), ".otomasi-rdc", "startup");
  await fs.mkdir(startup, { recursive: true, mode: 0o700 });
  const cmd = path.join(startup, "resurrect-pm2.cmd");
  const vbs = path.join(startup, "resurrect-pm2.vbs");
  const pm = path.join(runtime, "node_modules", "pm2", "bin", "pm2");
  await fs.writeFile(cmd, windowsStartupCmd(process.execPath, pm));
  const q = cmd.replace(/"/g, '""');
  await fs.writeFile(vbs, 'Set shell = CreateObject("WScript.Shell")\r\n' +
    'shell.Run Chr(34) & "' + q + '" & Chr(34), 0, False\r\n');
  const action = 'wscript.exe "' + vbs + '"';
  try {
    // Register the *current user's* interactive logon task. Never use
    // schtasks defaults, which could create the task for another account.
    const safeArg = ('"' + vbs + '"').replace(/'/g, "''");
    const script = "$user=[Security.Principal.WindowsIdentity]::GetCurrent().Name; " +
      "$a=New-ScheduledTaskAction -Execute 'wscript.exe' -Argument '" + safeArg + "'; " +
      "$t=New-ScheduledTaskTrigger -AtLogOn -User $user; " +
      "$p=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited; " +
      "Register-ScheduledTask -TaskName 'Otomasi Remote PM2' " +
      "-Action $a -Trigger $t -Principal $p -Force -ErrorAction Stop | Out-Null";
    await runCommand("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 20000 });
    console.log("Autostart: per-user Windows Task Scheduler at logon");
    return "task-scheduler";
  } catch {
    const ps = "New-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'OtomasiRemotePM2' -Value '" +
      action.replace(/'/g, "''") + "' -PropertyType String -Force | Out-Null";
    await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 20000 });
    console.log("Autostart: Windows HKCU Run at user logon");
    return "hkcu-run";
  }
}

async function linuxAutostart(runtime) {
  // Use an existing boot-enabled PM2 service if it already supervises the
  // default PM2_HOME. Avoid installing a competing user-session resurrection.
  const pm2Home = process.env.PM2_HOME || path.join(os.homedir(), ".pm2");
  if (path.resolve(pm2Home) === path.join(os.homedir(), ".pm2")) {
    const systemUnit = "pm2-" + os.userInfo().username + ".service";
    try {
      const enabled = (await runCommand("systemctl", ["is-enabled", systemUnit], {timeout:6000})).stdout.trim();
      const active = (await runCommand("systemctl", ["is-active", systemUnit], {timeout:6000})).stdout.trim();
      if (enabled === "enabled" && active === "active") {
        console.log("Autostart: existing Linux systemd PM2 boot service " + systemUnit);
        return "systemd-system-existing";
      }
    } catch { /* no suitable existing system PM2 service */ }
  }
  const dir = path.join(os.homedir(), ".config", "systemd", "user");
  await fs.mkdir(dir, {recursive:true});
  const pm = path.join(runtime, "node_modules", "pm2", "bin", "pm2");
  if (/\s/.test(process.execPath + pm)) throw new Error("Linux user systemd paths cannot contain whitespace");
  const unit = path.join(dir, "otomasi-remote-pm2.service");
  const service = [
    "[Unit]", "Description=Otomasi Remote PM2 daemon resurrection",
    "After=network-online.target", "Wants=network-online.target", "",
    "[Service]", "Type=oneshot", "RemainAfterExit=yes",
    "Environment=PATH=" + path.dirname(process.execPath) + ":/usr/local/bin:/usr/bin:/bin",
    "ExecStart=" + process.execPath + " " + pm + " resurrect",
    "TimeoutStartSec=90", "",
    "[Install]", "WantedBy=default.target", ""
  ].join("\n");
  await fs.writeFile(unit, service);
  try {
    await runCommand("systemctl", ["--user", "daemon-reload"], {timeout:15000});
    await runCommand("systemctl", ["--user", "enable", "--now", "otomasi-remote-pm2.service"], {timeout:30000});
    console.log("Autostart: Linux user systemd at login");
    return "systemd-user";
  } catch {
    const dir2 = path.join(os.homedir(), ".config", "autostart");
    await fs.mkdir(dir2, {recursive:true});
    await fs.writeFile(path.join(dir2, "otomasi-remote-pm2.desktop"), [
      "[Desktop Entry]", "Type=Application", "Name=Otomasi Remote PM2",
      "Exec=" + process.execPath + " " + pm + " resurrect",
      "X-GNOME-Autostart-enabled=true", "Terminal=false", ""
    ].join("\n"));
    console.log("Autostart: Linux desktop fallback; headless servers need user systemd");
    return "xdg-desktop";
  }
}

async function macAutostart(runtime) {
  const dir = path.join(os.homedir(), "Library", "LaunchAgents");
  await fs.mkdir(dir, {recursive:true});
  const file = path.join(dir, "app.otomasi.remote.pm2.plist");
  const pm = path.join(runtime, "node_modules", "pm2", "bin", "pm2");
  const esc = v => v.replaceAll("&", "&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
  const content = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0"><dict><key>Label</key><string>app.otomasi.remote.pm2</string>' +
    '<key>ProgramArguments</key><array><string>' + esc(process.execPath) +
    '</string><string>' + esc(pm) + '</string><string>resurrect</string></array>' +
    '<key>RunAtLoad</key><true/></dict></plist>\n';
  await fs.writeFile(file, content);
  try { await runCommand("launchctl", ["bootstrap", "gui/" + process.getuid(), file], {timeout:14000}); } catch {}
  console.log("Autostart: macOS user LaunchAgent");
  return "launch-agent";
}

export function npmPackFilename(output, version) {
  // npm CLI releases return either an array or an object keyed by package name.
  // Never trust the filename as an arbitrary filesystem path.
  const value = typeof output === "string" ? JSON.parse(output) : output;
  const record = Array.isArray(value)
    ? value.find(p => p?.name === "@otomasi/remote" && p?.version === version)
    : value?.["@otomasi/remote"] || value;
  if (record?.name !== "@otomasi/remote" || record?.version !== version ||
      !/^\d+\.\d+\.\d+$/.test(version) ||
      record?.filename !== `otomasi-remote-${version}.tgz`) {
    throw new Error("npm pack returned an invalid filename or package identity");
  }
  return record.filename;
}

async function createStableRuntime(runtime, version) {
  const entry = path.join(runtime, "node_modules", "@otomasi", "remote", "package.json");
  const pm = path.join(runtime, "node_modules", "pm2", "bin", "pm2");
  if (await exists(entry) && await exists(pm)) {
    try { if (JSON.parse(await fs.readFile(entry,"utf8")).version === version) return false; } catch {}
  }
  console.log("Installing permanent local agent and PM2 (not inside npx cache)...");
  const cache = path.join(runtime, ".packages");
  await fs.mkdir(cache, { recursive: true, mode: 0o700 });
  const response = await npm(["pack",PACKAGE_ROOT,"--ignore-scripts","--json","--pack-destination",cache],{timeout:60000});
  const name = npmPackFilename(response.stdout, version);
  if (!await exists(path.join(cache, name))) throw new Error("npm pack did not create its declared archive");
  await npm(["install","--prefix",runtime,"--no-save","--no-audit","--no-fund","--ignore-scripts",
    path.join(cache,name),"pm2@" + PM2_VERSION],{timeout:240000});
  if (!await exists(entry) || !await exists(pm)) throw new Error("Agent or PM2 installation incomplete");
  return true;
}

async function optionalGlobalPm2() {
  try {
    await runCommand(process.platform === "win32" ? "where.exe" : "which", ["pm2"], {timeout:4000});
    return;
  } catch {}
  try {
    console.log("Installing global PM2 command if account permissions allow it...");
    await npm(["install","--global","--no-audit","--no-fund","pm2@" + PM2_VERSION],{timeout:160000});
  } catch {
    console.log("Global PM2 is unavailable; permanent private PM2 remains installed");
  }
}

export async function ensureManaged({name,configDir,version}) {
  configDir=path.resolve(configDir);
  const runtime=path.join(configDir,"runtime");
  const updated=await createStableRuntime(runtime,version);
  const model=ecosystem({name,configDir,runtime});
  const app=model.apps[0];
  const file=path.join(runtime,"ecosystem.config.cjs");
  await fs.writeFile(file,"module.exports = "+JSON.stringify(model,null,2)+";\n",{mode:0o600});
  let processes=[];
  try {
    processes=JSON.parse((await pm2(runtime,["jlist"])).stdout);
    if(!Array.isArray(processes)) processes=[];
  } catch {}
  const existing=processes.find(x=>x.name===app.name);
  const legacy=processes.find(x=>x.name!==app.name &&
    x.pm2_env?.status==="online" && existingAgentForConfig(x, configDir));
  if (legacy) {
    // Never start a second websocket connection with an existing device
    // identity. PM2's original process and account ownership remain intact.
    await pm2(runtime, ["save", "--force"]);
    console.log("Existing PM2 agent already owns this device identity: "+legacy.name);
    console.log("No second PM2 process was created. To upgrade the original, stop");
    console.log("it intentionally before re-running this installer.");
    return true;
  }
  if (existing && path.resolve(existing.pm2_env?.pm_exec_path || "") !== path.resolve(app.script)) {
    throw new Error("PM2 name collision; existing app points to another script");
  }
  if (!existing) await pm2(runtime,["start",file,"--only",app.name]);
  else if (updated || existing.pm2_env?.status !== "online") {
    await pm2(runtime,["restart",file,"--only",app.name,"--update-env"]);
  } else console.log("Already online under PM2: "+app.name);
  await pm2(runtime,["save","--force"]);
  let persistence = "not configured";
  if (process.env.OTOMASI_RDC_PM2_TEST_MODE === "1") {
    persistence = "test-mode (startup unchanged)";
  } else {
    try {
      persistence = process.platform==="win32" ? await windowsAutostart(runtime) :
        process.platform==="darwin" ? await macAutostart(runtime) : await linuxAutostart(runtime);
    } catch (error) {
      // A running PM2 app must not be replaced by a foreground agent merely
      // because startup registration was denied by local policy.
      console.error("Autostart registration failed; PM2 remains online:", error.message);
    }
    await optionalGlobalPm2();
  }
  console.log("Managed PM2 app: "+app.name+"; autostart: "+persistence);
  console.log("Remote agent remains online after this terminal closes");
  return true;
}

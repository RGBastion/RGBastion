"use strict";

const { app, BrowserWindow, powerSaveBlocker, dialog, ipcMain, shell } = require("electron");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const PREFERRED_PORT = 8765;
const WINDOW_TITLE = "RedGalaxy Bastion";
const UPDATE_MANIFEST_URL = "https://updates.redgalaxygame.space/latest.json";
/**
 * Bastion self-update manifest (separate from game asset updates).
 * Override with env BASTION_UPDATE_MANIFEST_URL if needed.
 * Example file: tools/bastion-update-manifest.example.json
 * Release asset URL:
 *   https://github.com/RGBastion/RGBastion/releases/latest/download/bastion-latest.json
 */
const BASTION_UPDATE_MANIFEST_URL = (
  process.env.BASTION_UPDATE_MANIFEST_URL ||
  "https://github.com/RGBastion/RGBastion/releases/latest/download/bastion-latest.json"
).trim();
const UPDATE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) RedGalaxy-Bastion-Updater/1.0";

let mainWindow = null;
let server = null;
let powerSaveId = null;
let activeWebRoot = null;
let updateRunning = false;
let bastionUpdateRunning = false;
let updateStatus = {
  running: false,
  phase: "idle",
  percent: 0,
  message: "",
  error: "",
  remote: "",
  kind: "game",
  updatedAt: 0,
};

function bastionAppVersion() {
  try {
    const v = String(app.getVersion() || "").trim();
    if (v) return v;
  } catch {
    /* ignore */
  }
  return "1.0.5";
}

function playerSafeBastionNotes(notes) {
  const trimmed = String(notes || "").trim();
  if (!trimmed) return "";
  const lower = trimmed.toLowerCase();
  const blocked = [
    "upload this file",
    "release asset",
    "bump version",
    "owner/repo",
    "github.com/",
    "trascina",
    "developer",
    "ricostruisci",
    "manifest",
  ];
  if (blocked.some((needle) => lower.includes(needle))) {
    return "";
  }
  return trimmed;
}

function bastionReplaceableExePath() {
  const portable = String(process.env.PORTABLE_EXECUTABLE_FILE || "").trim();
  if (portable && fs.existsSync(portable)) {
    return portable;
  }
  if (app.isPackaged) {
    const exe = process.execPath;
    if (exe && /\.exe$/i.test(exe)) {
      return exe;
    }
  }
  return "";
}

function scheduleWindowsExeSwapAndRelaunch(currentExe, newExe) {
  const batPath = path.join(
    app.getPath("temp"),
    `bastion-relaunch-${process.pid}-${Date.now()}.bat`
  );
  const bat = [
    "@echo off",
    "setlocal",
    `set "TARGET=${currentExe}"`,
    `set "SOURCE=${newExe}"`,
    `set "PID=${process.pid}"`,
    ":wait",
    'tasklist /FI "PID eq %PID%" 2>NUL | find "%PID%" >NUL',
    "if not errorlevel 1 (",
    "  timeout /t 1 /nobreak >NUL",
    "  goto wait",
    ")",
    "timeout /t 1 /nobreak >NUL",
    'copy /Y "%SOURCE%" "%TARGET%" >NUL',
    "if errorlevel 1 (",
    '  move /Y "%SOURCE%" "%TARGET%" >NUL',
    ")",
    'start "" "%TARGET%"',
    'del /F /Q "%SOURCE%" >NUL 2>&1',
    `del /F /Q "${batPath}" >NUL 2>&1`,
    "endlocal",
    "",
  ].join("\r\n");
  fs.writeFileSync(batPath, bat, "utf8");
  const child = spawn("cmd.exe", ["/c", batPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  setTimeout(() => {
    app.quit();
  }, 400);
}

function isBastionManifestConfigured(url = BASTION_UPDATE_MANIFEST_URL) {
  const u = String(url || "").trim();
  if (!u) return false;
  if (/OWNER\/REPO/i.test(u)) return false;
  if (/example\.com|localhost|placeholder/i.test(u)) return false;
  return /^https?:\/\//i.test(u);
}

function setUpdateStatus(patch) {
  updateStatus = {
    ...updateStatus,
    ...patch,
    updatedAt: Date.now(),
  };
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
    case ".map":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".ogg":
      return "audio/ogg";
    case ".wav":
      return "audio/wav";
    case ".atlas":
    case ".txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function supportDir() {
  return path.join(app.getPath("userData"), "game-web");
}

function versionFilePath() {
  return path.join(app.getPath("userData"), "version.txt");
}

function userWebRoot() {
  return path.join(supportDir(), "web");
}

function bundledWebRoot() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "web");
  }
  return path.join(__dirname, "web");
}

function storySrcRoot() {
  const bundledStory = path.join(bundledWebRoot(), "story");
  if (fs.existsSync(path.join(bundledStory, "autopilot.js"))) {
    return bundledStory;
  }
  const devStory = path.join(__dirname, "..", "story");
  if (fs.existsSync(path.join(devStory, "redgalaxy_story_autopilot.js"))) {
    return devStory;
  }
  return bundledStory;
}

function toolsDir() {
  if (app.isPackaged) {
    return process.resourcesPath;
  }
  return path.join(__dirname, "..");
}

function webRootLooksValid(webRoot, requireStory) {
  if (!webRoot || !fs.existsSync(path.join(webRoot, "index.html"))) {
    return false;
  }
  if (requireStory) {
    return bastionWebRootIsIntact(webRoot);
  }
  return true;
}

/**
 * Complete Bastion overlay: story files + index markers + game/net hooks.
 * story/ alone on a raw extract is NOT enough (features appear "missing").
 */
function bastionWebRootIsIntact(webRoot) {
  if (!webRoot) return false;
  const indexPath = path.join(webRoot, "index.html");
  const autopilot = path.join(webRoot, "story", "autopilot.js");
  const i18n = path.join(webRoot, "story", "i18n.js");
  if (!fs.existsSync(indexPath) || !fs.existsSync(autopilot) || !fs.existsSync(i18n)) {
    return false;
  }
  let html;
  try {
    html = fs.readFileSync(indexPath, "utf8");
  } catch {
    return false;
  }
  if (
    !html.includes("__RG_STORY_MODE__") ||
    !html.includes("/story/i18n.js") ||
    !html.includes("/story/autopilot.js")
  ) {
    return false;
  }
  const m = html.match(/\/assets\/(index-[^"' ]+\.js)/);
  if (!m) return false;
  const assetPath = path.join(webRoot, "assets", m[1]);
  if (!fs.existsSync(assetPath)) return false;
  let js;
  try {
    js = fs.readFileSync(assetPath, "utf8");
  } catch {
    return false;
  }
  return js.includes("__RG_GAME__") && js.includes("__RG_NET__");
}

function filesEqual(a, b) {
  try {
    if (!fs.existsSync(a) || !fs.existsSync(b)) return false;
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

const BASTION_STAMP_NAME = ".bastion-stamp";

/**
 * Prefer .bastion-stamp. Missing user stamp while bundle has one = force refresh.
 * Older bundles without a stamp fall back to critical file bytes.
 */
function storyStampMatches(bundleStory, userStory) {
  const bundleStamp = path.join(bundleStory, BASTION_STAMP_NAME);
  const userStamp = path.join(userStory, BASTION_STAMP_NAME);
  if (!fs.existsSync(bundleStamp)) return true;
  if (!fs.existsSync(userStamp)) return false;
  return filesEqual(bundleStamp, userStamp);
}

function storyOverlayMatchesBundle(bundleStory, userStory) {
  if (!storyStampMatches(bundleStory, userStory)) return false;
  const critical = ["autopilot.js", "i18n.js", "map_graph.json"];
  return critical.every((name) => {
    const bundlePath = path.join(bundleStory, name);
    if (!fs.existsSync(bundlePath)) return true;
    return filesEqual(bundlePath, path.join(userStory, name));
  });
}

/**
 * Mirror macOS Bastion: when %APPDATA% game-web exists, refresh story/ from the
 * bundled app when stamp or any critical story file is missing or mismatched.
 * Returns true when story/ was rewritten.
 */
function syncBundledStoryOverlayIntoUserWeb() {
  const userWeb = userWebRoot();
  const bundleStory = path.join(bundledWebRoot(), "story");
  const userStory = path.join(userWeb, "story");
  const bundleAutopilot = path.join(bundleStory, "autopilot.js");

  if (!fs.existsSync(bundleAutopilot)) return false;
  if (!webRootLooksValid(userWeb, false)) return false;

  try {
    if (storyOverlayMatchesBundle(bundleStory, userStory)) {
      console.log("Story overlay already matches bundle:", userStory);
      return false;
    }

    const staging = path.join(userWeb, ".story-sync-tmp");
    fs.rmSync(staging, { recursive: true, force: true });
    fs.cpSync(bundleStory, staging, { recursive: true });
    fs.rmSync(userStory, { recursive: true, force: true });
    fs.renameSync(staging, userStory);
    console.log("Synced bundled story overlay into", userStory, "(stamp/content refresh)");
    return true;
  } catch (err) {
    console.warn("Failed to sync bundled story overlay:", err.message || err);
    return false;
  }
}

async function ensureBastionOverlayInUserWeb() {
  const userWeb = userWebRoot();
  if (!webRootLooksValid(userWeb, false)) {
    return { repaired: false, reason: "no-user-web" };
  }

  const bundleStory = path.join(bundledWebRoot(), "story");
  const userStory = path.join(userWeb, "story");
  const storyFresh = storyOverlayMatchesBundle(bundleStory, userStory);

  if (bastionWebRootIsIntact(userWeb) && storyFresh) {
    return { repaired: false, reason: "intact" };
  }

  const storySrc = storySrcRoot();
  const patcherJs = nodeToolPath("apply_bastion_patches.js");
  const patcherPy = nodeToolPath("apply_bastion_patches.py");
  try {
    if (fs.existsSync(patcherJs)) {
      await runNodeTool(patcherJs, ["--in-place", userWeb, "--story-src", storySrc]);
    } else if (fs.existsSync(patcherPy)) {
      const py = await resolveRealPython();
      await runCommand(py.cmd, [...py.prefix, patcherPy, "--in-place", userWeb, "--story-src", storySrc], {
        timeoutMs: 300000,
      });
    } else {
      throw new Error("apply_bastion_patches missing from resources");
    }
  } catch (err) {
    console.warn("Bastion in-place repair failed:", err.message || err);
    return { repaired: false, reason: "repair-failed", error: String(err && err.message ? err.message : err) };
  }

  if (!bastionWebRootIsIntact(userWeb)) {
    return { repaired: false, reason: "still-incomplete" };
  }
  console.log("Repaired Bastion overlay in place at", userWeb);
  return { repaired: true, reason: "repaired", webRoot: userWeb };
}

function resolveWebRoot() {
  const storySynced = syncBundledStoryOverlayIntoUserWeb();
  // Synchronous path cannot await patcher; kick a best-effort sync-only preference.
  // Full in-place repair runs from start()/triggerGameUpdate ensure path.
  void storySynced;

  const envRoot = process.env.REDGALAXY_WEB_ROOT;
  if (envRoot && webRootLooksValid(envRoot, false)) {
    return path.resolve(envRoot);
  }

  const userRoot = userWebRoot();
  if (webRootLooksValid(userRoot, true)) {
    return userRoot;
  }

  if (app.isPackaged) {
    const packaged = bundledWebRoot();
    if (webRootLooksValid(packaged, false)) {
      return packaged;
    }
  }

  const candidates = [
    path.join(__dirname, "web"),
    path.join(__dirname, "..", "..", "artifacts", "redgalaxy-story-web"),
  ];
  for (const candidate of candidates) {
    if (webRootLooksValid(candidate, false)) {
      return path.resolve(candidate);
    }
  }
  throw new Error(
    "Missing story web assets (index.html). Run tools/prepare_redgalaxy_story_web.sh first."
  );
}

function sendText(res, code, body) {
  const payload = Buffer.from(body, "utf8");
  res.writeHead(code, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": payload.length,
    Connection: "close",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(payload);
}

function safeJoinUnderRoot(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
  } catch {
    return null;
  }
  if (!decoded || decoded === "/") decoded = "/index.html";
  if (!decoded.startsWith("/") || decoded.includes("\0")) return null;
  if (decoded.includes("/../") || decoded.endsWith("/..")) return null;

  const candidate = path.normalize(path.join(root, decoded.slice(1)));
  const rootResolved = path.resolve(root);
  if (candidate !== rootResolved && !candidate.startsWith(rootResolved + path.sep)) {
    return null;
  }
  return candidate;
}

function createStaticServer(webRoot) {
  return http.createServer((req, res) => {
    const method = req.method || "GET";
    const urlPath = (req.url || "/").split("?")[0];

    if (urlPath === "/__bastion__/update-game" && (method === "POST" || method === "GET")) {
      triggerGameUpdate()
        .then(() => {
          /* completion dialog handled inside triggerGameUpdate */
        })
        .catch((err) => {
          console.error("Update failed:", err);
        });
      sendText(res, 200, "update-started\n");
      return;
    }
    if (urlPath === "/__bastion__/update-bastion" && (method === "POST" || method === "GET")) {
      triggerBastionSelfUpdate()
        .then(() => {
          /* dialogs handled inside triggerBastionSelfUpdate */
        })
        .catch((err) => {
          console.error("Bastion update failed:", err);
        });
      sendText(res, 200, "bastion-update-started\n");
      return;
    }
    if (urlPath === "/__bastion__/bastion-version" && method === "GET") {
      const body = JSON.stringify({
        version: bastionAppVersion(),
        manifestConfigured: isBastionManifestConfigured(),
        manifestUrl: BASTION_UPDATE_MANIFEST_URL,
      });
      const payload = Buffer.from(body, "utf8");
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": payload.length,
        Connection: "close",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      });
      res.end(payload);
      return;
    }
    if (urlPath === "/__bastion__/update-status" && method === "GET") {
      const body = JSON.stringify(updateStatus);
      const payload = Buffer.from(body, "utf8");
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": payload.length,
        Connection: "close",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      });
      res.end(payload);
      return;
    }

    if (method !== "GET" && method !== "HEAD") {
      sendText(res, 405, "Method not allowed.\n");
      return;
    }

    const filePath = safeJoinUnderRoot(webRoot, req.url || "/");
    if (!filePath) {
      sendText(res, 400, "Bad path.\n");
      return;
    }

    fs.stat(filePath, (err, st) => {
      if (err || !st.isFile()) {
        sendText(res, 404, "Not found.\n");
        return;
      }

      const headers = {
        "Content-Type": contentTypeFor(filePath),
        "Content-Length": st.size,
        Connection: "close",
        "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": "*",
      };
      res.writeHead(200, headers);
      if (method === "HEAD") {
        res.end();
        return;
      }
      fs.createReadStream(filePath).pipe(res);
    });
  });
}

function listenNearPort(httpServer, preferredPort) {
  return new Promise((resolve, reject) => {
    let port = preferredPort;
    const maxPort = preferredPort + 49;

    const tryListen = () => {
      const onError = (err) => {
        httpServer.removeListener("listening", onListening);
        if (err && err.code === "EADDRINUSE" && port < maxPort) {
          port += 1;
          tryListen();
          return;
        }
        reject(err);
      };
      const onListening = () => {
        httpServer.removeListener("error", onError);
        resolve(port);
      };
      httpServer.once("error", onError);
      httpServer.once("listening", onListening);
      httpServer.listen(port, "127.0.0.1");
    };

    tryListen();
  });
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": UPDATE_USER_AGENT, Accept: "application/json" } },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          httpsGetJson(res.headers.location).then(resolve, reject);
          res.resume();
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          res.resume();
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on("error", reject);
  });
}

function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const partial = destPath + ".part";
    const file = fs.createWriteStream(partial);
    const req = https.get(url, { headers: { "User-Agent": UPDATE_USER_AGENT } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlink(partial, () => {});
        downloadFile(res.headers.location, destPath, onProgress).then(resolve, reject);
        res.resume();
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(partial, () => {});
        reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
        res.resume();
        return;
      }
      const total = Number(res.headers["content-length"]) || 0;
      let received = 0;
      res.on("data", (chunk) => {
        received += chunk.length;
        if (typeof onProgress === "function") {
          const pct = total > 0 ? Math.min(95, Math.round((received / total) * 70) + 5) : 10;
          onProgress(pct, received, total);
        }
      });
      res.pipe(file);
      file.on("finish", () => {
        file.close(() => {
          fs.renameSync(partial, destPath);
          resolve(destPath);
        });
      });
    });
    req.on("error", (err) => {
      file.close();
      fs.unlink(partial, () => {});
      reject(err);
    });
  });
}

function compareVersion(a, b) {
  const left = String(a || "")
    .split(".")
    .map((x) => parseInt(x, 10) || 0);
  const right = String(b || "")
    .split(".")
    .map((x) => parseInt(x, 10) || 0);
  const n = Math.max(left.length, right.length);
  for (let i = 0; i < n; i++) {
    const lv = left[i] || 0;
    const rv = right[i] || 0;
    if (lv < rv) return -1;
    if (lv > rv) return 1;
  }
  return 0;
}

function versionFromReleaseId(raw) {
  return String(raw || "")
    .replace(/^redgalaxy-client@/, "")
    .split("+")[0]
    .split("-")[0]
    .trim();
}

/** Prefer index.html entry chunk — leftover index-*.js from older extracts can lie. */
function readEmbeddedWebVersion(webRoot) {
  try {
    const html = fs.readFileSync(path.join(webRoot, "index.html"), "utf8");
    const m = html.match(/\/assets\/(index-[^"' ]+\.js)/);
    if (!m) return "";
    const text = fs.readFileSync(path.join(webRoot, "assets", m[1]), "utf8");
    const vm = text.match(/redgalaxy-client@([0-9][0-9A-Za-z.+_-]*)/);
    return vm ? versionFromReleaseId(vm[1]) : "";
  } catch {
    return "";
  }
}

function readVersionFile() {
  try {
    return fs.readFileSync(versionFilePath(), "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * Source of truth: live game web embed. version.txt alone can claim a newer
 * server version after a skipped/partial extract.
 */
function readInstalledVersion() {
  for (const root of [userWebRoot(), bundledWebRoot()]) {
    const embedded = readEmbeddedWebVersion(root);
    if (embedded) return embedded;
  }
  return readVersionFile();
}

function gameWebIsComplete(webRoot) {
  try {
    if (!fs.existsSync(path.join(webRoot, "index.html"))) return false;
    if (!fs.existsSync(path.join(webRoot, "assets"))) return false;
    if (!fs.existsSync(path.join(webRoot, "maps"))) return false;
    if (!fs.existsSync(path.join(webRoot, "ships"))) return false;
    const html = fs.readFileSync(path.join(webRoot, "index.html"), "utf8");
    const m = html.match(/\/assets\/(index-[^"' ]+\.js)/);
    if (!m) return false;
    const asset = path.join(webRoot, "assets", m[1]);
    if (!fs.existsSync(asset) || fs.statSync(asset).size < 1) return false;
    // Locales + woff2 required — without them WK/Chromium boot can hang on fonts.load (black screen).
    const langTr = path.join(webRoot, "lang", "tr.json");
    const langEn = path.join(webRoot, "lang", "en.json");
    if (!fs.existsSync(langTr) && !fs.existsSync(langEn)) return false;
    let hasWoff2 = false;
    try {
      hasWoff2 = fs.readdirSync(path.join(webRoot, "assets")).some((n) => n.endsWith(".woff2"));
    } catch {
      return false;
    }
    if (!hasWoff2) return false;
    // Fused extract path leftovers = corrupt game assets.
    const walk = (dir, depth = 0) => {
      if (depth > 6) return false;
      let names;
      try {
        names = fs.readdirSync(dir);
      } catch {
        return false;
      }
      for (const name of names) {
        if (/atlasships|jsonships|webpships/i.test(name)) return true;
        const full = path.join(dir, name);
        try {
          if (fs.statSync(full).isDirectory() && walk(full, depth + 1)) return true;
        } catch {
          /* ignore */
        }
      }
      return false;
    };
    if (walk(webRoot)) return false;
    return true;
  } catch {
    return false;
  }
}

function gameClientMatchesRemote(remote) {
  const web = userWebRoot();
  if (!gameWebIsComplete(web)) return false;
  const embedded = readEmbeddedWebVersion(web);
  if (!embedded) return false;
  if (embedded === remote) return true;
  return compareVersion(embedded, remote) >= 0;
}

function writeInstalledVersion(version) {
  if (!version) return;
  fs.mkdirSync(path.dirname(versionFilePath()), { recursive: true });
  fs.writeFileSync(versionFilePath(), `${version}\n`, "utf8");
}

function killProcessTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      return;
    }
    child.kill("SIGKILL");
  } catch {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }
}

function runCommand(command, args, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) || 0;
  const onOutput = typeof opts.onOutput === "function" ? opts.onOutput : null;
  const spawnOpts = { ...opts };
  delete spawnOpts.timeoutMs;
  delete spawnOpts.onOutput;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...spawnOpts,
    });
    let out = "";
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            killProcessTree(child);
            finish(() => reject(new Error(`${command} timeout after ${timeoutMs}ms\n${out}`)));
          }, timeoutMs)
        : null;
    child.stdout.on("data", (d) => {
      const text = d.toString();
      out += text;
      if (onOutput) onOutput(text);
    });
    child.stderr.on("data", (d) => {
      const text = d.toString();
      out += text;
      if (onOutput) onOutput(text);
    });
    child.on("error", (err) => finish(() => reject(err)));
    child.on("close", (code) => {
      if (code === 0) finish(() => resolve(out));
      else finish(() => reject(new Error(`${command} exited ${code}\n${out}`)));
    });
  });
}

function looksLikeWindowsStorePythonStub(exePath, probeOutput) {
  const text = String(probeOutput || "");
  if (/Microsoft Store|WindowsApps|python3\.exe.*not found|No pyvenv|was not found/i.test(text)) {
    return true;
  }
  const normalized = String(exePath || "").replace(/\//g, "\\").toLowerCase();
  if (normalized.includes("\\windowsapps\\") || normalized.includes("\\microsoft\\windowsapps\\")) {
    return true;
  }
  return false;
}

function collectWindowsPythonCandidates() {
  const found = [];
  const seen = new Set();
  const push = (cmd, prefix = [], label = cmd) => {
    const key = `${cmd}||${prefix.join(" ")}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ cmd, prefix, label });
  };

  // Prefer the py launcher with an explicit -3 (avoids Store stub).
  push("py", ["-3"], "py -3");
  push("py", ["-3.12"], "py -3.12");
  push("py", ["-3.11"], "py -3.11");
  push("py", ["-3.10"], "py -3.10");

  const local = process.env.LOCALAPPDATA || "";
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const userProfile = process.env.USERPROFILE || "";

  const globRoots = [
    path.join(local, "Programs", "Python"),
    path.join(programFiles, "Python*"),
    path.join(programFilesX86, "Python*"),
    path.join(userProfile, "AppData", "Local", "Programs", "Python"),
  ];

  const addExeIfReal = (exe) => {
    if (!exe || !fs.existsSync(exe)) return;
    if (looksLikeWindowsStorePythonStub(exe, "")) return;
    push(exe, [], exe);
  };

  // Explicit common install layouts.
  for (const major of ["312", "311", "310", "39", "38"]) {
    addExeIfReal(path.join(local, "Programs", "Python", `Python${major}`, "python.exe"));
    addExeIfReal(path.join(programFiles, `Python${major}`, "python.exe"));
    addExeIfReal(path.join(programFilesX86, `Python${major}`, "python.exe"));
  }

  try {
    const base = path.join(local, "Programs", "Python");
    if (fs.existsSync(base)) {
      for (const name of fs.readdirSync(base)) {
        if (!/^Python3/i.test(name)) continue;
        addExeIfReal(path.join(base, name, "python.exe"));
      }
    }
  } catch {
    /* ignore */
  }

  // where.exe discovery — filter Store stubs later via probe.
  try {
    const whereOut = spawnSync("where", ["python"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 8000,
    });
    if (whereOut.status === 0 && whereOut.stdout) {
      for (const line of whereOut.stdout.split(/\r?\n/)) {
        const p = line.trim();
        if (p && p.toLowerCase().endsWith("python.exe")) addExeIfReal(p);
      }
    }
  } catch {
    /* ignore */
  }

  // Bare names last (often Store aliases — rejected by probe).
  push("python", [], "python");
  // Intentionally omit bare `python3` on Windows — it's the Store stub (exit 9009).

  void globRoots;
  return found;
}

async function probePythonCandidate(candidate) {
  try {
    const out = await runCommand(candidate.cmd, [...candidate.prefix, "-c", "import sys; print(sys.version)"], {
      timeoutMs: 15000,
    });
    if (looksLikeWindowsStorePythonStub(candidate.cmd, out)) {
      throw new Error("Windows Store Python stub");
    }
    if (!/\d+\.\d+/.test(out)) throw new Error("No version output");
    return out.trim();
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (/exited 9009|ENOENT|Microsoft Store|Windows Store/i.test(msg)) {
      throw new Error(`Rejected Python candidate ${candidate.label}: ${msg}`);
    }
    throw err;
  }
}

async function resolveRealPython() {
  const candidates =
    process.platform === "win32"
      ? collectWindowsPythonCandidates()
      : [
          { cmd: "python3", prefix: [], label: "python3" },
          { cmd: "python", prefix: [], label: "python" },
        ];

  const errors = [];
  for (const candidate of candidates) {
    try {
      await probePythonCandidate(candidate);
      return candidate;
    } catch (err) {
      errors.push(String(err && err.message ? err.message : err));
    }
  }
  const hint =
    process.platform === "win32"
      ? "Installa Python da python.org (non lo stub Microsoft Store), oppure usa l'aggiornamento Node incluso. / Install Python from python.org (not the Microsoft Store stub)."
      : "Install Python 3 and ensure python3 is on PATH.";
  throw new Error(`Python 3 non trovato.\n${hint}\n${errors.slice(0, 5).join("\n")}`);
}

function nodeToolPath(basename) {
  const packaged = path.join(toolsDir(), basename);
  if (fs.existsSync(packaged)) return packaged;
  const dev = path.join(__dirname, "..", basename);
  if (fs.existsSync(dev)) return dev;
  return packaged;
}

async function runNodeTool(scriptPath, scriptArgs, extraOpts = {}) {
  // process.execPath is Electron.exe — without ELECTRON_RUN_AS_NODE it launches
  // another GUI instance and the updater hangs on the progress bar forever.
  const env = {
    ...process.env,
    ...(extraOpts.env || {}),
    ELECTRON_RUN_AS_NODE: "1",
  };
  return runCommand(process.execPath, [scriptPath, ...scriptArgs], {
    timeoutMs: 300000,
    ...extraOpts,
    env,
  });
}

function startUpdateHeartbeat(phase, basePercent, message) {
  let tick = 0;
  const timer = setInterval(() => {
    tick += 1;
    const wobble = Math.min(9, tick);
    setUpdateStatus({
      phase,
      percent: Math.min(basePercent + wobble, basePercent + 9),
      message: `${message} (${tick}s)`,
    });
  }, 1000);
  return () => clearInterval(timer);
}

async function runExtractAndPatch({ clientExe, rawOut, finalOut, storySrc }) {
  const extractorJs = nodeToolPath("extract_redgalaxy_web.js");
  const patcherJs = nodeToolPath("apply_bastion_patches.js");
  const extractorPy = nodeToolPath("extract_redgalaxy_web.py");
  const patcherPy = nodeToolPath("apply_bastion_patches.py");

  // Never patch/rm the live user web root here — Windows locks open assets while
  // the HTTP server / Chromium serve them. Callers must pass a staging dir, then
  // publishUserWebRoot() after closing the server.
  const hasNodePipeline = fs.existsSync(extractorJs) && fs.existsSync(patcherJs);
  if (hasNodePipeline) {
    setUpdateStatus({ phase: "extract", percent: 82, message: "Estrazione asset web (Node)…" });
    const stopExtractBeat = startUpdateHeartbeat("extract", 82, "Estrazione asset web (Node)…");
    try {
      await runNodeTool(extractorJs, [clientExe, rawOut]);
    } finally {
      stopExtractBeat();
    }
    if (!gameWebIsComplete(rawOut)) {
      throw new Error(
        "Estrazione incompleta (mancano index/lang/woff2 o asset fusi). Riprova Aggiorna gioco; se persiste, reinstalla il client ufficiale RedGalaxy."
      );
    }
    fs.rmSync(finalOut, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(finalOut), { recursive: true });
    setUpdateStatus({ phase: "patch", percent: 92, message: "Applico patch Bastion (Node)…" });
    const stopPatchBeat = startUpdateHeartbeat("patch", 92, "Applico patch Bastion (Node)…");
    try {
      await runNodeTool(patcherJs, [
        "--game-src",
        rawOut,
        "--story-src",
        storySrc,
        "--out",
        finalOut,
      ]);
    } finally {
      stopPatchBeat();
    }
    return { engine: "node" };
  }

  if (!fs.existsSync(extractorPy) || !fs.existsSync(patcherPy)) {
    throw new Error(
      "Script di aggiornamento mancanti nel pacchetto (extract/patch). Ricostruisci il pacchetto Windows Bastion."
    );
  }

  const py = await resolveRealPython();
  const runPy = async (scriptArgs) =>
    runCommand(py.cmd, [...py.prefix, ...scriptArgs], { timeoutMs: 300000 });

  setUpdateStatus({
    phase: "extract",
    percent: 82,
    message: `Estrazione asset web (${py.label})…`,
  });
  const stopExtractBeat = startUpdateHeartbeat(
    "extract",
    82,
    `Estrazione asset web (${py.label})…`
  );
  try {
    await runPy([extractorPy, clientExe, rawOut]);
  } finally {
    stopExtractBeat();
  }
  if (!gameWebIsComplete(rawOut)) {
    throw new Error(
      "Estrazione incompleta (mancano index/lang/woff2 o asset fusi). Riprova Aggiorna gioco; se persiste, reinstalla il client ufficiale RedGalaxy."
    );
  }
  fs.rmSync(finalOut, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(finalOut), { recursive: true });
  setUpdateStatus({ phase: "patch", percent: 92, message: "Applico patch Bastion…" });
  const stopPatchBeat = startUpdateHeartbeat("patch", 92, "Applico patch Bastion…");
  try {
    await runPy([
      patcherPy,
      "--game-src",
      rawOut,
      "--story-src",
      storySrc,
      "--out",
      finalOut,
    ]);
  } finally {
    stopPatchBeat();
  }
  return { engine: "python", python: py.label };
}

function closeStaticServer() {
  if (!server) return Promise.resolve();
  const s = server;
  server = null;
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    try {
      s.close(() => finish());
    } catch {
      finish();
      return;
    }
    // Windows can keep sockets briefly; don't hang the updater.
    setTimeout(finish, 1500);
  });
}

/**
 * Atomically publish a validated staging web tree over the live user cache.
 * Mirrors Mac publish_web_root: never wipe live until staging is ready, and
 * release file locks by closing the local HTTP server first (Windows EBUSY).
 */
async function publishUserWebRoot(stagingOut, liveOut) {
  if (!gameWebIsComplete(stagingOut)) {
    throw new Error(
      "Aggiornamento preparato ma incompleto (lang/woff2/index). Non applico la cache live."
    );
  }
  if (!bastionWebRootIsIntact(stagingOut)) {
    throw new Error(
      "Patch Bastion incompleta (story/autopilot o hook mancanti). Riprova Aggiorna gioco."
    );
  }
  const embedded = readEmbeddedWebVersion(stagingOut);
  if (!embedded) {
    throw new Error(
      "Aggiornamento senza versione redgalaxy-client@ nell'embed. Estrazione o patch non valida."
    );
  }

  await closeStaticServer();
  // Brief settle so Windows releases ReadStream handles from the old root.
  await new Promise((r) => setTimeout(r, 250));

  const previous = path.join(supportDir(), `web-previous-${process.pid}-${Date.now()}`);
  fs.rmSync(previous, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(liveOut), { recursive: true });

  const liveExists = fs.existsSync(liveOut);
  try {
    if (liveExists) {
      fs.renameSync(liveOut, previous);
    }
  } catch (err) {
    // Fallback when rename fails (rare locks): copy-over after close.
    console.warn("rename live→previous failed, trying rm:", err.message || err);
    try {
      fs.rmSync(liveOut, { recursive: true, force: true });
    } catch (rmErr) {
      throw new Error(
        `Impossibile sostituire la cache di gioco (file in uso o permessi AppData): ${rmErr.message || rmErr}`
      );
    }
  }

  try {
    fs.renameSync(stagingOut, liveOut);
  } catch (err) {
    // Restore previous live tree if swap failed.
    if (fs.existsSync(previous) && !fs.existsSync(liveOut)) {
      try {
        fs.renameSync(previous, liveOut);
      } catch {
        /* ignore */
      }
    }
    throw new Error(
      `Impossibile pubblicare gli asset aggiornati (permessi o file bloccati): ${err.message || err}`
    );
  }

  fs.rmSync(previous, { recursive: true, force: true });
  return embedded;
}

function humanizeUpdateError(err) {
  const raw = String(err && err.message ? err.message : err || "");
  const lower = raw.toLowerCase();
  if (/timeout after/i.test(raw) && /extract|patch|node|electron/i.test(lower)) {
    return "Tempo scaduto durante estrazione/patch. Riprova con la rete stabile; se persiste, chiudi Bastion e riprova.";
  }
  if (/ebusy|eperm|eacces|resource busy|being used by another process/i.test(lower)) {
    return `File di gioco in uso o permessi AppData insufficienti. Chiudi altre copie di Bastion e riprova.\n${raw}`;
  }
  if (/redgalaxy-client\.exe non trovato/i.test(raw)) {
    return raw;
  }
  if (/updater scripts missing|script di aggiornamento mancanti/i.test(lower)) {
    return "Pacchetto Bastion incompleto (mancano extract/patch). Scarica di nuovo RedGalaxy-Bastion.exe.";
  }
  if (/enonet|enoent/i.test(lower) && /brotli|extract/i.test(lower)) {
    return `Estrazione fallita (brotli/asset): ${raw}`;
  }
  if (/python/i.test(lower) && /store|stub|not found/i.test(lower)) {
    return "Python non disponibile. Usa il pacchetto Bastion aggiornato (estrazione Node inclusa) oppure installa Python da python.org.";
  }
  return raw || "Aggiornamento non riuscito per un errore sconosciuto.";
}

function findInstalledClientExe() {
  const local = process.env.LOCALAPPDATA || "";
  const candidates = [
    path.join(local, "RedGalaxy", "redgalaxy-client.exe"),
    path.join(local, "RedGalaxy", "RedGalaxy.exe"),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

async function applyWindowsGameUpdate({ force = false } = {}) {
  if (updateRunning) {
    throw new Error("Update already running");
  }
  updateRunning = true;
  setUpdateStatus({
    running: true,
    kind: "game",
    phase: "manifest",
    percent: 2,
    message: "Controllo versione ufficiale…",
    error: "",
    remote: "",
  });
  try {
    const manifest = await httpsGetJson(UPDATE_MANIFEST_URL);
    const remote = String(manifest.version || "").trim();
    if (!remote) throw new Error("Manifest missing version");
    setUpdateStatus({ remote, percent: 5, message: `Versione ufficiale: ${remote}` });
    const installed = readInstalledVersion();
    const recorded = readVersionFile();
    const liveOk = gameClientMatchesRemote(remote);
    const versionFileLie = recorded && installed && recorded !== installed;

    if (!force && installed && compareVersion(installed, remote) >= 0 && liveOk && !versionFileLie) {
      writeInstalledVersion(installed);
      const storySynced = syncBundledStoryOverlayIntoUserWeb();
      const heal = await ensureBastionOverlayInUserWeb();
      setUpdateStatus({
        running: false,
        phase: "done",
        percent: 100,
        message: heal.repaired
          ? `Già aggiornato (${installed}) — overlay Bastion ripristinato`
          : `Già aggiornato (${installed})`,
      });
      return {
        updated: false,
        installed,
        remote,
        storySynced: !!storySynced,
        bastionRepaired: !!heal.repaired,
        webRoot: heal.repaired ? userWebRoot() : undefined,
      };
    }

    if (versionFileLie) {
      console.warn(
        `version.txt (${recorded}) disagrees with live game web (${installed}) — refreshing game assets.`
      );
    }
    if (!liveOk) {
      console.warn(
        `Game web incomplete or behind official ${remote} (live=${installed || "missing"}) — refreshing.`
      );
    }

    const win = (manifest.platforms && (manifest.platforms["windows-x86_64"] || manifest.platforms.windows)) || {};
    const installerUrl = String(win.url || "https://updates.redgalaxygame.space/RedGalaxy-Setup.exe").trim();

    let clientExe = findInstalledClientExe();
    const behindOfficial =
      !installed || compareVersion(installed, remote) < 0 || !liveOk;

    // Prefer extracting from an already-installed official client.
    // force:true used to always re-download + silent-install → progress bar hung for minutes
    // even when the client was already present. Download only when missing or behind.
    const needFreshInstall = !clientExe || behindOfficial;

    if (needFreshInstall) {
      setUpdateStatus({
        phase: "download",
        percent: 8,
        message: "Download installer ufficiale…",
      });
      const downloads = path.join(app.getPath("userData"), "downloads");
      fs.mkdirSync(downloads, { recursive: true });
      const installerPath = path.join(downloads, path.basename(installerUrl) || "RedGalaxy-Setup.exe");
      await downloadFile(installerUrl, installerPath, (pct) => {
        setUpdateStatus({ phase: "download", percent: pct, message: `Download… ${pct}%` });
      });

      setUpdateStatus({
        phase: "install",
        percent: 75,
        message: "Installazione silenziosa (max 2 min)…",
      });
      const stopInstallBeat = startUpdateHeartbeat(
        "install",
        75,
        "Installazione silenziosa…"
      );
      try {
        await runCommand(installerPath, ["/S"], { shell: false, timeoutMs: 120000 });
      } catch (err) {
        console.warn("Installer failed/timeout (may still have installed):", err.message || err);
      } finally {
        stopInstallBeat();
      }
      clientExe = findInstalledClientExe() || clientExe;
    } else {
      setUpdateStatus({
        phase: "extract",
        percent: 78,
        message: "Client ufficiale trovato — estraggo senza reinstallare…",
      });
    }

    if (!clientExe) {
      throw new Error(
        "redgalaxy-client.exe non trovato. Installa una volta il client ufficiale RedGalaxy, poi riprova Aggiorna gioco."
      );
    }

    const extractorJs = nodeToolPath("extract_redgalaxy_web.js");
    const patcherJs = nodeToolPath("apply_bastion_patches.js");
    const extractorPy = nodeToolPath("extract_redgalaxy_web.py");
    const patcherPy = nodeToolPath("apply_bastion_patches.py");
    if (
      !(fs.existsSync(extractorJs) && fs.existsSync(patcherJs)) &&
      !(fs.existsSync(extractorPy) && fs.existsSync(patcherPy))
    ) {
      throw new Error("Updater scripts missing from app resources (extract/patch). Rebuild the Windows package.");
    }

    const rawOut = path.join(supportDir(), "extract-raw");
    const stagingOut = path.join(supportDir(), "staging-web");
    const finalOut = userWebRoot();
    fs.rmSync(rawOut, { recursive: true, force: true });
    fs.rmSync(stagingOut, { recursive: true, force: true });
    fs.mkdirSync(rawOut, { recursive: true });

    setUpdateStatus({
      phase: "extract",
      percent: 80,
      message: "Preparazione asset (staging, senza toccare la cache live)…",
    });
    await runExtractAndPatch({
      clientExe,
      rawOut,
      finalOut: stagingOut,
      storySrc: storySrcRoot(),
    });

    setUpdateStatus({
      phase: "publish",
      percent: 96,
      message: "Pubblicazione cache di gioco…",
    });
    const embeddedAfter = await publishUserWebRoot(stagingOut, finalOut);
    writeInstalledVersion(embeddedAfter);
    fs.rmSync(rawOut, { recursive: true, force: true });
    fs.rmSync(stagingOut, { recursive: true, force: true });

    setUpdateStatus({
      running: false,
      phase: "done",
      percent: 100,
      message: `Aggiornato al client di gioco ${embeddedAfter}`,
    });
    return { updated: true, installed, remote, webRoot: finalOut, embedded: embeddedAfter };
  } catch (err) {
    const message = humanizeUpdateError(err);
    setUpdateStatus({ running: false, phase: "error", percent: 100, message, error: message });
    throw new Error(message);
  } finally {
    updateRunning = false;
  }
}

async function reloadWithWebRoot(webRoot) {
  activeWebRoot = webRoot;
  await closeStaticServer();
  server = createStaticServer(webRoot);
  const port = await listenNearPort(server, PREFERRED_PORT);
  const startUrl = `http://127.0.0.1:${port}/`;
  if (mainWindow && !mainWindow.isDestroyed()) {
    await mainWindow.loadURL(startUrl);
  }
  return startUrl;
}

async function triggerGameUpdate() {
  try {
    const result = await applyWindowsGameUpdate({ force: true });
    if (result.updated && result.webRoot) {
      await reloadWithWebRoot(result.webRoot);
      if (mainWindow && !mainWindow.isDestroyed()) {
        dialog.showMessageBox(mainWindow, {
          type: "info",
          title: "Aggiornamento completato",
          message: `Gioco aggiornato a ${result.remote}`,
          detail: "Autopilot/licenza Bastion sono stati riapplicati.",
        });
      }
    } else if (mainWindow && !mainWindow.isDestroyed()) {
      // force:true normally always re-extracts; if we somehow got updated:false,
      // still heal Bastion and reload when repaired.
      const storySynced = syncBundledStoryOverlayIntoUserWeb();
      const heal = await ensureBastionOverlayInUserWeb();
      if (heal.repaired || storySynced) {
        await reloadWithWebRoot(userWebRoot());
        dialog.showMessageBox(mainWindow, {
          type: "info",
          title: "Gioco già aggiornato",
          message: `Versione attuale: ${result.installed || "?"}\nUltima ufficiale: ${result.remote}`,
          detail: "Overlay Bastion (autopilot/UI) ripristinato dal bundle.",
        });
      } else {
        dialog.showMessageBox(mainWindow, {
          type: "info",
          title: "Gioco già aggiornato",
          message: `Versione attuale: ${result.installed || "?"}\nUltima ufficiale: ${result.remote}`,
        });
      }
    }
    return result;
  } catch (err) {
    const detail = humanizeUpdateError(err);
    // publishUserWebRoot closes the HTTP server before swapping — restore serving on failure.
    if (!server) {
      try {
        await reloadWithWebRoot(resolveWebRoot());
      } catch (reloadErr) {
        console.error("Failed to restore web server after update error:", reloadErr);
      }
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, {
        type: "error",
        title: "Aggiornamento fallito",
        message: "L'aggiornamento del gioco non è riuscito.",
        detail,
      });
    }
    throw new Error(detail);
  }
}

/**
 * Self-update Bastion host (portable exe preferred). Separate from game asset update.
 * Manifest: { version, dmg, exe, notes?, releaseUrl? }
 */
async function applyBastionSelfUpdate() {
  if (bastionUpdateRunning || updateRunning) {
    throw new Error("Update already running");
  }
  bastionUpdateRunning = true;
  const localVersion = bastionAppVersion();
  setUpdateStatus({
    running: true,
    kind: "bastion",
    phase: "manifest",
    percent: 2,
    message: "Controllo versione Bastion…",
    error: "",
    remote: "",
  });

  try {
    if (!isBastionManifestConfigured()) {
      const msg = "Aggiornamento non disponibile";
      setUpdateStatus({
        running: false,
        kind: "bastion",
        phase: "error",
        percent: 100,
        message: msg,
        error: "configure_url",
      });
      return { updated: false, configured: false, localVersion, message: msg };
    }

    const manifest = await httpsGetJson(BASTION_UPDATE_MANIFEST_URL);
    const remote = String(manifest.version || "").trim();
    if (!remote) throw new Error("Bastion manifest missing version");
    setUpdateStatus({
      kind: "bastion",
      remote,
      percent: 8,
      message: `Bastion remoto: ${remote} (locale ${localVersion})`,
    });

    if (compareVersion(localVersion, remote) >= 0) {
      const msg = `Bastion già aggiornato (${localVersion})`;
      setUpdateStatus({
        running: false,
        kind: "bastion",
        phase: "done",
        percent: 100,
        message: msg,
      });
      return { updated: false, configured: true, localVersion, remote, message: msg };
    }

    const exeUrl = String(manifest.exe || manifest.windows || "").trim();
    const releaseUrl = String(manifest.releaseUrl || manifest.html_url || "").trim();
    const notes = playerSafeBastionNotes(manifest.notes);

    if (!exeUrl) {
      if (releaseUrl) {
        await shell.openExternal(releaseUrl);
        const msg = `Apro la pagina di download ${remote}. Installa la nuova versione e riavvia Bastion.`;
        setUpdateStatus({
          running: false,
          kind: "bastion",
          phase: "done",
          percent: 100,
          message: msg,
        });
        return {
          updated: false,
          configured: true,
          localVersion,
          remote,
          openedRelease: true,
          message: msg,
          notes,
        };
      }
      throw new Error("Bastion manifest missing exe URL");
    }

    setUpdateStatus({
      kind: "bastion",
      phase: "download",
      percent: 12,
      message: `Download Bastion ${remote}…`,
    });
    const downloads = path.join(app.getPath("userData"), "bastion-updates");
    fs.mkdirSync(downloads, { recursive: true });
    const fileName = path.basename(new URL(exeUrl).pathname) || `RedGalaxy-Bastion-${remote}.exe`;
    const destPath = path.join(downloads, fileName);
    await downloadFile(exeUrl, destPath, (pct) => {
      setUpdateStatus({
        kind: "bastion",
        phase: "download",
        percent: pct,
        message: `Download Bastion… ${pct}%`,
      });
    });

    const replaceTarget = bastionReplaceableExePath();
    if (replaceTarget) {
      setUpdateStatus({
        kind: "bastion",
        phase: "install",
        percent: 96,
        message: `Installazione Bastion ${remote}…`,
      });
      const staged = `${replaceTarget}.bastion-new.exe`;
      fs.copyFileSync(destPath, staged);
      scheduleWindowsExeSwapAndRelaunch(replaceTarget, staged);
      const msg =
        `Aggiornamento a Bastion ${remote} pronto. Chiudo e riavvio automaticamente.` +
        (notes ? `\n\n${notes}` : "");
      setUpdateStatus({
        running: false,
        kind: "bastion",
        phase: "done",
        percent: 100,
        message: `Installato ${remote} — riavvio…`,
        path: replaceTarget,
      });
      return {
        updated: true,
        configured: true,
        localVersion,
        remote,
        path: replaceTarget,
        relaunching: true,
        message: msg,
        notes,
      };
    }

    try {
      await shell.openPath(destPath);
    } catch (err) {
      console.warn("openPath failed:", err.message || err);
    }
    try {
      await shell.showItemInFolder(destPath);
    } catch {
      /* ignore */
    }

    const msg =
      `Scaricato Bastion ${remote}. Chiudi questa app e avvia il nuovo file, poi riparti.` +
      (notes ? `\n\n${notes}` : "");
    setUpdateStatus({
      running: false,
      kind: "bastion",
      phase: "done",
      percent: 100,
      message: `Scaricato ${remote} — avvia il nuovo exe`,
      path: destPath,
    });
    return {
      updated: true,
      configured: true,
      localVersion,
      remote,
      path: destPath,
      message: msg,
      notes,
    };
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    setUpdateStatus({
      running: false,
      kind: "bastion",
      phase: "error",
      percent: 100,
      message,
      error: message,
    });
    throw err;
  } finally {
    bastionUpdateRunning = false;
  }
}

async function triggerBastionSelfUpdate() {
  try {
    const result = await applyBastionSelfUpdate();
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (!result.configured) {
        dialog.showMessageBox(mainWindow, {
          type: "warning",
          title: "Aggiornamento Bastion",
          message: "Aggiornamento non disponibile",
          detail: "Impossibile verificare aggiornamenti Bastion in questo momento. Riprova più tardi o reinstalla.",
        });
      } else if (result.relaunching) {
        dialog.showMessageBox(mainWindow, {
          type: "info",
          title: "Aggiornamento Bastion",
          message: `Bastion ${result.remote} installato`,
          detail: result.message || "Riavvio in corso…",
        });
      } else if (result.updated) {
        dialog.showMessageBox(mainWindow, {
          type: "info",
          title: "Aggiornamento Bastion",
          message: `Nuova versione ${result.remote} pronta`,
          detail:
            `${result.message}\n\nFile:\n${result.path}\n\n` +
            "Chiudi Bastion e avvia il nuovo exe.",
        });
      } else if (result.openedRelease) {
        dialog.showMessageBox(mainWindow, {
          type: "info",
          title: "Aggiornamento Bastion",
          message: `Nuova versione ${result.remote} disponibile`,
          detail: "Scarica l'exe dalla pagina aperta, chiudi Bastion e avvia la nuova copia.",
        });
      } else {
        dialog.showMessageBox(mainWindow, {
          type: "info",
          title: "Già aggiornato",
          message: result.message || `Versione attuale: ${result.localVersion}`,
        });
      }
    }
    return result;
  } catch (err) {
    const detail = String(err && err.message ? err.message : err);
    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, {
        type: "error",
        title: "Aggiornamento Bastion fallito",
        message: "Impossibile aggiornare Bastion.",
        detail,
      });
    }
    throw err;
  }
}

async function checkUpdatesOnLaunch() {
  try {
    const manifest = await httpsGetJson(UPDATE_MANIFEST_URL);
    const remote = String(manifest.version || "").trim();
    const installed = readInstalledVersion();
    if (!remote || (installed && compareVersion(installed, remote) >= 0)) {
      return;
    }
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: "info",
      buttons: ["Aggiorna ora", "Più tardi"],
      defaultId: 0,
      cancelId: 1,
      title: "Aggiornamento gioco",
      message: "Aggiornamento gioco disponibile",
      detail:
        `Installata: ${installed || "sconosciuta"}\nUfficiale: ${remote}\n\n` +
        "Verranno aggiornati solo gli asset ufficiali. Autopilot/licenza Bastion restano intatti.\n" +
        "Su Windows serve Python 3 installato (comando py/python) per estrarre gli asset.",
    });
    if (response === 0) {
      await triggerGameUpdate();
    }
  } catch (err) {
    console.warn("Launch update check failed:", err.message || err);
  }
}

async function createWindow(startUrl) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 960,
    minHeight: 540,
    title: WINDOW_TITLE,
    backgroundColor: "#0b1020",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.on("page-title-updated", (event) => {
    event.preventDefault();
    mainWindow.setTitle(WINDOW_TITLE);
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  await mainWindow.loadURL(startUrl);
}

async function start() {
  syncBundledStoryOverlayIntoUserWeb();
  const heal = await ensureBastionOverlayInUserWeb();
  if (heal.repaired) {
    console.log("Launch heal restored Bastion overlay at", heal.webRoot);
  }
  activeWebRoot = resolveWebRoot();
  server = createStaticServer(activeWebRoot);
  const port = await listenNearPort(server, PREFERRED_PORT);
  const startUrl = `http://127.0.0.1:${port}/`;

  console.log(`RedGalaxy Bastion is serving ${activeWebRoot}`);
  console.log(`Open ${startUrl}`);

  powerSaveId = powerSaveBlocker.start("prevent-app-suspension");

  await createWindow(startUrl);
  setTimeout(() => {
    checkUpdatesOnLaunch().catch((err) => console.warn(err));
  }, 2500);
}

function shutdown() {
  if (powerSaveId != null && powerSaveBlocker.isStarted(powerSaveId)) {
    powerSaveBlocker.stop(powerSaveId);
    powerSaveId = null;
  }
  if (server) {
    try {
      server.close();
    } catch {
      /* ignore */
    }
    server = null;
  }
}

ipcMain.handle("bastion-update-game", async () => triggerGameUpdate());
ipcMain.handle("bastion-update-bastion", async () => triggerBastionSelfUpdate());

app.whenReady().then(start).catch((err) => {
  console.error(err);
  app.quit();
});

app.on("window-all-closed", () => {
  shutdown();
  app.quit();
});

app.on("before-quit", shutdown);

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && server) {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : PREFERRED_PORT;
    createWindow(`http://127.0.0.1:${port}/`).catch(console.error);
  }
});

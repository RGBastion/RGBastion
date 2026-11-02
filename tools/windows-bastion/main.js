"use strict";

const { app, BrowserWindow, powerSaveBlocker, dialog, ipcMain, shell } = require("electron");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { Worker } = require("worker_threads");
const PREFERRED_PORT = 8765;
const PKG = (() => {
  try {
    return require("./package.json");
  } catch {
    return {};
  }
})();
const WINDOW_TITLE =
  (PKG.build && PKG.build.productName) || PKG.productName || "Bastion";
/**
 * Brand is baked into package.json at build time (productName / name).
 * Matches Mac host: RG → updates.redgalaxygame.space, RU → R2.
 */
const PRODUCT_BRAND = (() => {
  const blob = `${(PKG.build && PKG.build.productName) || ""} ${PKG.productName || ""} ${PKG.name || ""} ${PKG.build && PKG.build.appId || ""}`.toLowerCase();
  if (blob.includes("reduniverse")) return "reduniverse";
  return "redgalaxy";
})();
const BRAND_GAME_UPDATE =
  PRODUCT_BRAND === "reduniverse"
    ? {
        manifestUrl:
          "https://pub-792ad9615ccc4d05840f6f77a6fb33b9.r2.dev/updates/latest.json",
        fallbackInstallerUrl:
          "https://pub-792ad9615ccc4d05840f6f77a6fb33b9.r2.dev/RedUniverse_1.0.12_x64-setup.exe",
        clientLabel: "RedUniverse",
        clientExeHint: "reduniverse-pc-client.exe",
      }
    : {
        // Official launcher 1.1.7+ reads the PC envelope (Gioco 0.9.x).
        // Legacy Tauri channel updates.redgalaxygame.space/latest.json stayed on 0.8.4.
        manifestUrl: "https://updates.redgalaxygame.space/pc/latest.json",
        fallbackInstallerUrl:
          "https://updates.redgalaxygame.space/RedGalaxy-Setup.exe",
        // Bridge channel still ships a full Tauri setup useful as an art donor.
        artDonorManifestUrl:
          "https://updates.redgalaxygame.space/nc-bridge/latest.json",
        clientLabel: "RedGalaxy",
        clientExeHint: "redgalaxy-game.exe",
      };
const UPDATE_MANIFEST_URL = (
  process.env.BASTION_GAME_UPDATE_MANIFEST_URL ||
  process.env.UPDATE_MANIFEST_URL ||
  BRAND_GAME_UPDATE.manifestUrl
).trim();
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
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${String(WINDOW_TITLE).replace(/\s+/g, "-")}-Updater/1.0`;

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
  return "1.0.10";
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
  const vbsPath = `${batPath}.vbs`;
  // Do NOT use `timeout` here: timeout.exe allocates a visible console even when
  // the parent cmd is spawned with windowsHide, so users see a terminal that
  // "reopens" every wait tick until they Ctrl+C. `ping` delays without that.
  // Swap + start "%TARGET%" sequence is unchanged so Bastion update still works.
  const bat = [
    "@echo off",
    "setlocal",
    `set "TARGET=${currentExe}"`,
    `set "SOURCE=${newExe}"`,
    `set "PID=${process.pid}"`,
    ":wait",
    'tasklist /FI "PID eq %PID%" 2>NUL | find "%PID%" >NUL',
    "if not errorlevel 1 (",
    "  ping -n 2 127.0.0.1 >NUL",
    "  goto wait",
    ")",
    "ping -n 2 127.0.0.1 >NUL",
    'copy /Y "%SOURCE%" "%TARGET%" >NUL',
    "if errorlevel 1 (",
    '  move /Y "%SOURCE%" "%TARGET%" >NUL',
    ")",
    'start "" "%TARGET%"',
    'del /F /Q "%SOURCE%" >NUL 2>&1',
    `del /F /Q "${batPath}" >NUL 2>&1`,
    `del /F /Q "${vbsPath}" >NUL 2>&1`,
    "endlocal",
    "exit /b 0",
    "",
  ].join("\r\n");
  fs.writeFileSync(batPath, bat, "utf8");
  // Start the bat via wscript Run(...,0) so no console window appears for end users.
  const safeBat = String(batPath).replace(/"/g, "");
  fs.writeFileSync(
    vbsPath,
    `CreateObject("WScript.Shell").Run "cmd.exe /d /c ""${safeBat}""", 0, False\r\n`,
    "utf8"
  );
  const child = spawn("wscript.exe", ["//B", "//Nologo", vbsPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  // Give the helper a moment to start watching our PID before we exit.
  setTimeout(() => {
    app.quit();
  }, 800);
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
const intactCache = new Map();

function fileContainsAllMarkers(filePath, markers) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let carry = "";
    const found = new Set();
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      const chunk = carry + buf.toString("utf8", 0, n);
      for (const marker of markers) {
        if (!found.has(marker) && chunk.includes(marker)) found.add(marker);
      }
      if (found.size === markers.length) return true;
      carry = chunk.length > 96 ? chunk.slice(-96) : chunk;
    }
    return found.size === markers.length;
  } finally {
    fs.closeSync(fd);
  }
}

function bastionWebRootIsIntact(webRoot) {
  if (!webRoot) return false;
  if (intactCache.has(webRoot)) return intactCache.get(webRoot);

  const indexPath = path.join(webRoot, "index.html");
  const autopilot = path.join(webRoot, "story", "autopilot.js");
  const i18n = path.join(webRoot, "story", "i18n.js");
  let ok = false;
  if (fs.existsSync(indexPath) && fs.existsSync(autopilot) && fs.existsSync(i18n)) {
    let html = "";
    try {
      html = fs.readFileSync(indexPath, "utf8");
    } catch {
      html = "";
    }
    if (
      html.includes("__RG_STORY_MODE__") &&
      html.includes("/story/i18n.js") &&
      html.includes("/story/autopilot.js")
    ) {
      const m = html.match(/\/assets\/(index-[^"' ]+\.js)/);
      if (m) {
        const assetPath = path.join(webRoot, "assets", m[1]);
        if (fs.existsSync(assetPath)) {
          try {
            ok = fileContainsAllMarkers(assetPath, ["__RG_GAME__", "__RG_NET__"]);
          } catch {
            ok = false;
          }
        }
      }
    }
  }
  intactCache.set(webRoot, ok);
  return ok;
}

function invalidateIntactCache(webRoot) {
  if (webRoot) intactCache.delete(webRoot);
  else intactCache.clear();
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
  // Prefer .bastion-stamp: when present and equal, trust it (avoids reading ~1MB
  // of story JS on every cold start). Fall back to byte compares for older bundles.
  const bundleStamp = path.join(bundleStory, BASTION_STAMP_NAME);
  if (fs.existsSync(bundleStamp)) {
    return storyStampMatches(bundleStory, userStory);
  }
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

  invalidateIntactCache(userWeb);
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

/**
 * Official PC launcher uses schema-1 envelopes:
 *   { schema:1, key, payload:<base64 JSON>, sig }
 * Legacy Tauri channel uses { version, platforms.windows-x86_64.url }.
 */
function normalizeGameManifest(raw) {
  const data = raw && typeof raw === "object" ? raw : {};
  if (Number(data.schema) === 1 && data.payload) {
    let payload;
    try {
      payload = JSON.parse(Buffer.from(String(data.payload), "base64").toString("utf8"));
    } catch (err) {
      throw new Error(`PC update envelope payload invalid: ${err.message || err}`);
    }
    const version = String(payload.version || "").trim();
    const files = Array.isArray(payload.files) ? payload.files : [];
    const game =
      files.find((f) => f && (f.path === "redgalaxy-game.exe" || f.component === "game")) || null;
    const blobsPrefix = String(
      (payload.base_url && payload.base_url.blobs) || "blobs/"
    ).replace(/^\/+/, "");
    const base = "https://updates.redgalaxygame.space/pc/";
    const sha = game && game.sha256 ? String(game.sha256).trim() : "";
    return {
      kind: "pc",
      version,
      notes: String(payload.notes || "").trim(),
      launcher: payload.launcher || null,
      gameBlobUrl: sha ? `${base}${blobsPrefix}${sha}` : "",
      gameSha256: sha,
      gameSize: game && game.size ? Number(game.size) || 0 : 0,
      gameZsize: game && game.zsize ? Number(game.zsize) || 0 : 0,
      installerUrl: "",
      assetFiles: files.filter((f) => f && f.component === "assets"),
    };
  }
  const version = String(data.version || "").trim();
  const platforms = data.platforms || {};
  const win = platforms["windows-x86_64"] || platforms.windows || {};
  return {
    kind: "tauri",
    version,
    notes: String(data.notes || "").trim(),
    launcher: null,
    gameBlobUrl: "",
    gameSha256: "",
    gameSize: 0,
    gameZsize: 0,
    installerUrl: String((win && win.url) || "").trim(),
    assetFiles: [],
  };
}

function decompressZstdFile(srcPath, destPath) {
  let decompress;
  try {
    ({ decompress } = require("fzstd"));
  } catch (err) {
    throw new Error(
      `Decompressione zstd non disponibile (fzstd): ${err.message || err}`
    );
  }
  const compressed = fs.readFileSync(srcPath);
  const out = Buffer.from(decompress(compressed));
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, out);
  return destPath;
}

async function downloadPcGameExecutable(manifest, onProgress) {
  if (!manifest || !manifest.gameBlobUrl) {
    throw new Error("PC manifest missing redgalaxy-game.exe blob URL");
  }
  const downloads = path.join(app.getPath("userData"), "downloads");
  fs.mkdirSync(downloads, { recursive: true });
  const ver = String(manifest.version || "game").replace(/[^\w.-]+/g, "_");
  const exePath = path.join(downloads, `redgalaxy-game-${ver}.exe`);
  const zstPath = `${exePath}.zst`;
  if (
    fs.existsSync(exePath) &&
    manifest.gameSize > 0 &&
    fs.statSync(exePath).size === manifest.gameSize
  ) {
    return exePath;
  }
  await downloadFile(manifest.gameBlobUrl, zstPath, onProgress);
  setUpdateStatus({
    phase: "download",
    percent: 72,
    message: "Decompressione client ufficiale (zstd)…",
  });
  decompressZstdFile(zstPath, exePath);
  try {
    fs.unlinkSync(zstPath);
  } catch {
    /* ignore */
  }
  if (manifest.gameSize > 0 && fs.statSync(exePath).size !== manifest.gameSize) {
    throw new Error(
      `Client decompresso incompleto (${fs.statSync(exePath).size} ≠ ${manifest.gameSize})`
    );
  }
  return exePath;
}

const GAME_ART_DIRS = [
  "ships",
  "maps",
  "drones",
  "equip",
  "box",
  "missiles",
  "ore",
  "portals",
  "ranks",
  "corps",
  "base",
  "extras",
  "icons",
  "shop",
  "ui",
  "effects",
  "audio",
];

/** Root-level files the login/boot UI expects (PE embeds redgalaxy2.png; UI asks redgalaxy.png). */
const GAME_ART_ROOT_FILES = ["redgalaxy.png", "redgalaxy2.png", "bg.jpg", "box.png"];

function webHasGameArt(webRoot) {
  try {
    if (!webRoot || !fs.existsSync(webRoot)) return false;
    if (!fs.existsSync(path.join(webRoot, "ships")) || !fs.existsSync(path.join(webRoot, "maps"))) {
      return false;
    }
    let atlasCount = 0;
    const walk = (dir, depth = 0) => {
      if (depth > 6 || atlasCount >= 20) return;
      let names;
      try {
        names = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of names) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full, depth + 1);
        else if (ent.name.endsWith(".atlas")) atlasCount += 1;
      }
    };
    walk(webRoot);
    return atlasCount >= 20;
  } catch {
    return false;
  }
}

function mergeMissingGameArt(targetDir, donorDir) {
  if (!targetDir || !donorDir || !fs.existsSync(donorDir) || !fs.existsSync(targetDir)) {
    return 0;
  }
  let copied = 0;
  for (const name of GAME_ART_ROOT_FILES) {
    const from = path.join(donorDir, name);
    const to = path.join(targetDir, name);
    if (fs.existsSync(from) && !fs.existsSync(to)) {
      fs.copyFileSync(from, to);
      copied += 1;
    }
  }
  // Prefer a real logo alias immediately when only redgalaxy2.png landed from the PE.
  const logo = path.join(targetDir, "redgalaxy.png");
  const logo2 = path.join(targetDir, "redgalaxy2.png");
  if (!fs.existsSync(logo) && fs.existsSync(logo2)) {
    fs.copyFileSync(logo2, logo);
    copied += 1;
  }
  for (const name of GAME_ART_DIRS) {
    const src = path.join(donorDir, name);
    const dst = path.join(targetDir, name);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(dst, { recursive: true });
    // Fill gaps file-by-file without clobbering newer extract outputs.
    const stack = [""];
    while (stack.length) {
      const rel = stack.pop();
      const fromDir = path.join(src, rel);
      let ents;
      try {
        ents = fs.readdirSync(fromDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of ents) {
        const child = rel ? path.join(rel, ent.name) : ent.name;
        const from = path.join(src, child);
        const to = path.join(dst, child);
        if (ent.isDirectory()) {
          fs.mkdirSync(to, { recursive: true });
          stack.push(child);
        } else if (!fs.existsSync(to)) {
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.copyFileSync(from, to);
          copied += 1;
        }
      }
    }
  }
  return copied;
}

function pcAssetPacksDir() {
  return path.join(app.getPath("userData"), "rgpak");
}

/**
 * Download PC .rgpak asset blobs (zstd→RGPAK) next to the game exe cache.
 * Decrypt+extract runs when RGPAK_AES_KEY is set; otherwise packs stay on disk
 * and runtime aliases / donor merge cover the Bastion HTTP client.
 */
async function downloadPcAssetPacks(manifest, onProgress) {
  const assets = Array.isArray(manifest && manifest.assetFiles) ? manifest.assetFiles : [];
  if (!assets.length) return [];
  const packsDir = pcAssetPacksDir();
  fs.mkdirSync(packsDir, { recursive: true });
  const base = "https://updates.redgalaxygame.space/pc/";
  const blobsPrefix = "blobs/";
  const out = [];
  for (let i = 0; i < assets.length; i++) {
    const f = assets[i];
    const sha = f && f.sha256 ? String(f.sha256).trim() : "";
    if (!sha) continue;
    const name = path.basename(String(f.path || `${sha}.rgpak`));
    const dest = path.join(packsDir, name);
    const expect = f.size ? Number(f.size) || 0 : 0;
    if (fs.existsSync(dest) && expect > 0 && fs.statSync(dest).size === expect) {
      out.push(dest);
      continue;
    }
    const url = `${base}${blobsPrefix}${sha}`;
    const zst = `${dest}.zst`;
    const pctBase = Math.round((i / Math.max(assets.length, 1)) * 100);
    await downloadFile(url, zst, (pct) => {
      if (typeof onProgress === "function") {
        onProgress(Math.min(99, pctBase + Math.round(pct / Math.max(assets.length, 1))));
      }
    });
    try {
      decompressZstdFile(zst, dest);
    } catch (err) {
      // Some mirrors may already be raw RGPAK.
      fs.copyFileSync(zst, dest);
      console.warn("rgpak zstd decompress failed, kept raw:", err.message || err);
    }
    try {
      fs.unlinkSync(zst);
    } catch {
      /* ignore */
    }
    out.push(dest);
  }
  return out;
}

function tryUnpackRgpakPacks(packPaths, outDir) {
  const key = String(process.env.RGPAK_AES_KEY || process.env.RGPAK_KEY || "").trim();
  if (!key) {
    console.warn(
      "RGPAK packs downloaded but RGPAK_AES_KEY unset — using donor merge + runtime aliases (encrypted index)."
    );
    return 0;
  }
  const unpacker = nodeToolPath("rgpak_unpack.js");
  if (!fs.existsSync(unpacker)) {
    console.warn("rgpak_unpack.js missing — skip decrypt");
    return 0;
  }
  try {
    const { spawnSync } = require("child_process");
    const args = [unpacker, "--out", outDir, "--key", key, ...packPaths];
    const r = spawnSync(process.execPath, args, {
      encoding: "utf8",
      env: { ...process.env, RGPAK_AES_KEY: key },
      maxBuffer: 16 * 1024 * 1024,
    });
    if (r.stdout) console.log(String(r.stdout).slice(0, 4000));
    if (r.status !== 0) {
      console.warn("rgpak unpack failed:", (r.stderr || r.stdout || "").toString().slice(0, 2000));
      return 0;
    }
    return 1;
  } catch (err) {
    console.warn("rgpak unpack error:", err.message || err);
    return 0;
  }
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

/**
 * Parse Bastion/game version strings into numeric parts.
 * Handles `1.0.6-mac43` style stamps (mac build is a trailing component).
 * Without this, `1.0.6-mac43` and `1.0.6-mac48` both collapse to [1,0,6].
 */
function parseVersionParts(raw) {
  const s = String(raw || "")
    .trim()
    .replace(/^v/i, "");
  if (!s) return [0];
  const macMatch = s.match(/^(.*)-mac(\d+)$/i);
  const base = macMatch ? macMatch[1] : s;
  const macNum = macMatch ? parseInt(macMatch[2], 10) || 0 : 0;
  const parts = String(base)
    .split(/[^0-9]+/)
    .filter((x) => x.length > 0)
    .map((x) => parseInt(x, 10) || 0);
  if (!parts.length) parts.push(0);
  parts.push(macNum);
  return parts;
}

function compareVersion(a, b) {
  const left = parseVersionParts(a);
  const right = parseVersionParts(b);
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
    // Legacy Tauri package id.
    let vm = text.match(/redgalaxy-client@([0-9][0-9A-Za-z.+_-]*)/);
    if (vm) return versionFromReleaseId(vm[1]);
    // Native/PC client 0.9.x embeds ncVersion:"0.9.17+deadbeef".
    vm = text.match(/ncVersion:"([0-9][0-9A-Za-z.+_-]*)"/);
    if (vm) return versionFromReleaseId(vm[1]);
    vm = text.match(/"([0-9]+\.[0-9]+\.[0-9]+\+[A-Za-z0-9]+)"\.split\("\+"\)/);
    if (vm) return versionFromReleaseId(vm[1]);
    return "";
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
 * Prefer version.txt (Tauri/manifest, e.g. 1.0.12). Game JS still embeds
 * redgalaxy-client@0.6.x which is NOT the official installer version.
 */
function readInstalledVersion() {
  const recorded = readVersionFile();
  if (recorded) return recorded;
  for (const root of [userWebRoot(), bundledWebRoot()]) {
    const embedded = readEmbeddedWebVersion(root);
    if (embedded) return embedded;
  }
  return "";
}

function gameWebIsComplete(webRoot) {
  try {
    if (!fs.existsSync(path.join(webRoot, "index.html"))) return false;
    if (!fs.existsSync(path.join(webRoot, "assets"))) return false;
    if (!fs.existsSync(path.join(webRoot, "maps"))) return false;
    if (!fs.existsSync(path.join(webRoot, "ships"))) return false;
    // Negozio + Home hangar load shop/** (extras + ship previews) — PE 0.9.x omits them.
    const bootyPreview = path.join(webRoot, "shop", "extras", "preview", "booty.webp");
    if (!fs.existsSync(bootyPreview) || fs.statSync(bootyPreview).size < 1) return false;
    const shipPreview = path.join(webRoot, "shop", "ship", "preview", "ship10.webp");
    if (!fs.existsSync(shipPreview) || fs.statSync(shipPreview).size < 1) return false;
    let shopCount = 0;
    const countShop = (dir, depth = 0) => {
      if (depth > 6 || shopCount >= 40) return;
      let names;
      try {
        names = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of names) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) countShop(full, depth + 1);
        else shopCount += 1;
      }
    };
    countShop(path.join(webRoot, "shop"));
    if (shopCount < 40) return false;
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
    // Spine/libGDX .atlas sheets required to draw ships/NPCs (HUD can work without → black world).
    let atlasCount = 0;
    const countAtlas = (dir, depth = 0) => {
      if (depth > 6) return;
      let names;
      try {
        names = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of names) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) countAtlas(full, depth + 1);
        else if (ent.name.endsWith(".atlas")) atlasCount += 1;
      }
    };
    countAtlas(webRoot);
    if (atlasCount < 20) return false;
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
  const recorded = readVersionFile();
  if (recorded && recorded === remote) return true;
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
  // Prefer worker_threads: same embedded Node, no second RedGalaxy-Bastion.exe.
  // Spawning process.execPath without a working ELECTRON_RUN_AS_NODE re-enters the
  // portable app (single-instance lock) and the parent waits until timeout — error
  // message then names Bastion.exe even though this is a game-extract step.
  const timeoutMs = Number(extraOpts.timeoutMs) || 300000;
  const onOutput = typeof extraOpts.onOutput === "function" ? extraOpts.onOutput : null;
  const env = {
    ...process.env,
    ...(extraOpts.env || {}),
  };
  // Workers must not inherit portable/Electron relaunch hints.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.PORTABLE_EXECUTABLE_FILE;
  delete env.PORTABLE_EXECUTABLE_DIR;

  const runViaSpawn = () => {
    const spawnEnv = {
      ...process.env,
      ...(extraOpts.env || {}),
      ELECTRON_RUN_AS_NODE: "1",
    };
    return runCommand(process.execPath, [scriptPath, ...scriptArgs], {
      timeoutMs,
      onOutput,
      env: spawnEnv,
    });
  };

  let worker;
  try {
    worker = new Worker(scriptPath, {
      argv: scriptArgs,
      stdout: true,
      stderr: true,
      env,
    });
  } catch (workerErr) {
    console.warn(
      "worker_threads unavailable, falling back to ELECTRON_RUN_AS_NODE:",
      workerErr.message || workerErr
    );
    return runViaSpawn();
  }

  return new Promise((resolve, reject) => {
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
            try {
              worker.terminate();
            } catch {
              /* ignore */
            }
            finish(() =>
              reject(new Error(`extract/patch worker timeout after ${timeoutMs}ms\n${out}`))
            );
          }, timeoutMs)
        : null;
    const handleChunk = (buf) => {
      const text = buf.toString();
      out += text;
      if (onOutput) onOutput(text);
    };
    if (worker.stdout) worker.stdout.on("data", handleChunk);
    if (worker.stderr) worker.stderr.on("data", handleChunk);
    worker.on("error", (err) => finish(() => reject(err)));
    worker.on("exit", (code) => {
      if (code === 0) finish(() => resolve(out));
      else finish(() => reject(new Error(`extract/patch worker exited ${code}\n${out}`)));
    });
  });
}

function startUpdateHeartbeat(phase, basePercent, message) {
  let tick = 0;
  let lastRealAt = 0;
  const timer = setInterval(() => {
    tick += 1;
    // When extract_progress lines update the bar, don't overwrite with the fake 91% cap.
    if (Date.now() - lastRealAt < 2000) return;
    const wobble = Math.min(9, tick);
    setUpdateStatus({
      phase,
      percent: Math.min(basePercent + wobble, basePercent + 9),
      message: `${message} (${tick}s)`,
    });
  }, 1000);
  const stop = () => clearInterval(timer);
  stop.noteRealProgress = () => {
    lastRealAt = Date.now();
  };
  return stop;
}

function onExtractProgressOutput(text, heartbeat, basePercent) {
  const re = /extract_progress\s+extracted=(\d+)\s+pending=(\d+)/g;
  let m;
  let last = null;
  while ((m = re.exec(String(text || ""))) !== null) {
    last = m;
  }
  if (!last) return;
  if (heartbeat && typeof heartbeat.noteRealProgress === "function") {
    heartbeat.noteRealProgress();
  }
  const done = Number(last[1]) || 0;
  const pending = Math.max(Number(last[2]) || 1, 1);
  const frac = Math.min(1, done / pending);
  const percent = Math.min(basePercent + 9, basePercent + Math.floor(frac * 9));
  setUpdateStatus({
    phase: "extract",
    percent,
    message: `Estrazione asset web (Node)… ${done}/${pending}`,
  });
}

async function runExtractAndPatch({
  clientExe,
  rawOut,
  finalOut,
  storySrc,
  artDonors = [],
  rgpakPacks = [],
}) {
  const extractorJs = nodeToolPath("extract_redgalaxy_web.js");
  const patcherJs = nodeToolPath("apply_bastion_patches.js");
  const extractorPy = nodeToolPath("extract_redgalaxy_web.py");
  const patcherPy = nodeToolPath("apply_bastion_patches.py");

  // Never patch/rm the live user web root here — Windows locks open assets while
  // the HTTP server / Chromium serve them. Callers must pass a staging dir, then
  // publishUserWebRoot() after closing the server.
  const fillArtIfNeeded = () => {
    // Prefer live decrypt of current packs when the AES key is available.
    const packs =
      Array.isArray(rgpakPacks) && rgpakPacks.length
        ? rgpakPacks
        : fs.existsSync(pcAssetPacksDir())
          ? fs
              .readdirSync(pcAssetPacksDir())
              .filter((n) => n.endsWith(".rgpak"))
              .map((n) => path.join(pcAssetPacksDir(), n))
          : [];
    if (packs.length) {
      tryUnpackRgpakPacks(packs, rawOut);
    }
    for (const donor of artDonors) {
      if (!donor || donor === rawOut) continue;
      const n = mergeMissingGameArt(rawOut, donor);
      if (n > 0) {
        console.warn(`Merged ${n} missing art file(s) from donor into extract staging.`);
      }
    }
    // Always ensure login logo + event skin aliases even when ships/maps already look "complete".
    const logo = path.join(rawOut, "redgalaxy.png");
    const logo2 = path.join(rawOut, "redgalaxy2.png");
    if (!fs.existsSync(logo) && fs.existsSync(logo2)) {
      fs.copyFileSync(logo2, logo);
    }
    for (const donor of artDonors) {
      if (!donor || donor === rawOut) continue;
      mergeMissingGameArt(rawOut, donor);
    }
    try {
      const extractMod = require(extractorJs);
      if (typeof extractMod.ensureRuntimeAssetAliases === "function") {
        extractMod.ensureRuntimeAssetAliases(rawOut);
      }
    } catch (aliasErr) {
      console.warn("Runtime asset aliases failed:", aliasErr.message || aliasErr);
    }
  };

  const extractLooksUsable = () =>
    fs.existsSync(path.join(rawOut, "index.html")) &&
    fs.existsSync(path.join(rawOut, "assets"));

  const hasNodePipeline = fs.existsSync(extractorJs) && fs.existsSync(patcherJs);
  if (hasNodePipeline) {
    setUpdateStatus({ phase: "extract", percent: 82, message: "Estrazione asset web (Node)…" });
    const stopExtractBeat = startUpdateHeartbeat("extract", 82, "Estrazione asset web (Node)…");
    try {
      await runNodeTool(extractorJs, [clientExe, rawOut], {
        onOutput: (text) => onExtractProgressOutput(text, stopExtractBeat, 82),
      });
    } catch (err) {
      // PC 0.9.x: extractor may exit non-zero when .rgpak art is absent from the PE.
      // If index/assets exist, continue and merge art from donors before failing.
      if (extractLooksUsable()) {
        console.warn(
          "Extractor exited non-zero but produced a usable web root — merging art donors…",
          err && err.message ? err.message : err
        );
      } else {
        if (err && typeof err === "object") err.rgExtractFailed = true;
        throw err;
      }
    } finally {
      stopExtractBeat();
    }
    fillArtIfNeeded();
    if (!gameWebIsComplete(rawOut)) {
      throw new Error(
        "Estrazione incompleta (mancano index/lang/woff2/ships/maps). Riprova Aggiorna gioco; se persiste, reinstalla il client ufficiale."
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
  } catch (err) {
    if (extractLooksUsable()) {
      console.warn(
        "Python extractor exited non-zero but produced a usable web root — merging art donors…",
        err && err.message ? err.message : err
      );
    } else {
      throw err;
    }
  } finally {
    stopExtractBeat();
  }
  fillArtIfNeeded();
  if (!gameWebIsComplete(rawOut)) {
    throw new Error(
      "Estrazione incompleta (mancano index/lang/woff2/ships/maps). Riprova Aggiorna gioco; se persiste, reinstalla il client ufficiale."
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
      "Aggiornamento senza versione gioco nell'embed (redgalaxy-client@ / ncVersion). Estrazione o patch non valida."
    );
  }

  await closeStaticServer();
  // Brief settle so Windows releases ReadStream handles from the old root.
  await new Promise((r) => setTimeout(r, 250));

  invalidateIntactCache(liveOut);
  invalidateIntactCache(stagingOut);

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
  if (/timeout after/i.test(raw) && /extract|patch|node|electron|worker|bastion/i.test(lower)) {
    return "Tempo scaduto durante estrazione/patch. Riprova; se persiste, chiudi Bastion e riprova Aggiorna gioco.";
  }
  if (/ebusy|eperm|eacces|resource busy|being used by another process/i.test(lower)) {
    return `File di gioco in uso o permessi AppData insufficienti. Chiudi altre copie di Bastion e riprova.\n${raw}`;
  }
  if (/redgalaxy-client\.exe non trovato/i.test(raw)) {
    return raw;
  }
  if (/updater scripts missing|script di aggiornamento mancanti/i.test(lower)) {
    return "Scarica di nuovo il portable Bastion (.exe) dal release ufficiale.";
  }
  if (/enonet|enoent/i.test(lower) && /brotli|extract/i.test(lower)) {
    return `Estrazione fallita (brotli/asset): ${raw}`;
  }
  if (/python/i.test(lower) && /store|stub|not found/i.test(lower)) {
    return "Python non disponibile. Usa il pacchetto Bastion aggiornato (estrazione Node inclusa) oppure installa Python da python.org.";
  }
  return raw || "Aggiornamento non riuscito per un errore sconosciuto.";
}

/**
 * Wait until the official client exe is a complete PE file whose size is stable.
 * Tauri/NSIS setup can return before the exe is fully written; extracting a
 * partial/empty file gave "extracted=0 pending=1 failed=1 ms=7".
 */
async function waitForClientExeReady(exePath, timeoutMs = 90000) {
  if (!exePath) return false;
  const deadline = Date.now() + timeoutMs;
  let lastSize = -1;
  while (Date.now() < deadline) {
    try {
      const st = fs.statSync(exePath);
      if (st.size >= 1_000_000 && st.size === lastSize) {
        const fd = fs.openSync(exePath, "r");
        try {
          const head = Buffer.alloc(2);
          fs.readSync(fd, head, 0, 2, 0);
          if (head[0] === 0x4d && head[1] === 0x5a) return true;
        } finally {
          fs.closeSync(fd);
        }
      }
      lastSize = st.size;
    } catch {
      lastSize = -1;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.warn(`Official client exe not ready after ${timeoutMs}ms: ${exePath}`);
  return false;
}

function findInstalledClientExe() {
  const local = process.env.LOCALAPPDATA || "";
  const roaming = process.env.APPDATA || "";
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const userProfile = process.env.USERPROFILE || "";
  const portableDir = String(process.env.PORTABLE_EXECUTABLE_DIR || "").trim();
  const ruCandidates = [
    path.join(local, "RedUniverse", "reduniverse-pc-client.exe"),
    path.join(local, "RedUniverse", "reduniverse-client.exe"),
    path.join(local, "RedUniverse", "RedUniverse.exe"),
    path.join(roaming, "RedUniverse", "reduniverse-pc-client.exe"),
    path.join(programFiles, "RedUniverse", "reduniverse-pc-client.exe"),
    path.join(programFilesX86, "RedUniverse", "reduniverse-pc-client.exe"),
    path.join(local, "Programs", "RedUniverse", "reduniverse-pc-client.exe"),
    portableDir ? path.join(portableDir, "reduniverse-pc-client.exe") : "",
    portableDir ? path.join(portableDir, "RedUniverse.exe") : "",
    userProfile ? path.join(userProfile, "Desktop", "reduniverse-pc-client.exe") : "",
    userProfile ? path.join(userProfile, "Desktop", "RedUniverse.exe") : "",
  ];
  const rgCandidates = [
    path.join(local, "RedGalaxy", "redgalaxy-game.exe"),
    path.join(local, "RedGalaxy", "current", "redgalaxy-game.exe"),
    path.join(local, "RedGalaxy", "redgalaxy-client.exe"),
    path.join(local, "RedGalaxy", "RedGalaxy.exe"),
    path.join(roaming, "RedGalaxy", "redgalaxy-game.exe"),
    path.join(roaming, "RedGalaxy", "redgalaxy-client.exe"),
    path.join(programFiles, "RedGalaxy", "redgalaxy-game.exe"),
    path.join(programFiles, "RedGalaxy", "redgalaxy-client.exe"),
    path.join(programFilesX86, "RedGalaxy", "redgalaxy-client.exe"),
    path.join(local, "Programs", "RedGalaxy", "redgalaxy-client.exe"),
    portableDir ? path.join(portableDir, "redgalaxy-game.exe") : "",
    portableDir ? path.join(portableDir, "redgalaxy-client.exe") : "",
    portableDir ? path.join(portableDir, "RedGalaxy.exe") : "",
    userProfile ? path.join(userProfile, "Desktop", "redgalaxy-game.exe") : "",
    userProfile ? path.join(userProfile, "Desktop", "redgalaxy-client.exe") : "",
    userProfile ? path.join(userProfile, "Desktop", "RedGalaxy.exe") : "",
  ];
  // Prefer the brand this Bastion was built for (avoid harvesting the twin client).
  const candidates =
    PRODUCT_BRAND === "reduniverse"
      ? [...ruCandidates, ...rgCandidates]
      : [...rgCandidates, ...ruCandidates];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Download official setup and try silent NSIS install.
 * Returns path to redgalaxy-client.exe when found afterwards (may still be null).
 */
async function downloadAndSilentInstallOfficialClient(installerUrl) {
  setUpdateStatus({
    phase: "download",
    percent: 8,
    message: "Download installer ufficiale…",
  });
  const downloads = path.join(app.getPath("userData"), "downloads");
  fs.mkdirSync(downloads, { recursive: true });
  const installerPath = path.join(
    downloads,
    path.basename(installerUrl) ||
      (PRODUCT_BRAND === "reduniverse" ? "RedUniverse-Setup.exe" : "RedGalaxy-Setup.exe")
  );
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
    // Tauri/NSIS: /S. Also try current-user passive flags used by some builds.
    try {
      await runCommand(installerPath, ["/S"], { shell: false, timeoutMs: 120000 });
    } catch (err) {
      console.warn("Installer /S failed, retrying /S /currentuser:", err.message || err);
      await runCommand(installerPath, ["/S", "/currentuser"], {
        shell: false,
        timeoutMs: 120000,
      });
    }
  } catch (err) {
    console.warn("Installer failed/timeout (may still have installed):", err.message || err);
  } finally {
    stopInstallBeat();
  }
  const installed = findInstalledClientExe();
  if (installed) await waitForClientExeReady(installed);
  return installed;
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
    const rawManifest = await httpsGetJson(UPDATE_MANIFEST_URL);
    const manifest = normalizeGameManifest(rawManifest);
    const remote = String(manifest.version || "").trim();
    if (!remote) throw new Error("Manifest missing version");
    const launcherHint =
      manifest.launcher && manifest.launcher.version
        ? ` (launcher ${manifest.launcher.version})`
        : "";
    setUpdateStatus({
      remote,
      percent: 5,
      message: `Versione ufficiale: ${remote}${launcherHint}`,
    });
    const installed = readInstalledVersion();
    const recorded = readVersionFile();
    const liveOk = gameClientMatchesRemote(remote);

    // Skip re-extract when already on official latest with a complete live web,
    // even if the UI requested force (was causing endless Windows re-extract).
    if (installed && compareVersion(installed, remote) >= 0 && liveOk) {
      writeInstalledVersion(remote);
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

    const liveWebVersion = readEmbeddedWebVersion(userWebRoot());
    const versionFileLie = !!(
      recorded &&
      liveWebVersion &&
      recorded !== liveWebVersion
    );
    if (versionFileLie) {
      console.warn(
        `version.txt (${recorded}) disagrees with live game web (${liveWebVersion}) — refreshing game assets.`
      );
    }
    if (!liveOk) {
      console.warn(
        `Game web incomplete or behind official ${remote} (live=${installed || "missing"}) — refreshing.`
      );
    }

    const installerUrl = String(
      manifest.installerUrl || BRAND_GAME_UPDATE.fallbackInstallerUrl
    ).trim();

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
    // Prefer bundled / richer donors BEFORE live web — a depleted live cache can
    // keep ships/maps while shop/ is empty (Negozio blue ? after 0.9.x Aggiorna).
    const artDonors = [];
    const pushDonor = (dir) => {
      if (!dir || !fs.existsSync(dir) || artDonors.includes(dir)) return;
      if (webHasGameArt(dir) || fs.existsSync(path.join(dir, "shop", "extras", "preview", "booty.webp"))) {
        artDonors.push(dir);
      }
    };
    pushDonor(bundledWebRoot());
    try {
      const support = supportDir();
      for (const name of fs.readdirSync(support)) {
        if (!name.startsWith("extract-raw")) continue;
        const cand = path.join(support, name);
        if (fs.existsSync(path.join(cand, "shop"))) pushDonor(cand);
      }
    } catch {
      /* ignore */
    }
    pushDonor(userWebRoot());

    const runStagingExtract = async (sourceExe, statusMessage, donors = artDonors) => {
      fs.rmSync(rawOut, { recursive: true, force: true });
      fs.rmSync(stagingOut, { recursive: true, force: true });
      fs.mkdirSync(rawOut, { recursive: true });
      setUpdateStatus({
        phase: "extract",
        percent: 80,
        message: statusMessage,
      });
      await runExtractAndPatch({
        clientExe: sourceExe,
        rawOut,
        finalOut: stagingOut,
        storySrc: storySrcRoot(),
        artDonors: donors,
        rgpakPacks: downloadedPacks,
      });
      return readEmbeddedWebVersion(stagingOut);
    };

    let clientExe = null;
    let downloadedPacks = [];
    if (manifest.kind === "pc" && manifest.gameBlobUrl) {
      setUpdateStatus({
        phase: "download",
        percent: 8,
        message: `Download client PC ${remote}…`,
      });
      clientExe = await downloadPcGameExecutable(manifest, (pct) => {
        setUpdateStatus({
          phase: "download",
          percent: Math.min(55, pct),
          message: `Download client PC… ${pct}%`,
        });
      });
      setUpdateStatus({
        phase: "download",
        percent: 58,
        message: "Download pacchetti asset (.rgpak)…",
      });
      try {
        downloadedPacks = await downloadPcAssetPacks(manifest, (pct) => {
          setUpdateStatus({
            phase: "download",
            percent: 58 + Math.round(pct * 0.15),
            message: `Download pacchetti asset… ${pct}%`,
          });
        });
      } catch (packErr) {
        console.warn("Asset pack download failed (continuing with PE + donors):", packErr.message || packErr);
      }
    } else {
      // Compatible with the official Desktop EXE path:
      // Bastion harvests web assets from that binary first — NOT re-download +
      // silent-reinstall whenever Bastion's AppData web cache is merely behind.
      clientExe = findInstalledClientExe();
      if (!clientExe) {
        console.warn(
          `Official ${BRAND_GAME_UPDATE.clientExeHint} not found — downloading installer.`
        );
        clientExe = await downloadAndSilentInstallOfficialClient(installerUrl);
      } else {
        setUpdateStatus({
          phase: "extract",
          percent: 78,
          message: "Client ufficiale trovato — estraggo senza reinstallare…",
        });
      }
    }

    if (!clientExe) {
      throw new Error(
        `${BRAND_GAME_UPDATE.clientExeHint} non trovato. Aggiorna/installa una volta il client ufficiale ${BRAND_GAME_UPDATE.clientLabel}, poi riprova Aggiorna gioco in Bastion.`
      );
    }

    // Legacy full Tauri client still embeds ships/maps; PC 0.9.x keeps art in encrypted .rgpak.
    const legacyClient = findInstalledClientExe();
    if (
      legacyClient &&
      path.resolve(legacyClient) !== path.resolve(clientExe) &&
      /redgalaxy-client\.exe$/i.test(legacyClient)
    ) {
      // Will be used only if live web lacks art: extract into a temp donor after first pass fails.
      artDonors.push(userWebRoot());
    }

    await waitForClientExeReady(clientExe, 15000);
    let embeddedStaged = null;
    try {
      embeddedStaged = await runStagingExtract(
        clientExe,
        "Preparazione asset (staging, senza toccare la cache live)…"
      );
    } catch (err) {
      // Extract-only failure (truncated/old client exe): fall through to the
      // official reinstall + re-extract below. Patch-step errors still propagate.
      if (!(err && err.rgExtractFailed)) {
        // Incomplete extract (missing art) — try harvesting art from legacy client.
        if (!gameWebIsComplete(stagingOut) && legacyClient && /redgalaxy-client\.exe$/i.test(legacyClient)) {
          console.warn("PC extract missing art — harvesting from legacy redgalaxy-client.exe");
          const donorRaw = path.join(supportDir(), "art-donor-raw");
          fs.rmSync(donorRaw, { recursive: true, force: true });
          fs.mkdirSync(donorRaw, { recursive: true });
          try {
            const extractorJs2 = nodeToolPath("extract_redgalaxy_web.js");
            if (fs.existsSync(extractorJs2)) {
              await runNodeTool(extractorJs2, [legacyClient, donorRaw], {});
              artDonors.unshift(donorRaw);
              embeddedStaged = await runStagingExtract(
                clientExe,
                "Re-estrazione con asset grafici dal client legacy…"
              );
            } else {
              throw err;
            }
          } catch (donorErr) {
            console.warn("Legacy art harvest failed:", donorErr.message || donorErr);
            throw err;
          }
        } else {
          throw err;
        }
      } else {
        console.warn("Extract from installed client failed — reinstalling official client:", err.message || err);
        embeddedStaged = null;
      }
    }

    // Tauri/PC manifest version may differ from package embed. A successful
    // extract with a valid embed is enough; only reinstall if extract failed.
    if (!embeddedStaged || !gameWebIsComplete(stagingOut)) {
      if (manifest.kind === "pc" && manifest.gameBlobUrl) {
        // Re-download PC blob once, then try art donor from nc-bridge if still incomplete.
        console.warn(
          `PC client extract incomplete (embed=${embeddedStaged || "unknown"}) — re-downloading blob.`
        );
        try {
          fs.unlinkSync(clientExe);
        } catch {
          /* ignore */
        }
        clientExe = await downloadPcGameExecutable(manifest, (pct) => {
          setUpdateStatus({
            phase: "download",
            percent: pct,
            message: `Re-download client PC… ${pct}%`,
          });
        });
        embeddedStaged = await runStagingExtract(
          clientExe,
          "Re-estrazione dopo download client PC…"
        );
      }
      if (!embeddedStaged || !gameWebIsComplete(stagingOut)) {
        console.warn(
          `Installed client extract incomplete (embed=${embeddedStaged || "unknown"}) — downloading installer.`
        );
        const artManifestUrl = BRAND_GAME_UPDATE.artDonorManifestUrl;
        let donorInstallerUrl = installerUrl;
        if (artManifestUrl) {
          try {
            const artMan = normalizeGameManifest(await httpsGetJson(artManifestUrl));
            if (artMan.installerUrl) donorInstallerUrl = artMan.installerUrl;
          } catch (e) {
            console.warn("Art donor manifest fetch failed:", e.message || e);
          }
        }
        const refreshed = await downloadAndSilentInstallOfficialClient(donorInstallerUrl);
        const donorExe = refreshed || findInstalledClientExe();
        if (donorExe && /redgalaxy-client\.exe$/i.test(donorExe)) {
          const donorRaw = path.join(supportDir(), "art-donor-raw");
          fs.rmSync(donorRaw, { recursive: true, force: true });
          fs.mkdirSync(donorRaw, { recursive: true });
          const extractorJs2 = nodeToolPath("extract_redgalaxy_web.js");
          if (fs.existsSync(extractorJs2)) {
            await runNodeTool(extractorJs2, [donorExe, donorRaw], {});
            artDonors.unshift(donorRaw);
          }
        }
        clientExe = (manifest.kind === "pc" && clientExe) || donorExe || clientExe;
        if (!clientExe) {
          throw new Error(
            `${BRAND_GAME_UPDATE.clientExeHint} non trovato dopo l'installazione. Installa il client ufficiale ${BRAND_GAME_UPDATE.clientLabel}, poi riprova.`
          );
        }
        embeddedStaged = await runStagingExtract(
          clientExe,
          "Re-estrazione dopo aggiornamento client ufficiale…"
        );
      }
      if (!embeddedStaged || !gameWebIsComplete(stagingOut)) {
        throw new Error(
          `Estrazione incompleta dopo installazione (embed=${embeddedStaged || "missing"}, ufficiale=${remote}). Aggiorna il client ${BRAND_GAME_UPDATE.clientLabel} sul Desktop e riprova.`
        );
      }
    }

    setUpdateStatus({
      phase: "publish",
      percent: 96,
      message: "Pubblicazione cache di gioco…",
    });
    const embeddedAfter = await publishUserWebRoot(stagingOut, finalOut);
    writeInstalledVersion(remote);
    fs.rmSync(rawOut, { recursive: true, force: true });
    fs.rmSync(stagingOut, { recursive: true, force: true });

    setUpdateStatus({
      running: false,
      phase: "done",
      percent: 100,
      message: `Aggiornato a ${remote} (embed ${embeddedAfter})`,
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
    const fileName = path.basename(new URL(exeUrl).pathname) || `RedUniverse-Bastion-${remote}.exe`;
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
    const manifest = normalizeGameManifest(await httpsGetJson(UPDATE_MANIFEST_URL));
    const remote = String(manifest.version || "").trim();
    const installed = readInstalledVersion();
    if (!remote || (installed && compareVersion(installed, remote) >= 0 && gameClientMatchesRemote(remote))) {
      return;
    }
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const launcher =
      manifest.launcher && manifest.launcher.version
        ? `\nLauncher ufficiale: ${manifest.launcher.version}`
        : "";
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: "info",
      buttons: ["Aggiorna ora", "Più tardi"],
      defaultId: 0,
      cancelId: 1,
      title: "Aggiornamento gioco",
      message: "Aggiornamento gioco disponibile",
      detail:
        `Installata: ${installed || "sconosciuta"}\nUfficiale: ${remote}${launcher}\n\n` +
        "Verranno aggiornati solo gli asset ufficiali. Autopilot/licenza Bastion restano intatti.\n" +
        "Fonte: updates.redgalaxygame.space/pc (stesso canale del launcher ufficiale).",
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

  console.log(`${WINDOW_TITLE} is serving ${activeWebRoot}`);
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

// Portable unpack dir is shared across launches — refuse a second instance so two
// extractors cannot clobber %LOCALAPPDATA%\<unpackDirName>.
const gotBastionLock = app.requestSingleInstanceLock();
if (!gotBastionLock) {
  // app.exit — not app.quit — so a mistaken second spawn cannot sit around forever
  // while the game updater waits on RedGalaxy-Bastion.exe.
  app.exit(0);
} else {
  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(start).catch((err) => {
    console.error(err);
    app.quit();
  });
}

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

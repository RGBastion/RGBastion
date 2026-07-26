#!/usr/bin/env node
"use strict";

/**
 * Extract RedGalaxy web assets from redgalaxy-client.exe.
 * Node port of extract_redgalaxy_web.py — uses built-in zlib brotli (no Python).
 *
 * Usage: node extract_redgalaxy_web.js /path/to/redgalaxy-client.exe /output/dir
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { spawnSync } = require("child_process");
const os = require("os");

const TEXT_EXTS = new Set([".html", ".js", ".css", ".json", ".svg", ".atlas", ".txt"]);
const KNOWN_PATH_EXTS = [
  ".json", ".html", ".css", ".js", ".png", ".svg", ".webp", ".jpg", ".jpeg",
  ".woff2", ".woff", ".ogg", ".wav", ".atlas",
];

const PATH_RE = /(?:\/)?(?:assets|ui|lang|ships|box|drones|equip|extras|maps|missiles|ore|portals|ranks|corps|base|audio|shop|icons|turrets|resources|textures|sprites)[A-Za-z0-9_./@+\-]*\.(?:json|html|css|js|png|svg|webp|jpg|jpeg|woff2?|ogg|wav|atlas)|\/index\.html|redgalaxy\.png/g;
const REF_RE = /(?:\/)?(?:assets|ui|lang|ships|box|drones|equip|extras|maps|missiles|ore|portals|ranks|corps|base|audio|shop|icons|turrets|resources|textures|sprites)[A-Za-z0-9_./@+\-]*\.(?:json|html|css|js|png|svg|webp|jpg|jpeg|woff2?|ogg|wav|atlas)|\/index\.html|redgalaxy\.png/g;

function normalizePath(raw) {
  let p = String(raw || "").trim().replace(/^['"()]+|['"()]+$/g, "");
  while (p.startsWith("./")) p = p.slice(2);
  p = p.replace(/^\/+/, "").replace(/\\/g, "/");
  const parts = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length) parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

function isSaneRelPath(rel) {
  // Reject fused binary matches like froston1.atlasships/alien/...
  // Longer extensions must win: `.js` inside `.json` / `.woff` inside `.woff2`
  // are NOT fusion (dropping them caused black WKWebView boot).
  if (!rel || rel.includes("..") || rel.length > 220) return false;
  const lower = rel.toLowerCase();
  const matchedExt = [...KNOWN_PATH_EXTS].sort((a, b) => b.length - a.length).find((ext) => lower.endsWith(ext));
  if (!matchedExt) return false;
  const trimmed = lower.slice(0, lower.length - matchedExt.length);
  for (const part of trimmed.split("/")) {
    if (!part) continue;
    for (const ext of KNOWN_PATH_EXTS) {
      const idx = part.indexOf(ext);
      if (idx >= 0 && idx + ext.length <= part.length) {
        if (idx + ext.length < part.length || idx > 0) return false;
      }
    }
  }
  return true;
}

function expandPathCandidates(raw) {
  const rel = normalizePath(raw);
  if (!rel) return new Set();
  const candidates = new Set([rel]);
  for (const ext of KNOWN_PATH_EXTS) {
    let start = 0;
    while (true) {
      const found = rel.indexOf(ext, start);
      if (found < 0) break;
      const rest = rel.slice(found);
      // Skip shorter ext prefixes of a longer real extension (.js in .json, .woff in .woff2).
      if (KNOWN_PATH_EXTS.some((other) => other !== ext && other.startsWith(ext) && rest.startsWith(other))) {
        start = found + 1;
        continue;
      }
      const candidate = rel.slice(0, found + ext.length);
      if (candidate) candidates.add(candidate);
      start = found + 1;
    }
  }
  return new Set(
    [...candidates].filter((c) => !c.endsWith("..") && !c.endsWith(".") && isSaneRelPath(c))
  );
}

function writeFile(outDir, rel, payload) {
  rel = normalizePath(rel);
  if (!rel) return false;
  const target = path.join(outDir, ...rel.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    try {
      if (Buffer.compare(fs.readFileSync(target), payload) === 0) return false;
    } catch { /* rewrite */ }
  }
  fs.writeFileSync(target, payload);
  return true;
}

function extractPng(data, start) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (data.compare(sig, 0, 8, start, start + 8) !== 0) return null;
  const end = data.indexOf(Buffer.from("IEND\xaeB`\x82", "binary"), start);
  if (end < 0) return null;
  return data.subarray(start, end + 8);
}

function extractJpeg(data, start) {
  if (data[start] !== 0xff || data[start + 1] !== 0xd8 || data[start + 2] !== 0xff) return null;
  const end = data.indexOf(Buffer.from([0xff, 0xd9]), start + 3);
  if (end < 0) return null;
  return data.subarray(start, end + 2);
}

function extractRiff(data, start) {
  if (data.compare(Buffer.from("RIFF"), 0, 4, start, start + 4) !== 0 || start + 8 > data.length) return null;
  const size = data.readUInt32LE(start + 4) + 8;
  if (size <= 12 || start + size > data.length) return null;
  return data.subarray(start, start + size);
}

function extractWoff(data, start) {
  if (data.compare(Buffer.from("wOFF"), 0, 4, start, start + 4) === 0 && start + 8 <= data.length) {
    const size = data.readUInt32BE(start + 4);
    if (size >= 20 && size <= 20_000_000 && start + size <= data.length) {
      return data.subarray(start, start + size);
    }
  }
  if (data.compare(Buffer.from("wOF2"), 0, 4, start, start + 4) === 0 && start + 12 <= data.length) {
    const size = data.readUInt32BE(start + 8);
    if (size >= 20 && size <= 20_000_000 && start + size <= data.length) {
      return data.subarray(start, start + size);
    }
  }
  return null;
}

function extractSvg(data, start) {
  if (data.compare(Buffer.from("<svg"), 0, 4, start, start + 4) !== 0) return null;
  const end = data.indexOf(Buffer.from("</svg>"), start);
  if (end < 0) return null;
  return data.subarray(start, end + 6);
}

function extractJsonText(data, start) {
  const c = data[start];
  if (c !== 0x7b && c !== 0x5b) return null; // { or [
  const chunk = data.subarray(start, Math.min(data.length, start + 8_000_000));
  const text = chunk.toString("utf8");
  const trimmed = text.trimStart();
  const leading = text.length - trimmed.length;
  try {
    // Use JSON.parse on progressive prefixes is hard; try raw_decode via incremental
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{" || ch === "[") depth += 1;
      else if (ch === "}" || ch === "]") {
        depth -= 1;
        if (depth === 0) {
          const slice = trimmed.slice(0, i + 1);
          JSON.parse(slice);
          return Buffer.from(JSON.stringify(JSON.parse(slice)), "utf8");
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

function extractTextUntilMarker(data, start, ext) {
  if (ext === ".json") return extractJsonText(data, start);
  if (ext === ".atlas") {
    const end = data.indexOf(0, start);
    if (end > start) {
      const payload = data.subarray(start, end);
      if (payload.subarray(0, Math.min(2048, payload.length)).includes(0x0a) && payload.length < 2_000_000) {
        return payload;
      }
    }
  }
  return null;
}

function extractOgg(data, start) {
  if (data.compare(Buffer.from("OggS"), 0, 4, start, start + 4) !== 0) return null;
  let pos = start;
  while (pos + 27 <= data.length && data.compare(Buffer.from("OggS"), 0, 4, pos, pos + 4) === 0) {
    const headerType = data[pos + 5];
    const segments = data[pos + 26];
    const segTableStart = pos + 27;
    const segTableEnd = segTableStart + segments;
    if (segTableEnd > data.length) return null;
    let pageSize = 27 + segments;
    for (let i = segTableStart; i < segTableEnd; i++) pageSize += data[i];
    if (pageSize <= 27 || pos + pageSize > data.length) return null;
    pos += pageSize;
    if (headerType & 0x04) return data.subarray(start, pos);
  }
  return pos > start ? data.subarray(start, pos) : null;
}

function acceptBrotliOutput(out, ext) {
  if (!out || out.length < 8) return null;
  if (ext === ".ogg") {
    const decoded = extractOgg(out, 0);
    if (decoded) return decoded;
  }
  if (ext === ".wav") {
    const decoded = extractRiff(out, 0);
    if (decoded) return decoded;
  }
  if (ext === ".json") return extractJsonText(out, 0);
  const head = out.subarray(0, Math.min(4096, out.length));
  const markers = [
    Buffer.from("<!doctype html"),
    Buffer.from("import"),
    Buffer.from("const "),
    Buffer.from("function"),
    Buffer.from("@font-face"),
    Buffer.from(":root"),
    Buffer.from("{"),
    Buffer.from("<svg"),
    Buffer.from("OggS"),
    Buffer.from("RIFF"),
  ];
  if (markers.some((m) => head.includes(m))) return out;
  return null;
}

function brotliDecompressLoose(chunk) {
  const trySync = (buf) => {
    try {
      return zlib.brotliDecompressSync(buf);
    } catch {
      return null;
    }
  };

  let out = trySync(chunk);
  if (out) return out;

  const sizes = [
    chunk.length,
    Math.min(chunk.length, 8_000_000),
    Math.min(chunk.length, 2_000_000),
    Math.min(chunk.length, 512_000),
  ];
  for (const size of [...new Set(sizes)]) {
    out = trySync(chunk.subarray(0, size));
    if (out) return out;
  }

  // Binary search longest prefix that decompresses (handles trailing junk).
  let lo = 16;
  let hi = chunk.length;
  let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    out = trySync(chunk.subarray(0, mid));
    if (out) {
      best = out;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function brotliDecompressSlice(data, start, brotliBin, ext) {
  const chunk = data.subarray(start, Math.min(data.length, start + 30_000_000));
  if (!chunk.length) return null;

  if (brotliBin) {
    const tmp = path.join(os.tmpdir(), `rg-brotli-${process.pid}-${Date.now()}.bin`);
    try {
      fs.writeFileSync(tmp, chunk);
      const proc = spawnSync(brotliBin, ["-d", "-c", tmp], {
        encoding: null,
        maxBuffer: 64 * 1024 * 1024,
        timeout: 30000,
      });
      if (proc.stdout && proc.stdout.length) {
        const accepted = acceptBrotliOutput(proc.stdout, ext);
        if (accepted) return accepted;
      }
    } catch {
      /* ignore */
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }

  const out = brotliDecompressLoose(chunk);
  if (!out) return null;
  return acceptBrotliOutput(out, ext);
}

function resolveBrotliBin() {
  const env = (process.env.BROTLI || "").trim();
  const candidates = [];
  if (env) candidates.push(env);
  const whichCmd = process.platform === "win32" ? "where" : "which";
  try {
    const w = spawnSync(whichCmd, ["brotli"], { encoding: "utf8" });
    if (w.status === 0 && w.stdout) {
      for (const line of w.stdout.split(/\r?\n/)) {
        if (line.trim()) candidates.push(line.trim());
      }
    }
  } catch { /* ignore */ }
  candidates.push("/opt/homebrew/bin/brotli", "/usr/local/bin/brotli");
  const scriptDir = __dirname;
  candidates.push(
    path.join(scriptDir, "brotli", "bin", "brotli"),
    path.join(scriptDir, "bin", "brotli"),
    path.join(scriptDir, "brotli.exe"),
  );
  const seen = new Set();
  for (const p of candidates) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    try {
      if (!fs.existsSync(p)) continue;
      const enc = spawnSync(p, ["-c"], { input: Buffer.from("rg"), encoding: null, timeout: 5000 });
      if (!enc.stdout || !enc.stdout.length) continue;
      const dec = spawnSync(p, ["-d", "-c"], { input: enc.stdout, encoding: null, timeout: 5000 });
      if (dec.stdout && dec.stdout.toString() === "rg") return p;
    } catch {
      continue;
    }
  }
  return null;
}

function mergeLocaleWithFallback(outDir, locale, fallback = "en") {
  const localeDir = path.join(outDir, "lang");
  const localeFile = path.join(localeDir, `${locale}.json`);
  const fallbackFile = path.join(localeDir, `${fallback}.json`);
  if (!fs.existsSync(localeFile) || !fs.existsSync(fallbackFile)) return;
  try {
    const fallbackObj = JSON.parse(fs.readFileSync(fallbackFile, "utf8"));
    let localeObj = JSON.parse(fs.readFileSync(localeFile, "utf8"));
    if (typeof fallbackObj !== "object" || !fallbackObj) return;
    if (typeof localeObj !== "object" || !localeObj) localeObj = {};
    const merged = { ...fallbackObj, ...localeObj };
    fs.writeFileSync(localeFile, JSON.stringify(merged, null, 2) + "\n", "utf8");
  } catch {
    /* ignore */
  }
}

function loadItalianOverrides() {
  const candidates = [
    path.join(__dirname, "italian_ui_overrides.json"),
    path.join(process.resourcesPath || "", "italian_ui_overrides.json"),
  ];
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch { /* ignore */ }
  }
  return {};
}

function applyItalianUiOverrides(outDir) {
  const localeFile = path.join(outDir, "lang", "it.json");
  if (!fs.existsSync(localeFile)) return;
  try {
    const data = JSON.parse(fs.readFileSync(localeFile, "utf8"));
    if (typeof data !== "object" || !data) return;
    Object.assign(data, loadItalianOverrides());
    fs.writeFileSync(localeFile, JSON.stringify(data, null, 2) + "\n", "utf8");
  } catch {
    /* ignore */
  }
}

function isValidJson(p) {
  try {
    JSON.parse(fs.readFileSync(p, "utf8"));
    return true;
  } catch {
    return false;
  }
}

function isValidWebp(p) {
  try {
    const head = fs.readFileSync(p).subarray(0, 16);
    return head.compare(Buffer.from("RIFF"), 0, 4, 0, 4) === 0 && head.includes(Buffer.from("WEBP"));
  } catch {
    return false;
  }
}

function copyAssetAlias(outDir, source, target) {
  const sourcePath = path.join(outDir, ...source.split("/"));
  const targetPath = path.join(outDir, ...target.split("/"));
  if (!fs.existsSync(sourcePath)) return false;
  const ext = path.extname(targetPath).toLowerCase();
  if (fs.existsSync(targetPath)) {
    if (ext === ".json" && isValidJson(targetPath)) return false;
    if (ext === ".webp" && isValidWebp(targetPath)) return false;
    if (ext !== ".json" && ext !== ".webp") return false;
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
  return true;
}

function ensureRuntimeAssetAliases(outDir) {
  const aliases = {
    "ships/alien/alien21.json": "ships/alien/alien20.json",
    "ships/alien/alien31.json": "ships/alien/alien30.json",
    "ships/alien/alien41.json": "ships/alien/alien40.json",
    "ships/alien/noxon1.json": "ships/alien/noxon.json",
    "ships/alien/raidon1.json": "ships/alien/raidon.json",
    "ships/alien/talon1.json": "ships/alien/talon.json",
    "ships/alien/voxion1.json": "ships/alien/voxion.json",
    "ships/alien/froston1.json": "ships/alien/froston.json",
    "ships/alien/froston1.webp": "ships/alien/froston.webp",
  };
  for (const [target, source] of Object.entries(aliases)) {
    copyAssetAlias(outDir, source, target);
  }
}

function extractPayload(data, filePath, offset, brotliBin) {
  const rawPath = Buffer.from(filePath);
  const start = offset + rawPath.length;
  const ext = path.extname(filePath).toLowerCase();

  for (let delta = 0; delta < 9; delta++) {
    const probe = start + delta;
    for (const extractor of [extractPng, extractJpeg, extractRiff, extractWoff, extractSvg, extractOgg]) {
      const payload = extractor(data, probe);
      if (payload) return payload;
    }
  }

  const textPayload = extractTextUntilMarker(data, start, ext);
  if (textPayload) return textPayload;

  return brotliDecompressSlice(data, start, brotliBin, ext);
}

function discoverPathsFromBinary(data) {
  const found = new Set(["/index.html"]);
  const text = data.toString("latin1");
  let m;
  PATH_RE.lastIndex = 0;
  while ((m = PATH_RE.exec(text)) !== null) {
    for (const rel of expandPathCandidates(m[0])) {
      if (rel.length < 220 && !rel.includes("..")) found.add("/" + rel);
    }
  }
  return found;
}

function discoverPathsFromOutput(outDir) {
  const found = new Set();
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
        continue;
      }
      if (!TEXT_EXTS.has(path.extname(ent.name).toLowerCase())) continue;
      let text;
      try {
        text = fs.readFileSync(full, "utf8");
      } catch {
        continue;
      }
      let m;
      REF_RE.lastIndex = 0;
      while ((m = REF_RE.exec(text)) !== null) {
        for (const rel of expandPathCandidates(m[0])) {
          if (rel) found.add("/" + rel);
        }
      }
    }
  };
  walk(outDir);
  return found;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    console.error("usage: extract_redgalaxy_web.js /path/to/redgalaxy-client.exe /output/dir");
    return 2;
  }

  const exe = path.resolve(args[0]);
  const outDir = path.resolve(args[1]);
  if (!fs.existsSync(exe)) {
    console.error(`Client exe not found: ${exe}`);
    return 2;
  }

  const brotliBin = resolveBrotliBin();
  // Node always has zlib brotli — no hard dependency on CLI/Python.
  const data = fs.readFileSync(exe);
  fs.mkdirSync(outDir, { recursive: true });

  let pending = discoverPathsFromBinary(data);
  const extracted = new Set();
  const failed = new Set();

  for (let round = 0; round < 4; round++) {
    let progress = false;
    for (const pth of [...pending].sort()) {
      const rel = normalizePath(pth);
      if (!rel || extracted.has(rel) || failed.has(rel)) continue;
      const offsets = [];
      const searchPaths = [pth];
      if (pth.startsWith("/")) searchPaths.push(pth.slice(1));
      else searchPaths.push("/" + pth);
      for (const searchPath of [...new Set(searchPaths)]) {
        const raw = Buffer.from(searchPath);
        let start = 0;
        while (true) {
          const off = data.indexOf(raw, start);
          if (off < 0) break;
          offsets.push([searchPath, off]);
          start = off + 1;
        }
      }
      if (!offsets.length) {
        failed.add(rel);
        continue;
      }
      let payload = null;
      for (const [searchPath, off] of offsets.slice(0, 20)) {
        payload = extractPayload(data, searchPath, off, brotliBin);
        if (payload) break;
      }
      if (payload) {
        writeFile(outDir, rel, payload);
        extracted.add(rel);
        progress = true;
      } else {
        failed.add(rel);
      }
    }
    const newRefs = discoverPathsFromOutput(outDir);
    const before = pending.size;
    for (const r of newRefs) pending.add(r);
    progress = progress || pending.size > before;
    if (!progress) break;
  }

  mergeLocaleWithFallback(outDir, "it");
  mergeLocaleWithFallback(outDir, "quest.it", "quest.en");
  applyItalianUiOverrides(outDir);
  ensureRuntimeAssetAliases(outDir);

  console.log(`extracted=${extracted.size} failed=${failed.size} output=${outDir}`);
  if (failed.size) {
    console.log("failed_sample:");
    for (const item of [...failed].sort().slice(0, 80)) console.log(`  ${item}`);
  }
  return 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { main };

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
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const os = require("os");

const TEXT_EXTS = new Set([".html", ".js", ".css", ".json", ".svg", ".atlas", ".txt"]);
const KNOWN_PATH_EXTS = [
  ".json", ".html", ".css", ".js", ".png", ".svg", ".webp", ".jpg", ".jpeg",
  ".woff2", ".woff", ".ogg", ".wav", ".atlas",
];

// Allow spaces: RedUniverse 1.0.12 embeds some blobs as "ship100 - Copy.webp"
// (Windows duplicate filenames) while the runtime still requests ship100.webp.
const PATH_RE = /(?:\/)?(?:assets|ui|lang|ships|box|drones|equip|extras|maps|missiles|ore|portals|ranks|corps|base|audio|shop|icons|turrets|resources|textures|sprites)[A-Za-z0-9_./@+\- ]*\.(?:json|html|css|js|png|svg|webp|jpg|jpeg|woff2?|ogg|wav|atlas)|\/index\.html|redgalaxy\.png/g;
const REF_RE = /(?:\/)?(?:assets|ui|lang|ships|box|drones|equip|extras|maps|missiles|ore|portals|ranks|corps|base|audio|shop|icons|turrets|resources|textures|sprites)[A-Za-z0-9_./@+\- ]*\.(?:json|html|css|js|png|svg|webp|jpg|jpeg|woff2?|ogg|wav|atlas)|\/index\.html|redgalaxy\.png/g;

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

/** Strip Windows duplicate suffixes: " - Copy" / " - Kopya" / " - Copia". */
function canonicalAssetRel(rel) {
  const norm = normalizePath(rel);
  if (!norm) return "";
  return norm.replace(/ - (?:Copy|Kopya|Copia)(\.[A-Za-z0-9]+)$/i, "$1");
}

/** Runtime path plus optional localized " - Copy" twins used in RedUniverse packing. */
function pathSearchVariants(relOrPath) {
  const raw = String(relOrPath || "");
  const withSlash = raw.startsWith("/") ? raw : `/${raw}`;
  const noSlash = withSlash.slice(1);
  const canon = canonicalAssetRel(noSlash);
  const out = new Set();
  const suffixes = [" - Copy", " - Kopya", " - Copia"];
  const variants = [noSlash, canon];
  if (canon) {
    for (const suf of suffixes) {
      variants.push(canon.replace(/(\.[A-Za-z0-9]+)$/, `${suf}$1`));
    }
  }
  for (const r of variants) {
    if (!r) continue;
    out.add(r);
    out.add("/" + r);
  }
  return [...out];
}

/**
 * RedUniverse Tauri embeds large binaries with 4-byte splice markers
 * (`\xfc\xff\x9f\x08`) every 0x140000 payload bytes. Naive RIFF/PNG slices keep
 * the junk → noise textures. Desplice only when that marker is present.
 *
 * Clean RedGalaxy streams have no markers — copy verbatim. Never skip bytes
 * unconditionally (the old `i += 3` fallback corrupted large RG WebP/PNG).
 */
const EMBED_SPLICE_PERIOD = 0x140000;
const EMBED_SPLICE_MARKER = Buffer.from([0xfc, 0xff, 0x9f, 0x08]);

function despliceEmbeddedPayload(raw, targetLen) {
  if (!raw || !raw.length) return null;
  const limit = targetLen == null ? raw.length : targetLen;
  // No RU splice markers anywhere → clean embed; never invent skips.
  if (!raw.includes(EMBED_SPLICE_MARKER)) {
    if (targetLen == null) return Buffer.from(raw);
    if (raw.length < targetLen) return Buffer.from(raw);
    return Buffer.from(raw.subarray(0, targetLen));
  }
  const out = Buffer.allocUnsafe(Math.min(limit, raw.length));
  let i = 0;
  let produced = 0;
  while (i < raw.length && produced < limit) {
    const room = EMBED_SPLICE_PERIOD - (produced % EMBED_SPLICE_PERIOD);
    const take = Math.min(room, raw.length - i, limit - produced);
    if (take <= 0) break;
    raw.copy(out, produced, i, i + take);
    i += take;
    produced += take;
    if (produced > 0 && produced % EMBED_SPLICE_PERIOD === 0 && i < raw.length && produced < limit) {
      // Only skip a proven RU marker; never unconditional i += 3.
      if (
        i + 4 <= raw.length &&
        raw[i] === 0xfc &&
        raw[i + 1] === 0xff &&
        raw[i + 2] === 0x9f &&
        raw[i + 3] === 0x08
      ) {
        i += 4;
      }
    }
  }
  if (!produced) return null;
  return out.subarray(0, produced);
}

function isValidPngBuffer(buf) {
  if (!buf || buf.length < 24) return false;
  if (buf.compare(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 0, 8, 0, 8) !== 0) {
    return false;
  }
  let i = 8;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const typ = buf.toString("latin1", i + 4, i + 8);
    if (len > 16_000_000 || i + 8 + len + 4 > buf.length) return false;
    if (!/^[A-Za-z]+$/.test(typ)) return false;
    i += 8 + len + 4;
    if (typ === "IEND") return i === buf.length || i <= buf.length;
  }
  return false;
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
  const canon = canonicalAssetRel(rel);
  if (canon) candidates.add(canon);
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
      if (candidate) {
        candidates.add(candidate);
        const cCanon = canonicalAssetRel(candidate);
        if (cCanon) candidates.add(cCanon);
      }
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
  // Read past possible splice markers, desplice, then cut at IEND.
  const rawEnd = Math.min(data.length, start + 20_000_000);
  const raw = data.subarray(start, rawEnd);
  const maxIns = Math.floor(raw.length / EMBED_SPLICE_PERIOD) + 2;
  const slop = Math.min(data.length, start + raw.length + maxIns * 4);
  const spliced = data.subarray(start, slop);
  let fixed = despliceEmbeddedPayload(spliced, null);
  if (!fixed) fixed = Buffer.from(spliced);
  const end = fixed.indexOf(Buffer.from("IEND\xaeB`\x82", "binary"));
  if (end < 0) return null;
  const png = fixed.subarray(0, end + 8);
  return isValidPngBuffer(png) ? png : null;
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
  if (size <= 12) return null;
  // Declared RIFF size is the *clean* length; splices sit inside the byte span.
  const maxIns = Math.floor(size / EMBED_SPLICE_PERIOD) + 1;
  const slopEnd = Math.min(data.length, start + size + maxIns * 4 + 8);
  if (slopEnd <= start + 12) return null;
  const spliced = data.subarray(start, slopEnd);
  let fixed = despliceEmbeddedPayload(spliced, size);
  if (!fixed || fixed.length < 12) {
    if (start + size > data.length) return null;
    fixed = Buffer.from(data.subarray(start, start + size));
  }
  if (fixed.length >= 8) {
    fixed = Buffer.from(fixed);
    fixed.writeUInt32LE(fixed.length - 8, 4);
  }
  if (fixed.compare(Buffer.from("RIFF"), 0, 4, 0, 4) !== 0) return null;
  if (fixed.length >= 12 && fixed.compare(Buffer.from("WEBP"), 0, 4, 8, 12) !== 0) {
    // WAV (WAVE) also uses RIFF — accept either.
    if (fixed.compare(Buffer.from("WAVE"), 0, 4, 8, 12) !== 0) return null;
  }
  return fixed;
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

function looksLikeAtlasText(buf) {
  if (!buf || buf.length < 24 || buf.length >= 2_000_000) return false;
  // Reject binary / fused path-table garbage (e.g. "/shop/...png" + PNG bytes).
  const probeLen = Math.min(512, buf.length);
  let nul = 0;
  for (let i = 0; i < probeLen; i++) {
    const b = buf[i];
    if (b === 0) nul += 1;
    else if (b < 0x09 || (b > 0x0d && b < 0x20)) return false;
  }
  if (nul > 0) return false;
  const head = buf.subarray(0, Math.min(4096, buf.length)).toString("utf8");
  return (
    /\nsize:\s*\d/.test(head) ||
    /\nformat:\s*/i.test(head) ||
    /\nrepeat:\s*/i.test(head) ||
    /\n\s*rotate:\s*/i.test(head) ||
    /\nfilter:\s*/i.test(head)
  );
}

function extractTextUntilMarker(data, start, ext) {
  if (ext === ".json") return extractJsonText(data, start);
  if (ext === ".atlas") {
    const end = data.indexOf(0, start);
    if (end > start) {
      const payload = data.subarray(start, end);
      if (looksLikeAtlasText(payload)) return payload;
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
  // Spine/libGDX atlas text has no `{` / JS markers — previously rejected → black world (no ships).
  if (ext === ".atlas") return looksLikeAtlasText(out) ? out : null;
  // Image magics (maps/bg.jpg and friends are often brotli-wrapped in newer clients).
  if ((ext === ".jpg" || ext === ".jpeg") && out[0] === 0xff && out[1] === 0xd8 && out[2] === 0xff) {
    return out;
  }
  if (ext === ".png" && out[0] === 0x89 && out[1] === 0x50 && out[2] === 0x4e && out[3] === 0x47) {
    return out;
  }
  if ((ext === ".webp" || ext === ".wav") && out.compare(Buffer.from("RIFF"), 0, 4, 0, 4) === 0) {
    return out;
  }
  if ((ext === ".woff" || ext === ".woff2") && (out.compare(Buffer.from("wOFF"), 0, 4, 0, 4) === 0 || out.compare(Buffer.from("wOF2"), 0, 4, 0, 4) === 0)) {
    return out;
  }
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
    Buffer.from("wOFF"),
    Buffer.from("wOF2"),
  ];
  if (markers.some((m) => head.includes(m))) return out;
  return null;
}

function brotliDecompressLoose(chunk) {
  // Match extract_redgalaxy_web.py: a few progressive sizes only.
  // Do NOT binary-search up to 30MB — that made Windows Bastion extract appear
  // frozen at the 91% heartbeat for minutes until the 300s child timeout.
  const trySync = (buf) => {
    try {
      return zlib.brotliDecompressSync(buf);
    } catch {
      return null;
    }
  };

  const sizes = [
    chunk.length,
    Math.min(chunk.length, 8_000_000),
    Math.min(chunk.length, 2_000_000),
    Math.min(chunk.length, 512_000),
  ];
  for (const size of [...new Set(sizes)]) {
    const out = trySync(chunk.subarray(0, size));
    if (out) return out;
  }
  return null;
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
    const buf = fs.readFileSync(p);
    if (buf.length < 16) return false;
    if (buf.compare(Buffer.from("RIFF"), 0, 4, 0, 4) !== 0 || !buf.subarray(0, 16).includes(Buffer.from("WEBP"))) {
      return false;
    }
    const declared = buf.readUInt32LE(4) + 8;
    return Math.abs(declared - buf.length) <= 16;
  } catch {
    return false;
  }
}

function isValidPng(p) {
  try {
    return isValidPngBuffer(fs.readFileSync(p));
  } catch {
    return false;
  }
}

function rewriteAtlasPageName(atlasText, newPage) {
  const lines = String(atlasText || "").split(/\r?\n/);
  let rewritten = false;
  const out = lines.map((line, idx) => {
    if (rewritten) return line;
    if (!line || line.startsWith(" ") || line.includes(":")) return line;
    // First bare page filename line.
    if (idx === 0 || lines.slice(0, idx).every((l) => !l.trim())) {
      rewritten = true;
      return newPage;
    }
    if (/\.(webp|png)$/i.test(line.trim())) {
      rewritten = true;
      return newPage;
    }
    return line;
  });
  // If no page line found, prepend.
  if (!rewritten) out.unshift(newPage);
  return out.join("\n");
}

/** First bare page filename in a libGDX/Spine atlas. */
function atlasPageFileName(atlasText) {
  for (const line of String(atlasText || "").split(/\r?\n/)) {
    if (!line || line.startsWith(" ") || line.includes(":")) continue;
    return line.trim();
  }
  return "";
}

/** True when atlas page points at a missing/fused path (e.g. p1→sreaper.webp). */
function atlasPageIsBroken(atlasPath) {
  try {
    const text = fs.readFileSync(atlasPath, "utf8");
    if (!looksLikeAtlasText(Buffer.from(text))) return true;
    const page = atlasPageFileName(text);
    if (!page || page.includes("/") || (page.match(/\./g) || []).length > 1) return true;
    const dir = path.dirname(atlasPath);
    return !fs.existsSync(path.join(dir, page));
  } catch {
    return true;
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
    if (ext === ".png" && isValidPng(targetPath)) return false;
    if (ext === ".atlas") {
      // Overwrite garbage/mismatched atlas pages (froston1←imperon fused, etc.).
      if (!atlasPageIsBroken(targetPath)) return false;
    } else if (ext !== ".json" && ext !== ".webp" && ext !== ".png") {
      return false;
    }
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  if (ext === ".atlas") {
    try {
      const text = fs.readFileSync(sourcePath, "utf8");
      const wantWebp = path.basename(targetPath, ".atlas") + ".webp";
      const wantPng = path.basename(targetPath, ".atlas") + ".png";
      const pageName = fs.existsSync(path.join(path.dirname(targetPath), wantWebp))
        ? wantWebp
        : wantPng;
      let body = rewriteAtlasPageName(text, pageName);
      if (!body.endsWith("\n")) body += "\n";
      fs.writeFileSync(targetPath, body, "utf8");
      return true;
    } catch {
      return false;
    }
  }
  fs.copyFileSync(sourcePath, targetPath);
  return true;
}

/** Rewrite atlas page lines to stem.webp/png when the declared page file is missing. */
function fixShipAtlasPageNames(outDir) {
  const roots = [
    path.join(outDir, "ships", "player"),
    path.join(outDir, "ships", "alien"),
    path.join(outDir, "ships", "system"),
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      if (!name.endsWith(".atlas")) continue;
      const atlasPath = path.join(root, name);
      const stem = name.slice(0, -".atlas".length);
      const wantWebp = `${stem}.webp`;
      const wantPng = `${stem}.png`;
      let pageName = null;
      if (fs.existsSync(path.join(root, wantWebp))) pageName = wantWebp;
      else if (fs.existsSync(path.join(root, wantPng))) pageName = wantPng;
      if (!pageName) continue;
      try {
        const text = fs.readFileSync(atlasPath, "utf8");
        if (!looksLikeAtlasText(Buffer.from(text))) continue;
        const page = atlasPageFileName(text);
        if (page === pageName && fs.existsSync(path.join(root, page))) continue;
        // Missing or wrong page (p1→sreaper.webp, p2→dsentinel.webp, fused froston1).
        if (page && fs.existsSync(path.join(root, path.basename(page))) && path.basename(page) === page) {
          // Page file exists under a different name — still retarget to stem so
          // runtime path ships/alien/p1.atlas loads ships/alien/p1.webp.
        }
        const body = rewriteAtlasPageName(text, pageName);
        fs.writeFileSync(atlasPath, body.endsWith("\n") ? body : body + "\n", "utf8");
      } catch {
        /* ignore */
      }
    }
  }
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
    // Variant atlas blobs are often path-table-only in the exe; reuse base atlas.
    "ships/alien/froston1.atlas": "ships/alien/froston.atlas",
    "ships/alien/alien21.atlas": "ships/alien/alien20.atlas",
    "ships/alien/alien31.atlas": "ships/alien/alien30.atlas",
    "ships/alien/alien41.atlas": "ships/alien/alien40.atlas",
    "ships/alien/noxon1.atlas": "ships/alien/noxon.atlas",
    "ships/alien/raidon1.atlas": "ships/alien/raidon.atlas",
    "ships/alien/talon1.atlas": "ships/alien/talon.atlas",
    "ships/alien/voxion1.atlas": "ships/alien/voxion.atlas",
    // Do NOT alias ship100.atlas → ship10.atlas: RedUniverse packs the real
    // Wraith sheet as "ship100 - Copy.atlas" (extracted to ship100.atlas).
    // Reverse: some clients only embed the *1 blob while atlas headers still name the base file.
    "ships/alien/froston.webp": "ships/alien/froston1.webp",
    "ships/alien/froston.json": "ships/alien/froston1.json",
    "ships/alien/raidon.webp": "ships/alien/raidon1.webp",
    "ships/alien/raidon.json": "ships/alien/raidon1.json",
    "ships/alien/voxion.webp": "ships/alien/voxion1.webp",
    "ships/alien/voxion.json": "ships/alien/voxion1.json",
    "ships/alien/alien20.json": "ships/alien/alien21.json",
    "ships/alien/alien30.json": "ships/alien/alien31.json",
    "ships/alien/noxon.json": "ships/alien/noxon1.json",
    "ships/alien/talon.json": "ships/alien/talon1.json",
    // Booty atlas page is typo'd "bootyy.webp" in RU 1.0.12; game also loads booty.webp.
    "box/bootyy.webp": "box/booty.webp",
    // RU packs Wraith config only under ship103; runtime still requests ship100.json.
    "ships/player/ship100.json": "ships/player/ship103.json",
    // PC 0.9.x PE embeds redgalaxy2.png; login/boot UI requests redgalaxy.png.
    "redgalaxy.png": "redgalaxy2.png",
    // Halloween event skins live in encrypted .rgpak; until packs decrypt, map to base hulls.
    "ships/player/ship85.webp": "ships/player/ship80.webp",
    "ships/player/ship85.json": "ships/player/ship80.json",
    "ships/player/ship85.atlas": "ships/player/ship80.atlas",
    "ships/player/ship95.webp": "ships/player/ship90.webp",
    "ships/player/ship95.json": "ships/player/ship90.json",
    "ships/player/ship95.atlas": "ships/player/ship90.atlas",
    "ships/player/ship105.webp": "ships/player/ship100.webp",
    "ships/player/ship105.json": "ships/player/ship100.json",
    "ships/player/ship105.atlas": "ships/player/ship100.atlas",
    "ships/player/ship125.webp": "ships/player/ship120.webp",
    "ships/player/ship125.json": "ships/player/ship120.json",
    "ships/player/ship125.atlas": "ships/player/ship120.atlas",
    "ships/player/ship85_glow.webp": "ships/player/ship80.webp",
    "ships/player/ship95_glow.webp": "ships/player/ship90.webp",
    "ships/player/ship105_glow.webp": "ships/player/ship100.webp",
    "ships/player/ship125_glow.webp": "ships/player/ship120.webp",
    // Shop / drone previews often sit only in shop-*.rgpak; mirror hangar art until packs decrypt.
    "shop/drones/anka.webp": "equip/drone/anka.webp",
    "shop/drones/atlas.webp": "equip/drone/atlas.webp",
    "shop/drones/pusat.webp": "equip/drone/pusat.webp",
    "shop/drones/tayfun.webp": "equip/drone/tayfun.webp",
    "shop/drones/preview/anka.webp": "equip/drone/anka.webp",
    "shop/drones/preview/atlas.webp": "equip/drone/atlas.webp",
    "shop/drones/preview/pusat.webp": "equip/drone/pusat.webp",
    "shop/drones/preview/tayfun.webp": "equip/drone/tayfun.webp",
    "shop/extras/preview/booty.webp": "box/booty.webp",
    "shop/extras/booty.webp": "box/booty.webp",
    "shop/extras/arc.webp": "equip/extras/arc.webp",
    "shop/extras/preview/arc.webp": "equip/extras/arc.webp",
    "shop/extras/rtc.webp": "equip/extras/rtc.webp",
    "shop/extras/preview/rtc.webp": "equip/extras/rtc.webp",
    "shop/extras/ccoc.webp": "equip/extras/ccoc.webp",
    "shop/extras/preview/ccoc.webp": "equip/extras/ccoc.webp",
    "shop/extras/cloak.webp": "equip/extras/cloak.webp",
    "shop/extras/preview/cloak.webp": "equip/extras/cloak.webp",
    "shop/extras/emp-m.webp": "equip/extras/emp-m.webp",
    "shop/extras/preview/emp-m.webp": "equip/extras/emp-m.webp",
    "shop/extras/snb-m.webp": "equip/extras/snb-m.webp",
    "shop/extras/preview/snb-m.webp": "equip/extras/snb-m.webp",
    "shop/extras/ws-m.webp": "equip/extras/ws-m.webp",
    "shop/extras/preview/ws-m.webp": "equip/extras/ws-m.webp",
    "shop/extras/repb1.webp": "equip/extras/repb1.webp",
    "shop/extras/preview/repb1.webp": "equip/extras/repb1.webp",
    "shop/extras/repb2.webp": "equip/extras/repb2.webp",
    "shop/extras/preview/repb2.webp": "equip/extras/repb2.webp",
    "shop/extras/repb3.webp": "equip/extras/repb3.webp",
    "shop/extras/preview/repb3.webp": "equip/extras/repb3.webp",
    "shop/extras/sl1.webp": "equip/extras/sl1.webp",
    "shop/extras/preview/sl1.webp": "equip/extras/sl1.webp",
    "shop/extras/sl2.webp": "equip/extras/sl2.webp",
    "shop/extras/preview/sl2.webp": "equip/extras/sl2.webp",
    "shop/extras/sl3.webp": "equip/extras/sl3.webp",
    "shop/extras/preview/sl3.webp": "equip/extras/sl3.webp",
    "drones/halloween.png": "equip/drone/anka.webp",
    "drones/halloween_glow.png": "equip/drone/anka.webp",
    // Hangar drone skin HALLOWEEN lives in encrypted packs; reuse crimson art.
    "equip/skins/halloween.webp": "equip/skins/crimson.webp",
    "shop/drones/preview/halloween.webp": "equip/skins/crimson.webp",
    "shop/drones/halloween.webp": "equip/skins/crimson.webp",
  };
  // Two passes so reverse aliases can fill bases after forward *1 copies.
  for (let pass = 0; pass < 2; pass++) {
    for (const [target, source] of Object.entries(aliases)) {
      copyAssetAlias(outDir, source, target);
    }
  }

  // Mirror hangar equip trees into shop/** when donor shop packs are absent.
  ensureShopArtFallbacks(outDir);

  // Synthesize missing ship atlases from a sibling sheet (shared frame layout).
  ensureMissingShipAtlases(outDir);
  // Retarget mismatched pages (p1.atlas→p1.webp, p2, froston1) after aliases.
  fixShipAtlasPageNames(outDir);
}

/**
 * PC 0.9.x keeps Negozio art in encrypted shop-*.rgpak. Until those decrypt,
 * copy any available hangar (equip/) / box / ship sheets into the shop URL
 * layout the JS client requests (`shop/extras/preview/…`, `shop/ammo/…`, …).
 */
function ensureShopArtFallbacks(outDir) {
  const mirrors = [
    ["equip/extras", "shop/extras"],
    ["equip/extras", "shop/extras/preview"],
    ["equip/ammo", "shop/ammo"],
    ["equip/ammo", "shop/ammo/preview"],
    ["equip/gen", "shop/gen"],
    ["equip/gen", "shop/gen/preview"],
    ["equip/launcher", "shop/launcher"],
    ["equip/launcher", "shop/launcher/preview"],
    ["equip/drone", "shop/drones"],
    ["equip/drone", "shop/drones/preview"],
    ["equip/laser", "shop/repeaters"],
    ["equip/laser", "shop/repeaters/preview"],
  ];
  for (const [srcRel, dstRel] of mirrors) {
    const srcDir = path.join(outDir, ...srcRel.split("/"));
    const dstDir = path.join(outDir, ...dstRel.split("/"));
    if (!fs.existsSync(srcDir)) continue;
    let names;
    try {
      names = fs.readdirSync(srcDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.includes(" 2.") || name.includes(" 3.")) continue;
      const lower = name.toLowerCase();
      if (!/\.(webp|png|jpg|jpeg)$/i.test(lower)) continue;
      const from = path.join(srcDir, name);
      let destName = name;
      // Laser hangar uses .png; shop repeaters prefer .webp of the same stem.
      if (srcRel === "equip/laser" && lower.endsWith(".png")) {
        destName = name.replace(/\.png$/i, ".webp");
      }
      const to = path.join(dstDir, destName);
      if (fs.existsSync(to)) continue;
      try {
        fs.mkdirSync(dstDir, { recursive: true });
        fs.copyFileSync(from, to);
      } catch {
        /* ignore */
      }
    }
  }
  // Ship shop cards: shop/ship/preview/shipNN.webp ← ships/player/shipNN.webp
  const playerDir = path.join(outDir, "ships", "player");
  const shopShip = path.join(outDir, "shop", "ship");
  const shopShipPreview = path.join(shopShip, "preview");
  if (fs.existsSync(playerDir)) {
    let names;
    try {
      names = fs.readdirSync(playerDir);
    } catch {
      names = [];
    }
    for (const name of names) {
      const m = /^ship(\d+)\.webp$/i.exec(name);
      if (!m) continue;
      const from = path.join(playerDir, name);
      for (const destDir of [shopShip, shopShipPreview]) {
        const to = path.join(destDir, name);
        if (fs.existsSync(to)) continue;
        try {
          fs.mkdirSync(destDir, { recursive: true });
          fs.copyFileSync(from, to);
        } catch {
          /* ignore */
        }
      }
    }
  }
  // Preview copies from non-preview shop files when only one side exists.
  const previewPairs = [
    "shop/extras",
    "shop/ammo",
    "shop/gen",
    "shop/launcher",
    "shop/drones",
    "shop/repeaters",
    "shop/ship",
  ];
  for (const rel of previewPairs) {
    const base = path.join(outDir, ...rel.split("/"));
    const preview = path.join(base, "preview");
    if (!fs.existsSync(base)) continue;
    let names;
    try {
      names = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of names) {
      if (!ent.isFile()) continue;
      if (!/\.(webp|png)$/i.test(ent.name)) continue;
      if (ent.name.includes(" 2.") || ent.name.includes(" 3.")) continue;
      const from = path.join(base, ent.name);
      const to = path.join(preview, ent.name);
      if (fs.existsSync(to)) continue;
      try {
        fs.mkdirSync(preview, { recursive: true });
        fs.copyFileSync(from, to);
      } catch {
        /* ignore */
      }
    }
  }
}

function ensureMissingShipAtlases(outDir) {
  const roots = [
    path.join(outDir, "ships", "player"),
    path.join(outDir, "ships", "alien"),
    path.join(outDir, "ships", "system"),
  ];
  let template = null;
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      if (!name.endsWith(".atlas")) continue;
      const full = path.join(root, name);
      try {
        const text = fs.readFileSync(full, "utf8");
        if (looksLikeAtlasText(Buffer.from(text))) {
          template = text;
          break;
        }
      } catch {
        /* ignore */
      }
    }
    if (template) break;
  }
  if (!template) return;

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      if (!name.endsWith(".webp") && !name.endsWith(".png")) continue;
      const stem = name.replace(/\.(webp|png)$/i, "");
      const atlasPath = path.join(root, `${stem}.atlas`);
      if (fs.existsSync(atlasPath)) continue;
      const page = name;
      const body = rewriteAtlasPageName(template, page);
      fs.writeFileSync(atlasPath, body.endsWith("\n") ? body : body + "\n", "utf8");
    }
  }
}

function extractPayload(data, filePath, offset, brotliBin) {
  const rawPath = Buffer.from(filePath);
  const start = offset + rawPath.length;
  const ext = path.extname(filePath).toLowerCase();

  // Only probe binary image/font/audio magics for matching extensions.
  // Otherwise path-table neighbors (e.g. ship20.json next to a WEBP) poison .json extracts.
  const binaryExtractors = [];
  if (ext === ".png") binaryExtractors.push(extractPng);
  if (ext === ".jpg" || ext === ".jpeg") binaryExtractors.push(extractJpeg);
  if (ext === ".webp" || ext === ".wav") binaryExtractors.push(extractRiff);
  if (ext === ".woff" || ext === ".woff2") binaryExtractors.push(extractWoff);
  if (ext === ".svg") binaryExtractors.push(extractSvg);
  if (ext === ".ogg") binaryExtractors.push(extractOgg);

  // RedUniverse " - Copy.webp" blobs often sit a few bytes after the path marker.
  for (let delta = 0; delta < 48; delta++) {
    const probe = start + delta;
    for (const extractor of binaryExtractors) {
      const payload = extractor(data, probe);
      if (payload) return payload;
    }
  }

  const textPayload = extractTextUntilMarker(data, start, ext);
  if (textPayload) return textPayload;

  return brotliDecompressSlice(data, start, brotliBin, ext);
}

function discoverPathsFromBinary(data) {
  // latin1 index === byte offset. Record match offsets here so main() does not
  // re-scan the whole exe with Buffer.indexOf for every path × variant (that
  // alone was ~50s+ on a 282MB client and made Windows updates look hung at 91%).
  const pending = new Set(["/index.html"]);
  const offsetIndex = new Map(); // canonicalRel -> [[exactSearchPath, byteOffset], ...]
  const pushOffset = (rel, searchPath, offset) => {
    const key = canonicalAssetRel(rel) || normalizePath(rel);
    if (!key || key.includes("..") || key.length > 220) return;
    pending.add("/" + key);
    let list = offsetIndex.get(key);
    if (!list) {
      list = [];
      offsetIndex.set(key, list);
    }
    list.push([searchPath, offset]);
  };

  const text = data.toString("latin1");
  let m;
  PATH_RE.lastIndex = 0;
  while ((m = PATH_RE.exec(text)) !== null) {
    const matched = m[0];
    const offset = m.index;
    for (const rel of expandPathCandidates(matched)) {
      // extractPayload needs the exact bytes at `offset`; keep `matched` as searchPath.
      pushOffset(rel, matched, offset);
    }
  }
  return { pending, offsetIndex };
}

/** Fallback indexOf only for refs discovered from extracted text (small set). */
function findPathOffsetsFallback(data, pth, cache) {
  const cacheKey = String(pth || "");
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const offsets = [];
  const noSlash = cacheKey.replace(/^\/+/, "");
  const primary = noSlash ? [noSlash, "/" + noSlash] : [];
  const tryVariants = (variants, maxHitsPer) => {
    for (const searchPath of variants) {
      if (!searchPath) continue;
      const raw = Buffer.from(searchPath);
      let start = 0;
      let hits = 0;
      while (hits < maxHitsPer) {
        const off = data.indexOf(raw, start);
        if (off < 0) break;
        offsets.push([searchPath, off]);
        start = off + 1;
        hits += 1;
      }
    }
  };
  tryVariants(primary, 8);
  // Localized " - Copy" twins only when the primary path is absent in the binary.
  if (!offsets.length) {
    tryVariants(
      pathSearchVariants(pth).filter((v) => !primary.includes(v)),
      4
    );
  }
  cache.set(cacheKey, offsets);
  return offsets;
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

function offsetLooksLikeBlob(data, searchPath, offset) {
  const start = offset + Buffer.byteLength(searchPath);
  const ext = path.extname(searchPath).toLowerCase();
  for (let delta = 0; delta < 48; delta++) {
    const p = start + delta;
    if (p + 12 > data.length) break;
    if (ext === ".png" && data[p] === 0x89 && data[p + 1] === 0x50) return true;
    if ((ext === ".jpg" || ext === ".jpeg") && data[p] === 0xff && data[p + 1] === 0xd8) return true;
    if ((ext === ".webp" || ext === ".wav") && data.compare(Buffer.from("RIFF"), 0, 4, p, p + 4) === 0) return true;
    if (ext === ".json" && (data[p] === 0x7b || data[p] === 0x5b)) return true;
    if (ext === ".atlas" && data[p] !== 0 && data[p] >= 0x09) {
      const probe = data.subarray(p, Math.min(data.length, p + 64)).toString("latin1");
      if (probe.includes("size:") || /\.webp|\.png/.test(probe)) return true;
    }
  }
  return false;
}

// --- Structured embedded asset tables (authoritative) ---
// Newer official clients (Oct 2026+) ship two pointer tables in .rdata:
//   1. Tauri frontend map: 32-byte records (key_ptr, key_len, val_ptr, val_len),
//      key like "/assets/index-*.js", value = one brotli stream.
//   2. Game asset embed: 104-byte records with name (ptr, len) at +0, sha256 at +48
//      and raw data (ptr, len) at +88. Names are packed together and identical
//      files are deduplicated by the linker, so the "data follows the path string"
//      heuristic cannot find them (drones/*.atlas, ships/*.json, ...).
// Same logic as extract_redgalaxy_web.py (find_embedded_asset_tables).
const TABLE_NAME_RE = /^\/?[A-Za-z0-9_@+\-][A-Za-z0-9_./@+\- ]*\.[A-Za-z0-9]{1,6}$/;

function pe64Layout(data) {
  if (data.length < 0x400 || data[0] !== 0x4d || data[1] !== 0x5a) return null;
  const pe = data.readUInt32LE(0x3c);
  if (pe + 24 > data.length || data.readUInt32LE(pe) !== 0x00004550) return null;
  const nsec = data.readUInt16LE(pe + 6);
  const optsz = data.readUInt16LE(pe + 20);
  const opt = pe + 24;
  if (data.readUInt16LE(opt) !== 0x20b) return null; // PE32+ only (x64 client)
  const imageBase = Number(data.readBigUInt64LE(opt + 24));
  const sections = [];
  for (let i = 0; i < nsec; i++) {
    const o = opt + optsz + 40 * i;
    if (o + 40 > data.length) break;
    const va = data.readUInt32LE(o + 12);
    let rsize = data.readUInt32LE(o + 16);
    const raw = data.readUInt32LE(o + 20);
    const chars = data.readUInt32LE(o + 36);
    rsize = Math.min(rsize, Math.max(0, data.length - raw));
    if (rsize > 0) sections.push({ va, raw, rsize, chars });
  }
  return { imageBase, sections };
}

function findEmbeddedAssetTables(data) {
  const found = new Map(); // rel -> { kind: "raw" | "br", off, len }
  const layout = pe64Layout(data);
  if (!layout || !layout.sections.length) return found;
  const { imageBase, sections } = layout;
  const vmin = imageBase + Math.min(...sections.map((s) => s.va));
  const vmax = imageBase + Math.max(...sections.map((s) => s.va + s.rsize));
  const v2o = (v) => {
    const r = v - imageBase;
    for (const s of sections) {
      if (r >= s.va && r < s.va + s.rsize) return s.raw + (r - s.va);
    }
    return -1;
  };
  const q = (off) => data.readUInt32LE(off) + data.readUInt32LE(off + 4) * 0x100000000;
  const n = data.length;
  for (const s of sections) {
    if (s.chars & 0x20000000) continue; // skip executable code sections
    const start = s.raw + ((8 - (s.raw % 8)) % 8);
    const count = Math.floor((s.raw + s.rsize - start) / 8);
    for (let i = 0; i + 3 < count; i++) {
      const rec = start + i * 8;
      const p = q(rec);
      if (p < vmin || p >= vmax) continue;
      const ln = q(rec + 8);
      if (ln < 3 || ln > 260) continue;
      const no = v2o(p);
      if (no < 0 || no + ln > n) continue;
      const nameBuf = data.subarray(no, no + ln);
      const name = nameBuf.toString("latin1");
      if (!TABLE_NAME_RE.test(name)) continue;
      const rel = normalizePath(name);
      if (!rel || !isSaneRelPath(rel)) continue;
      // Game asset embed record (raw bytes + sha256).
      if (i + 12 < count) {
        const dp = q(rec + 88);
        const dl = q(rec + 96);
        if (dp >= vmin && dp < vmax && dl > 0 && dl <= 200_000_000) {
          const dOff = v2o(dp);
          if (dOff >= 0 && dOff + dl <= n) {
            const digest = crypto.createHash("sha256").update(data.subarray(dOff, dOff + dl)).digest();
            if (digest.equals(data.subarray(rec + 48, rec + 80))) {
              if (!found.has(rel)) found.set(rel, { kind: "raw", off: dOff, len: dl });
              continue;
            }
          }
        }
      }
      // Tauri frontend map record (brotli value).
      if (name.startsWith("/")) {
        const vp = q(rec + 16);
        const vl = q(rec + 24);
        if (vp >= vmin && vp < vmax && vl > 0 && vl <= 200_000_000) {
          const vOff = v2o(vp);
          if (vOff >= 0 && vOff + vl <= n && !found.has(rel)) {
            found.set(rel, { kind: "br", off: vOff, len: vl });
          }
        }
      }
    }
  }
  return found;
}

function extractFromAssetTables(data, outDir) {
  const table = findEmbeddedAssetTables(data);
  const ok = new Set();
  const bad = new Set();
  for (const rel of [...table.keys()].sort()) {
    const { kind, off, len } = table.get(rel);
    const chunk = data.subarray(off, off + len);
    let payload = null;
    if (kind === "raw") payload = Buffer.from(chunk);
    else {
      try {
        payload = zlib.brotliDecompressSync(chunk);
      } catch {
        payload = null;
      }
    }
    if (!payload || !payload.length) {
      bad.add(rel);
      continue;
    }
    writeFile(outDir, rel, payload);
    ok.add(rel);
    const canon = canonicalAssetRel(rel);
    if (canon && canon !== rel && !table.has(canon)) {
      writeFile(outDir, canon, payload);
      ok.add(canon);
    }
  }
  if (table.size) {
    console.error(`asset_table entries=${table.size} decoded=${ok.size} bad=${bad.size}`);
  }
  return { ok, bad };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    console.error("usage: extract_redgalaxy_web.js /path/to/reduniverse-pc-client.exe /output/dir");
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
  // A truncated / still-installing / wrong file has no PE header or is tiny
  // (Windows: "extracted=0 pending=1 failed=1 ms=7" came from such an input).
  if (data.length < 1_000_000 || data[0] !== 0x4d || data[1] !== 0x5a) {
    console.error(
      `Client exe is not a complete official client (size=${data.length} bytes, header=${JSON.stringify(
        data.subarray(0, 2).toString("latin1")
      )}): ${exe}. Reinstall/finish installing the official client and retry.`
    );
    return 3;
  }
  fs.mkdirSync(outDir, { recursive: true });

  const discovered = discoverPathsFromBinary(data);
  let pending = discovered.pending;
  const offsetIndex = discovered.offsetIndex;
  const offsetCache = new Map();
  // Exact extraction from the client's embedded asset tables first.
  const tableResult = extractFromAssetTables(data, outDir);
  const tableOk = tableResult.ok;
  for (const rel of tableOk) pending.add("/" + rel);
  const extracted = new Set(tableOk);
  const failed = new Set();
  const t0 = Date.now();
  const logProgress = () => {
    console.error(
      `extract_progress extracted=${extracted.size} pending=${pending.size} failed=${failed.size} ms=${Date.now() - t0}`
    );
  };

  for (let round = 0; round < 4; round++) {
    let progress = false;
    for (const pth of [...pending].sort()) {
      const rel = canonicalAssetRel(pth) || normalizePath(pth);
      if (!rel || extracted.has(rel) || failed.has(rel)) continue;
      let offsets = offsetIndex.get(rel) ? offsetIndex.get(rel).slice() : [];
      if (!offsets.length) {
        offsets = findPathOffsetsFallback(data, pth, offsetCache);
      }
      if (!offsets.length) {
        failed.add(rel);
        continue;
      }
      // Prefer path markers followed by real blob magics over fused path-table hits.
      offsets.sort((a, b) => {
        const ab = offsetLooksLikeBlob(data, a[0], a[1]) ? 0 : 1;
        const bb = offsetLooksLikeBlob(data, b[0], b[1]) ? 0 : 1;
        return ab - bb;
      });
      let payload = null;
      for (const [searchPath, off] of offsets.slice(0, 40)) {
        payload = extractPayload(data, searchPath, off, brotliBin);
        if (payload) break;
      }
      if (payload) {
        writeFile(outDir, rel, payload);
        extracted.add(rel);
        failed.delete(rel);
        progress = true;
        if (extracted.size === 1 || extracted.size % 40 === 0) logProgress();
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
  logProgress();

  mergeLocaleWithFallback(outDir, "it");
  mergeLocaleWithFallback(outDir, "quest.it", "quest.en");
  applyItalianUiOverrides(outDir);
  // RedUniverse-only: never heal/copy from RedGalaxy twin exe.
  ensureRuntimeAssetAliases(outDir);

  const critical = ["box/cargo.png", "base/orion.png"];
  const missingCritical = [];
  for (const rel of critical) {
    const full = path.join(outDir, ...rel.split("/"));
    if (!fs.existsSync(full) || !isValidPng(full)) missingCritical.push(rel);
  }
  if (missingCritical.length) {
    console.warn(`WARN: missing/invalid critical assets after extract: ${missingCritical.join(", ")}`);
  }

  // With a structured table present, a referenced path that is neither in the table
  // nor recoverable by the heuristic is not shipped in the official client
  // (e.g. icons/128x128.png is the Tauri bundle icon string from tauri.conf).
  // PC 0.9.x also keeps ships/maps/box art in encrypted .rgpak — those land here.
  const notInClient = new Set();
  if (tableOk.size) {
    for (const rel of failed) if (!tableOk.has(rel)) notInClient.add(rel);
    for (const rel of notInClient) failed.delete(rel);
  }
  console.log(
    `extracted=${extracted.size} failed=${failed.size} not_in_client=${notInClient.size} output=${outDir}`
  );
  if (notInClient.size) {
    console.log("not_in_client (referenced, but not embedded in the official exe):");
    for (const item of [...notInClient].sort().slice(0, 80)) console.log(`  ${item}`);
  }
  if (failed.size) {
    console.log("failed_sample:");
    for (const item of [...failed].sort().slice(0, 80)) console.log(`  ${item}`);
  }
  // Do not fail solely because rgpak-backed art is absent from the PE.
  // Bastion merges ships/maps from a prior web / bundle donor, then completeness-gates.
  const blockingCritical = missingCritical.filter((rel) => !notInClient.has(rel));
  if (failed.size) return 1;
  return blockingCritical.length ? 1 : 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  main,
  despliceEmbeddedPayload,
  EMBED_SPLICE_PERIOD,
  EMBED_SPLICE_MARKER,
  ensureRuntimeAssetAliases,
};

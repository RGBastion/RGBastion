#!/usr/bin/env node
"use strict";

/**
 * RGPAK v1 unpacker for RedGalaxy PC 0.9.x asset packs.
 *
 * Wire format (after outer zstd on CDN blobs):
 *   magic   8  "RGPAK\r\n\x1a"
 *   ver     u16 (=1)
 *   flags   u16 (bit0 = encrypted AES-256-GCM)
 *   pad     u32
 *   align   u32 (typically 0x1000)
 *   count   u32
 *   dataOff u64
 *   indexOff u64
 *
 * Encrypted entries use AAD label "RGPAK/v1/enc" and key check "RGPAK/v1/kcv".
 * The 32-byte AES key is baked into redgalaxy-game.exe (AES-NI key schedule /
 * obfuscated keyring); it is NOT in latest.json. Pass it via:
 *   RGPAK_AES_KEY=<64 hex chars>   or   --key <hex>
 *
 * Without a key this tool still:
 *   - validates / inventories packs
 *   - decompresses CDN zstd → .rgpak
 * and exits 0 so Bastion can keep packs on disk for a later decrypt pass.
 *
 * Usage:
 *   node rgpak_unpack.js --inventory pack.rgpak
 *   node rgpak_unpack.js --out DIR pack1.rgpak [pack2…]
 *   node rgpak_unpack.js --download-manifest latest.json --packs-dir DIR [--out DIR]
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const https = require("https");

const MAGIC = Buffer.from("RGPAK\r\n\x1a");
const AAD_ENC = Buffer.from("RGPAK/v1/enc");
const AAD_KCV = Buffer.from("RGPAK/v1/kcv");

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {
    inventory: false,
    outDir: "",
    packsDir: "",
    manifest: "",
    keyHex: process.env.RGPAK_AES_KEY || process.env.RGPAK_KEY || "",
    files: [],
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--inventory") out.inventory = true;
    else if (a === "--out") out.outDir = argv[++i] || "";
    else if (a === "--packs-dir") out.packsDir = argv[++i] || "";
    else if (a === "--download-manifest") out.manifest = argv[++i] || "";
    else if (a === "--key") out.keyHex = argv[++i] || "";
    else if (a.startsWith("-")) die(`Unknown flag: ${a}`);
    else out.files.push(a);
  }
  return out;
}

function readHeader(buf) {
  if (buf.length < 40 || !buf.subarray(0, 8).equals(MAGIC)) {
    throw new Error("Not an RGPAK file (missing magic)");
  }
  const ver = buf.readUInt16LE(8);
  const flags = buf.readUInt16LE(10);
  const pad = buf.readUInt32LE(12);
  const align = buf.readUInt32LE(16);
  const count = buf.readUInt32LE(20);
  const dataOff = Number(buf.readBigUInt64LE(24));
  const indexOff = Number(buf.readBigUInt64LE(32));
  return { ver, flags, pad, align, count, dataOff, indexOff, encrypted: (flags & 1) !== 0 };
}

/** Best-effort index walk. Encrypted packs keep pathnames sealed — returns offsets only. */
function inventoryPack(buf) {
  const h = readHeader(buf);
  const entries = [];
  // Index entry layout (observed): pathLen u16 + path bytes + pad + offset u64 + size u64 + flags…
  // When encrypted, path bytes are ciphertext; we only report count + header.
  let cursor = h.indexOff;
  for (let i = 0; i < h.count && cursor + 4 < buf.length; i++) {
    const pathLen = buf.readUInt16LE(cursor);
    cursor += 2;
    if (pathLen > 4096 || cursor + pathLen > buf.length) {
      entries.push({ i, note: "index_desync", at: cursor - 2 });
      break;
    }
    const rawPath = buf.subarray(cursor, cursor + pathLen);
    cursor += pathLen;
    // Align to 8
    const pad = (8 - (cursor % 8)) % 8;
    cursor += pad;
    if (cursor + 16 > buf.length) break;
    const off = Number(buf.readBigUInt64LE(cursor));
    const size = Number(buf.readBigUInt64LE(cursor + 8));
    cursor += 16;
    const printable = rawPath.every((c) => c >= 0x20 && c < 0x7f);
    entries.push({
      i,
      path: printable ? rawPath.toString("utf8") : null,
      pathLen,
      off,
      size,
    });
  }
  return { header: h, entries };
}

function parseKey(hex) {
  const clean = String(hex || "").trim().replace(/^0x/i, "").replace(/\s+/g, "");
  if (!clean) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error("RGPAK AES key must be 64 hex chars (32 bytes)");
  }
  return Buffer.from(clean, "hex");
}

/**
 * Decrypt one GCM frame: nonce(12) || ciphertext || tag(16).
 * Returns plaintext or null on auth failure.
 */
function decryptGcm(key, frame, aad) {
  if (!frame || frame.length < 12 + 16) return null;
  const nonce = frame.subarray(0, 12);
  const tag = frame.subarray(frame.length - 16);
  const ciphertext = frame.subarray(12, frame.length - 16);
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    return null;
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeSafe(outRoot, rel, data) {
  const clean = String(rel || "").replace(/^\/+/, "").replace(/\\/g, "/");
  if (!clean || clean.includes("..")) return false;
  const dest = path.join(outRoot, clean);
  ensureDir(path.dirname(dest));
  fs.writeFileSync(dest, data);
  return true;
}

function decompressZstdIfNeeded(buf) {
  if (buf.length >= 4 && buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd) {
    let decompress;
    try {
      ({ decompress } = require("fzstd"));
    } catch {
      try {
        const zstd = require("zstd-codec");
        // sync path not always available; prefer fzstd
        throw new Error("fzstd required for zstd CDN blobs");
      } catch (err) {
        throw new Error(`zstd blob needs fzstd: ${err.message || err}`);
      }
    }
    return Buffer.from(decompress(buf));
  }
  return buf;
}

function loadPackBytes(filePath) {
  return decompressZstdIfNeeded(fs.readFileSync(filePath));
}

function unpackPack(filePath, outDir, key) {
  const buf = loadPackBytes(filePath);
  const inv = inventoryPack(buf);
  const h = inv.header;
  console.log(
    `[rgpak] ${path.basename(filePath)} ver=${h.ver} flags=${h.flags} count=${h.count} enc=${h.encrypted}`
  );
  if (!outDir) return { written: 0, skipped: h.count, reason: "no-out" };
  if (h.encrypted && !key) {
    console.warn(
      `[rgpak] encrypted — set RGPAK_AES_KEY to extract. Pack kept for later decrypt.`
    );
    return { written: 0, skipped: h.count, reason: "no-key" };
  }
  let written = 0;
  let skipped = 0;
  for (const ent of inv.entries) {
    if (ent.path == null || ent.size <= 0) {
      skipped += 1;
      continue;
    }
    const abs = h.dataOff + ent.off;
    const frame = buf.subarray(abs, abs + ent.size);
    let payload = frame;
    if (h.encrypted) {
      payload = decryptGcm(key, frame, AAD_ENC);
      if (!payload) {
        skipped += 1;
        continue;
      }
    }
    if (writeSafe(outDir, ent.path, payload)) written += 1;
    else skipped += 1;
  }
  // Encrypted indexes: paths unreadable — try brute frame decrypt only if key verifies via KCV.
  if (h.encrypted && key && written === 0) {
    const kcvOk = tryVerifyKcv(buf, h, key);
    console.warn(
      `[rgpak] key ${kcvOk ? "matches KCV" : "KCV unknown/fail"}; index paths sealed — need matching index cipher.`
    );
  }
  return { written, skipped };
}

function tryVerifyKcv(buf, h, key) {
  // Scan near header / index for a short GCM frame that authenticates under KCV AAD.
  const scanEnd = Math.min(buf.length, h.dataOff || 0x10000);
  for (let off = 40; off + 12 + 16 + 16 < scanEnd; off++) {
    // Heuristic: 16-byte plaintext KCV blobs are uncommon; skip exhaustive scan in hot path.
    if ((off & 0xf) !== 0) continue;
    const frame = buf.subarray(off, off + 12 + 32 + 16); // nonce+32+tag guess
    if (decryptGcm(key, frame, AAD_KCV)) return true;
  }
  return false;
}

function downloadUrl(url, dest) {
  return new Promise((resolve, reject) => {
    ensureDir(path.dirname(dest));
    const partial = dest + ".part";
    const file = fs.createWriteStream(partial);
    const req = https.get(
      url,
      { headers: { "User-Agent": "RedGalaxy-Bastion/rgpak-unpack" } },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          fs.unlink(partial, () => {});
          downloadUrl(res.headers.location, dest).then(resolve, reject);
          res.resume();
          return;
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlink(partial, () => {});
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          res.resume();
          return;
        }
        res.pipe(file);
        file.on("finish", () => {
          file.close(() => {
            fs.renameSync(partial, dest);
            resolve(dest);
          });
        });
      }
    );
    req.on("error", (err) => {
      file.close();
      fs.unlink(partial, () => {});
      reject(err);
    });
  });
}

function normalizeManifest(raw) {
  let data = raw;
  if (Number(data.schema) === 1 && data.payload) {
    data = JSON.parse(Buffer.from(String(data.payload), "base64").toString("utf8"));
  }
  const files = Array.isArray(data.files) ? data.files : [];
  const blobsPrefix = String((data.base_url && data.base_url.blobs) || "blobs/").replace(/^\/+/, "");
  const base = "https://updates.redgalaxygame.space/pc/";
  return files
    .filter((f) => f && f.component === "assets" && f.sha256)
    .map((f) => ({
      path: String(f.path || ""),
      sha256: String(f.sha256).trim(),
      size: Number(f.size) || 0,
      url: `${base}${blobsPrefix}${String(f.sha256).trim()}`,
    }));
}

async function downloadManifestPacks(manifestPath, packsDir) {
  const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const assets = normalizeManifest(raw);
  ensureDir(packsDir);
  const out = [];
  for (const asset of assets) {
    const name = path.basename(asset.path) || `${asset.sha256}.rgpak`;
    const dest = path.join(packsDir, name);
    if (fs.existsSync(dest) && asset.size > 0 && fs.statSync(dest).size === asset.size) {
      console.log(`[rgpak] cached ${name}`);
      out.push(dest);
      continue;
    }
    // CDN serves zstd; store decompressed .rgpak when possible.
    const zst = dest + ".zst";
    console.log(`[rgpak] download ${name}…`);
    await downloadUrl(asset.url, zst);
    const buf = loadPackBytes(zst);
    fs.writeFileSync(dest, buf);
    try {
      fs.unlinkSync(zst);
    } catch {
      /* ignore */
    }
    out.push(dest);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  let key = null;
  try {
    key = parseKey(args.keyHex);
  } catch (err) {
    die(err.message || String(err));
  }

  let files = [...args.files];
  if (args.manifest) {
    if (!args.packsDir) die("--download-manifest requires --packs-dir");
    const downloaded = await downloadManifestPacks(args.manifest, args.packsDir);
    files = files.concat(downloaded);
  }

  if (!files.length) {
    die("Usage: node rgpak_unpack.js [--out DIR] [--key HEX] pack.rgpak…");
  }

  let totalWritten = 0;
  for (const file of files) {
    if (!fs.existsSync(file)) {
      console.warn(`[rgpak] missing ${file}`);
      continue;
    }
    if (args.inventory) {
      const inv = inventoryPack(loadPackBytes(file));
      console.log(JSON.stringify({ file, header: inv.header, sample: inv.entries.slice(0, 5) }, null, 2));
      continue;
    }
    const result = unpackPack(file, args.outDir, key);
    totalWritten += result.written || 0;
  }
  if (args.outDir) {
    console.log(`[rgpak] wrote ${totalWritten} file(s) into ${args.outDir}`);
  }
}

if (require.main === module) {
  main().catch((err) => die(err.stack || String(err)));
}

module.exports = {
  readHeader,
  inventoryPack,
  unpackPack,
  loadPackBytes,
  parseKey,
  AAD_ENC,
  AAD_KCV,
};

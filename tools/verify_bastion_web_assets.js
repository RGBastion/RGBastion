#!/usr/bin/env node
/**
 * Pre-release gate: fail if critical 0.9.19+ art is missing from a web root.
 * Usage: node tools/verify_bastion_web_assets.js <webDir> [<webDir>...]
 *
 * Pet pixels ARE required (official recovered kit in tools/asset-cache/pets-official).
 * Provisional donor crops (sball/etc.) remain FORBIDDEN.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const REQUIRED = [
  "maps/map22/bg.jpg",
  "maps/map23/bg.jpg",
  "maps/map24/bg.jpg",
  "maps/pyro_core/bg.jpg",
  "maps/pyro_2/bg.jpg",
  "maps/pyro/pyro_walls.webp",
  "maps/pyro/pyro_walls.json",
  "maps/pyro/fog_ash_a.png",
  "ships/alien/ember_mite.webp",
  "ships/alien/cinder_stalker.webp",
  "ships/alien/pyre_warden.webp",
  "ships/pet/pet_l1.json",
  "ships/pet/pet_l5.json",
  "ships/pet/pet_base.webp",
  "ships/pet/pet_l2.webp",
  "ships/pet/pet_l3.webp",
  "ships/pet/pet_l4.webp",
  "ships/pet/pet_l5.webp",
  "ships/pet/pet_l5_glow.webp",
  "shop/pet/pet.webp",
  "shop/pet/preview/pet.webp",
  "shop/gen/shg4.webp",
  "shop/launcher/rl3.webp",
  "equip/gen/shg4.png",
];

/** If these exist, they must be real PNG (not JPEG-as-PNG). */
const REAL_PNG_CHECKS = [
  "maps/map22/fog_a.png",
  "maps/map22/fog_b.png",
  "maps/map23/fog_a.png",
  "maps/map23/fog_b.png",
  "maps/pyro/fog_ash_a.png",
  "maps/pyro_core/core_fog_a.png",
  "maps/pyro_core/core_fog_b.png",
];

const PET_FRAME = 172;
const PET_WEBP_PATHS = [
  "ships/pet/pet_base.webp",
  "ships/pet/pet_l2.webp",
  "ships/pet/pet_l3.webp",
  "ships/pet/pet_l4.webp",
  "ships/pet/pet_l5.webp",
  "ships/pet/pet_l5_glow.webp",
  "shop/pet/pet.webp",
  "shop/pet/preview/pet.webp",
];

function isRealPng(filePath) {
  const fd = Buffer.alloc(8);
  const fh = fs.openSync(filePath, "r");
  try {
    fs.readSync(fh, fd, 0, 8, 0);
  } finally {
    fs.closeSync(fh);
  }
  return fd[0] === 0x89 && fd[1] === 0x50 && fd[2] === 0x4e && fd[3] === 0x47;
}

function checkPetDims(filePath, frameSize) {
  const py = `
from PIL import Image
import sys
im = Image.open(sys.argv[1])
w, h = im.size
fs = int(sys.argv[2])
ok = w % fs == 0 and h % fs == 0 and w > 0 and h > 0
print(f"{w}x{h}")
sys.exit(0 if ok else 1)
`;
  const r = spawnSync("python3", ["-c", py, filePath, String(frameSize)], {
    encoding: "utf8",
    timeout: 30000,
  });
  const dims = String(r.stdout || "").trim() || "?";
  return { ok: r.status === 0, dims };
}

function fileMd5(filePath) {
  const crypto = require("crypto");
  return crypto.createHash("md5").update(fs.readFileSync(filePath)).digest("hex");
}

/**
 * Reject known provisional donor crops: tiny identical sheets across layers
 * (sball crop stand-in was ~7568 bytes, identical MD5 for every layer).
 */
function findProvisionalPetStandins(webDir) {
  const bad = [];
  const present = [];
  for (const rel of PET_WEBP_PATHS) {
    const p = path.join(webDir, ...rel.split("/"));
    if (!fs.existsSync(p) || fs.statSync(p).size < 32) continue;
    present.push({ rel, path: p, size: fs.statSync(p).size, md5: fileMd5(p) });
  }
  if (!present.length) return bad;

  // Identical tiny files across ships/pet *layers* ⇒ donor stand-in.
  // shop/pet + preview are intentionally the same small 172×172 icon — skip those.
  const layerRows = present.filter((r) => r.rel.startsWith("ships/pet/"));
  const byHash = new Map();
  for (const row of layerRows) {
    if (!byHash.has(row.md5)) byHash.set(row.md5, []);
    byHash.get(row.md5).push(row);
  }
  for (const [md5, rows] of byHash) {
    if (rows.length >= 2 && rows.every((r) => r.size < 50_000)) {
      for (const r of rows) {
        bad.push(
          `${r.rel} provisional stand-in (identical ${r.size}B md5=${md5.slice(0, 8)}…) — use tools/asset-cache/pets-official`
        );
      }
    }
  }

  // Pet webps must be a clean frame_size grid (atlas sheets or 172×172 shop icons).
  for (const row of present) {
    if (bad.some((b) => b.startsWith(row.rel))) continue;
    const { ok, dims } = checkPetDims(row.path, PET_FRAME);
    if (!ok) {
      bad.push(`${row.rel} dims ${dims} not multiple of ${PET_FRAME}`);
    }
  }
  return bad;
}

function verifyOne(webDir) {
  const abs = path.resolve(webDir);
  const missing = [];
  const bad = [];
  if (!fs.existsSync(abs)) {
    console.error(`FAIL: web root missing: ${abs}`);
    return 1;
  }
  for (const rel of REQUIRED) {
    const p = path.join(abs, ...rel.split("/"));
    if (!fs.existsSync(p) || fs.statSync(p).size < 32) {
      missing.push(rel);
      continue;
    }
    if (/\.png$/i.test(rel) && !isRealPng(p)) {
      bad.push(`${rel} (not a real PNG — likely JPEG-as-PNG)`);
    }
  }
  for (const rel of REAL_PNG_CHECKS) {
    const p = path.join(abs, ...rel.split("/"));
    if (!fs.existsSync(p)) continue;
    if (!isRealPng(p)) bad.push(`${rel} (not a real PNG — likely JPEG-as-PNG)`);
  }
  bad.push(...findProvisionalPetStandins(abs));

  // asset-cache presence is checked at package time; here only web root.
  if (missing.length || bad.length) {
    console.error(`FAIL: ${abs}`);
    for (const m of missing) console.error(`  missing: ${m}`);
    for (const b of bad) console.error(`  bad: ${b}`);
    return 1;
  }
  console.log(`OK: ${abs}`);
  return 0;
}

function main(argv) {
  const roots = argv.length ? argv : [];
  if (!roots.length) {
    console.error("Usage: node tools/verify_bastion_web_assets.js <webDir>...");
    return 2;
  }
  let code = 0;
  for (const r of roots) code = verifyOne(r) || code;
  return code;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { verifyOne, REQUIRED, PET_WEBP_PATHS, removeProvisionalPetWebps: null };

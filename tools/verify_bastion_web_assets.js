#!/usr/bin/env node
/**
 * Pre-release gate: fail if critical 0.9.19+ art is missing from a web root.
 * Usage: node tools/verify_bastion_web_assets.js <webDir> [<webDir>...]
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
  "ships/pet/pet_base.webp",
  "ships/pet/pet_l1.json",
  "ships/pet/pet_l5.json",
  "ships/pet/pet_l5.webp",
  "shop/pet/pet.webp",
  "shop/gen/shg4.webp",
  "shop/launcher/rl3.webp",
  "equip/gen/shg4.png",
];

const PET_FRAME = 172;
const PET_DIM_CHECKS = [
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
  for (const rel of PET_DIM_CHECKS) {
    const p = path.join(abs, ...rel.split("/"));
    if (!fs.existsSync(p)) continue;
    const { ok, dims } = checkPetDims(p, PET_FRAME);
    if (!ok) {
      bad.push(`${rel} dims ${dims} not multiple of ${PET_FRAME} (full atlas leak)`);
    }
  }
  // Prefer single-frame shop/pet icon (not a multi-cell sheet).
  const shopPet = path.join(abs, "shop", "pet", "pet.webp");
  if (fs.existsSync(shopPet)) {
    const { ok, dims } = checkPetDims(shopPet, PET_FRAME);
    if (ok && dims !== `${PET_FRAME}x${PET_FRAME}`) {
      // Multiples of 172 still fail the hangar icon UX if >1 cell.
      const [w, h] = dims.split("x").map(Number);
      if (w > PET_FRAME || h > PET_FRAME) {
        bad.push(`shop/pet/pet.webp dims ${dims} — want single ${PET_FRAME}x${PET_FRAME} icon`);
      }
    }
  }
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

module.exports = { verifyOne, REQUIRED };

#!/usr/bin/env node
"use strict";

/**
 * Apply Bastion/story overlays and game hooks onto extracted RedGalaxy web assets.
 * Node port of apply_bastion_patches.py (no Python required).
 *
 * Usage:
 *   node apply_bastion_patches.js --game-src DIR --story-src DIR --out DIR
 *   node apply_bastion_patches.js --in-place DIR --story-src DIR
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const BASTION_STAMP_NAME = ".bastion-stamp";

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function resolveStoryFiles(storySrc) {
  if (!fs.existsSync(storySrc) || !fs.statSync(storySrc).isDirectory()) {
    die(`Story source not found: ${storySrc}`);
  }

  const i18n = path.join(storySrc, "i18n.js");
  let autopilot = path.join(storySrc, "autopilot.js");
  if (!fs.existsSync(autopilot)) {
    autopilot = path.join(storySrc, "redgalaxy_story_autopilot.js");
  }
  const mapGraph = path.join(storySrc, "map_graph.json");
  const scriptsDir = path.join(storySrc, "scripts");

  const missing = [];
  if (!fs.existsSync(i18n)) missing.push("i18n.js");
  if (!fs.existsSync(autopilot)) missing.push("autopilot.js / redgalaxy_story_autopilot.js");
  if (!fs.existsSync(mapGraph)) missing.push("map_graph.json");
  if (missing.length) die(`Missing story files in ${storySrc}: ${missing.join(", ")}`);
  if (!fs.existsSync(scriptsDir) || !fs.statSync(scriptsDir).isDirectory()) {
    die(`Missing story scripts dir: ${scriptsDir}`);
  }

  return { i18n, autopilot, mapGraph, scripts: scriptsDir };
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function copyGameTree(gameSrc, outDir) {
  if (!fs.existsSync(path.join(gameSrc, "index.html"))) {
    die(`Missing game index.html: ${path.join(gameSrc, "index.html")}`);
  }
  rmrf(outDir);
  fs.cpSync(gameSrc, outDir, { recursive: true });
}

function computeStoryStamp(story) {
  const digest = crypto.createHash("sha256");
  for (const [key, filePath] of [
    ["autopilot", story.autopilot],
    ["i18n", story.i18n],
    ["map_graph", story.mapGraph],
  ]) {
    digest.update(key);
    digest.update("\0");
    digest.update(fs.readFileSync(filePath));
    digest.update("\0");
  }
  for (const name of fs.readdirSync(story.scripts).sort()) {
    if (!name.endsWith(".json")) continue;
    digest.update(name);
    digest.update("\0");
    digest.update(fs.readFileSync(path.join(story.scripts, name)));
    digest.update("\0");
  }
  return digest.digest("hex");
}

function writeBastionStamp(storyOut, story) {
  const stampPath = path.join(storyOut, BASTION_STAMP_NAME);
  fs.writeFileSync(stampPath, `${computeStoryStamp(story)}\n`, "utf8");
  return stampPath;
}

function overlayStory(outDir, story) {
  const storyOut = path.join(outDir, "story");
  const scriptsOut = path.join(storyOut, "scripts");
  fs.mkdirSync(scriptsOut, { recursive: true });
  fs.copyFileSync(story.i18n, path.join(storyOut, "i18n.js"));
  fs.copyFileSync(story.autopilot, path.join(storyOut, "autopilot.js"));
  fs.copyFileSync(story.mapGraph, path.join(storyOut, "map_graph.json"));
  for (const name of fs.readdirSync(story.scripts).sort()) {
    if (!name.endsWith(".json")) continue;
    fs.copyFileSync(path.join(story.scripts, name), path.join(scriptsOut, name));
  }
  const stampPath = writeBastionStamp(storyOut, story);
  console.log(`Wrote Bastion stamp: ${stampPath}`);
}

function patchIndexHtml(root) {
  const indexPath = path.join(root, "index.html");
  let html = fs.readFileSync(indexPath, "utf8");
  const hook = `    <script>
      window.__RG_STORY_MODE__ = true;
    </script>
`;
  const i18n = '    <script defer src="/story/i18n.js"></script>\n';
  const autopilot = '    <script defer src="/story/autopilot.js"></script>\n';
  if (!html.includes("__RG_STORY_MODE__")) {
    html = html.replace("</body>", `${hook}${i18n}${autopilot}  </body>`);
  } else {
    if (!html.includes("/story/i18n.js")) {
      html = html.replace("</body>", `${i18n}  </body>`);
    }
    if (!html.includes("/story/autopilot.js")) {
      html = html.replace("</body>", `${autopilot}  </body>`);
    }
  }
  fs.writeFileSync(indexPath, html, "utf8");
  console.log(`Patched: ${indexPath}`);
}

// Minified identifiers change between builds (0.6.23: Mt→Ct, K→W, bonus T→S).
const GAME_HOOK_RE =
  /(const e=new \w+\.Game\([A-Za-z0-9_$]+\);)(?!window\.__RG_GAME__)([A-Za-z0-9_$]+\(e\))/;
const NET_HOOK_RE =
  /const (\w+)=new (\w+),(\w+)=Object\.freeze\(Object\.defineProperty/;
const NET_HOOK_ALREADY_RE =
  /const (\w+)=new (\w+);window\.__RG_NET__=\1;const (\w+)=Object\.freeze\(Object\.defineProperty/;
const NET_HOOK_BROKEN_RE =
  /const (\w+)=new (\w+);window\.__RG_NET__=\1,(\w+)=Object\.freeze\(Object\.defineProperty/;
const STATE_HOOK_RE =
  /(preservedLocalSlow:null\}\})const (\w+)=(\w+)\(\),(\w+)=new Set/;
const STATE_HOOK_FALLBACK_RE =
  /const (\w+)=(\w+)\(\),(\w+)=new Set;function (\w+)\((\w+)\)\{\3\.add/;
const STATE_HOOK_ALREADY_RE =
  /const (\w+)=\w+\(\);window\.__RG_STATE__=\1;const \w+=new Set/;
const BONUS_HOOK_RE =
  /(\w+)\.onMessage\("bonusBoxCollected",(\w+)=>\{e\.onBonusBoxCollected\(\2\)\}\)/;
const MAP_DIMS_RE =
  /(\w+)\.map_width&&\((\w+)\.mapWidth=\1\.map_width\),\1\.map_height&&\(\2\.mapHeight=\1\.map_height\)/;
const MAP_DIMS_ALREADY = "window.__RG_MAP_W__";
const GAME_BOOTSTRAP_RE = /new \w+\.Game\(/;

function patchGameHook(text) {
  if (text.includes("window.__RG_GAME__=e") && !GAME_HOOK_RE.test(text)) {
    return [text, "already"];
  }
  if (!GAME_HOOK_RE.test(text)) return [text, null];
  return [text.replace(GAME_HOOK_RE, "$1window.__RG_GAME__=e;$2"), "patched"];
}

function patchNetHook(text) {
  if (NET_HOOK_ALREADY_RE.test(text)) return [text, "already"];
  const broken = text.match(NET_HOOK_BROKEN_RE);
  if (broken) {
    const [, netVar, cls, freezeVar] = broken;
    const repl =
      `const ${netVar}=new ${cls};window.__RG_NET__=${netVar};` +
      `const ${freezeVar}=Object.freeze(Object.defineProperty`;
    return [text.replace(NET_HOOK_BROKEN_RE, repl), "fixed"];
  }
  const m = text.match(NET_HOOK_RE);
  if (!m) return [text, null];
  const [, netVar, cls, freezeVar] = m;
  const repl =
    `const ${netVar}=new ${cls};window.__RG_NET__=${netVar};` +
    `const ${freezeVar}=Object.freeze(Object.defineProperty`;
  return [text.replace(NET_HOOK_RE, repl), "patched"];
}

function patchStateHook(text) {
  if (STATE_HOOK_ALREADY_RE.test(text)) return [text, "already"];
  const m = text.match(STATE_HOOK_RE);
  if (m) {
    const [, prefix, stateVar, factory, setVar] = m;
    const repl =
      `${prefix}const ${stateVar}=${factory}();` +
      `window.__RG_STATE__=${stateVar};const ${setVar}=new Set`;
    return [text.replace(m[0], repl), "patched"];
  }
  const fb = text.match(STATE_HOOK_FALLBACK_RE);
  if (!fb) return [text, null];
  const [, stateVar, factory, setVar, fnName, arg] = fb;
  const repl =
    `const ${stateVar}=${factory}();window.__RG_STATE__=${stateVar};` +
    `const ${setVar}=new Set;function ${fnName}(${arg}){${setVar}.add`;
  return [text.replace(fb[0], repl), "patched"];
}

function patchBonusHook(text) {
  if (text.includes("window.__RG_STORY_ON_BONUS__")) return [text, "already"];
  const m = text.match(BONUS_HOOK_RE);
  if (!m) return [text, null];
  const [, netVar, arg] = m;
  const repl =
    `${netVar}.onMessage("bonusBoxCollected",${arg}=>{e.onBonusBoxCollected(${arg}),` +
    `window.__RG_STORY_ON_BONUS__?.(${arg})})`;
  return [text.replace(m[0], repl), "patched"];
}

function patchMapDims(text) {
  if (text.includes(MAP_DIMS_ALREADY)) return [text, "already"];
  const m = text.match(MAP_DIMS_RE);
  if (!m) return [text, null];
  const [, msgVar, stateVar] = m;
  const repl =
    `${msgVar}.map_width&&(${stateVar}.mapWidth=${msgVar}.map_width,` +
    `window.__RG_MAP_W__=${msgVar}.map_width),` +
    `${msgVar}.map_height&&(${stateVar}.mapHeight=${msgVar}.map_height,` +
    `window.__RG_MAP_H__=${msgVar}.map_height)`;
  return [text.replace(m[0], repl), "patched"];
}

function patchOneAsset(jsPath) {
  let text = fs.readFileSync(jsPath, "utf8");
  if (
    !GAME_BOOTSTRAP_RE.test(text) &&
    !text.includes("bonusBoxCollected") &&
    !text.includes("map_width")
  ) {
    return {};
  }

  const results = {};
  const writers = [
    ["game", patchGameHook],
    ["net", patchNetHook],
    ["state", patchStateHook],
    ["bonus", patchBonusHook],
    ["map", patchMapDims],
  ];
  let changed = false;
  for (const [name, fn] of writers) {
    const [next, status] = fn(text);
    text = next;
    if (status) {
      results[name] = status;
      if (status === "patched" || status === "fixed") {
        changed = true;
        console.log(`${status[0].toUpperCase()}${status.slice(1)} ${name} hook: ${jsPath}`);
      } else {
        console.log(`${name[0].toUpperCase()}${name.slice(1)} hook already present: ${jsPath}`);
      }
    }
  }
  if (changed) fs.writeFileSync(jsPath, text, "utf8");
  return results;
}

function patchAssetHooks(root) {
  const assets = path.join(root, "assets");
  if (!fs.existsSync(assets) || !fs.statSync(assets).isDirectory()) {
    die(
      `Missing assets directory: ${assets}\n` +
        "Extraction likely failed before Bastion patching (check brotli / update logs)."
    );
  }

  let jsFiles = fs
    .readdirSync(assets)
    .filter((n) => /^index-.*\.js$/.test(n))
    .map((n) => path.join(assets, n));
  if (!jsFiles.length) {
    die(`No assets/index-*.js found under ${assets} (incomplete extraction)`);
  }
  jsFiles.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);

  const merged = {};
  for (const jsPath of jsFiles) {
    const one = patchOneAsset(jsPath);
    for (const [key, status] of Object.entries(one)) {
      if (!(key in merged)) merged[key] = status;
    }
  }

  const missing = ["game", "net", "state"].filter((n) => !(n in merged));
  if (missing.length) {
    die(
      "Bastion game hooks failed — autopilot cannot detect readiness " +
        `(missing: ${missing.join(", ")}). ` +
        "Game JS layout may have changed; update apply_bastion_patches.js needles."
    );
  }
}

function applyPatches(outDir, storySrc) {
  const story = resolveStoryFiles(storySrc);
  overlayStory(outDir, story);
  patchIndexHtml(outDir);
  patchAssetHooks(outDir);
  if (!fs.existsSync(path.join(outDir, "story", "autopilot.js"))) {
    die("Bastion patch failed: story/autopilot.js missing after overlay");
  }
  if (!fs.readFileSync(path.join(outDir, "index.html"), "utf8").includes("__RG_STORY_MODE__")) {
    die("Bastion patch failed: __RG_STORY_MODE__ missing from index.html");
  }
  console.log(`Bastion patches applied: ${outDir}`);
}

function parseArgs(argv) {
  const out = { gameSrc: null, storySrc: null, out: null, inPlace: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      i += 1;
      return argv[i];
    };
    if (a === "--game-src") out.gameSrc = next();
    else if (a === "--story-src") out.storySrc = next();
    else if (a === "--out") out.out = next();
    else if (a === "--in-place") out.inPlace = next();
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.storySrc) die("Provide --story-src");

  if (args.inPlace) {
    const outDir = path.resolve(args.inPlace);
    if (!fs.existsSync(path.join(outDir, "index.html"))) {
      die(`Missing index.html in --in-place: ${outDir}`);
    }
    applyPatches(outDir, path.resolve(args.storySrc));
    return 0;
  }

  if (!args.gameSrc || !args.out) {
    die("Provide --game-src and --out, or --in-place");
  }

  const gameSrc = path.resolve(args.gameSrc);
  const outDir = path.resolve(args.out);
  copyGameTree(gameSrc, outDir);
  applyPatches(outDir, path.resolve(args.storySrc));
  return 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { applyPatches, resolveStoryFiles };

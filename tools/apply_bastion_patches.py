#!/usr/bin/env python3
"""Apply Bastion/story overlays and game hooks onto extracted RedGalaxy web assets.

Usage:
  apply_bastion_patches.py --game-src DIR --story-src DIR --out DIR
  apply_bastion_patches.py --in-place DIR --story-src DIR

Story sources expected under --story-src:
  i18n.js | redgalaxy_story_autopilot.js | map_graph.json | scripts/*.json
  OR already-normalized: i18n.js | autopilot.js | map_graph.json | scripts/*.json
"""
from __future__ import annotations

import argparse
import hashlib
import re
import shutil
import sys
from pathlib import Path

BASTION_STAMP_NAME = ".bastion-stamp"


def die(msg: str) -> None:
    print(msg, file=sys.stderr)
    raise SystemExit(1)


def resolve_story_files(story_src: Path) -> dict[str, Path]:
    if not story_src.is_dir():
        die(f"Story source not found: {story_src}")

    i18n = story_src / "i18n.js"
    autopilot = story_src / "autopilot.js"
    if not autopilot.is_file():
        autopilot = story_src / "redgalaxy_story_autopilot.js"
    map_graph = story_src / "map_graph.json"
    scripts_dir = story_src / "scripts"

    missing = [
        name
        for name, path in (
            ("i18n.js", i18n),
            ("autopilot.js / redgalaxy_story_autopilot.js", autopilot),
            ("map_graph.json", map_graph),
        )
        if not path.is_file()
    ]
    if missing:
        die(f"Missing story files in {story_src}: {', '.join(missing)}")
    if not scripts_dir.is_dir():
        die(f"Missing story scripts dir: {scripts_dir}")

    return {
        "i18n": i18n,
        "autopilot": autopilot,
        "map_graph": map_graph,
        "scripts": scripts_dir,
    }


def copy_game_tree(game_src: Path, out_dir: Path) -> None:
    if not (game_src / "index.html").is_file():
        die(f"Missing game index.html: {game_src / 'index.html'}")
    if out_dir.exists():
        shutil.rmtree(out_dir)
    shutil.copytree(game_src, out_dir)


def compute_story_stamp(story: dict[str, Path]) -> str:
    """Stable content hash so hosts can detect stale App Support story/."""
    digest = hashlib.sha256()
    for key in ("autopilot", "i18n", "map_graph"):
        digest.update(key.encode("utf-8"))
        digest.update(b"\0")
        digest.update(story[key].read_bytes())
        digest.update(b"\0")
    for src in sorted(story["scripts"].glob("*.json")):
        digest.update(src.name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(src.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def write_bastion_stamp(story_out: Path, story: dict[str, Path]) -> Path:
    stamp_path = story_out / BASTION_STAMP_NAME
    stamp_path.write_text(compute_story_stamp(story) + "\n", encoding="utf-8")
    return stamp_path


def overlay_story(out_dir: Path, story: dict[str, Path]) -> None:
    story_out = out_dir / "story"
    scripts_out = story_out / "scripts"
    scripts_out.mkdir(parents=True, exist_ok=True)
    shutil.copy2(story["i18n"], story_out / "i18n.js")
    shutil.copy2(story["autopilot"], story_out / "autopilot.js")
    shutil.copy2(story["map_graph"], story_out / "map_graph.json")
    for src in sorted(story["scripts"].glob("*.json")):
        shutil.copy2(src, scripts_out / src.name)
    stamp_path = write_bastion_stamp(story_out, story)
    print(f"Wrote Bastion stamp: {stamp_path}")


def patch_index_html(root: Path) -> None:
    index_path = root / "index.html"
    html = index_path.read_text(encoding="utf-8")
    hook = """    <script>
      window.__RG_STORY_MODE__ = true;
    </script>
"""
    i18n = '    <script defer src="/story/i18n.js"></script>\n'
    autopilot = '    <script defer src="/story/autopilot.js"></script>\n'
    if "__RG_STORY_MODE__" not in html:
        html = html.replace("</body>", f"{hook}{i18n}{autopilot}  </body>")
    else:
        if "/story/i18n.js" not in html:
            html = html.replace("</body>", f"{i18n}  </body>")
        if "/story/autopilot.js" not in html:
            html = html.replace("</body>", f"{autopilot}  </body>")
    index_path.write_text(html, encoding="utf-8")
    print(f"Patched: {index_path}")


# Minified identifiers change between game builds; match structural patterns instead.
GAME_HOOK_RE = re.compile(
    r"(const e=new Mt\.Game\([A-Za-z0-9_$]+\);)(?!window\.__RG_GAME__)([A-Za-z0-9_$]+\(e\))"
)
NET_HOOK_RE = re.compile(
    r"const (\w+)=new (\w+),(\w+)=Object\.freeze\(Object\.defineProperty"
)
NET_HOOK_ALREADY_RE = re.compile(
    r"const (\w+)=new (\w+);window\.__RG_NET__=\1;const (\w+)=Object\.freeze\(Object\.defineProperty"
)
NET_HOOK_BROKEN_RE = re.compile(
    r"const (\w+)=new (\w+);window\.__RG_NET__=\1,(\w+)=Object\.freeze\(Object\.defineProperty"
)
STATE_HOOK_RE = re.compile(r"const K=(\w+)\(\),(\w+)=new Set")
STATE_HOOK_ALREADY_RE = re.compile(r"const K=\w+\(\);window\.__RG_STATE__=K;const \w+=new Set")
BONUS_HOOK_RE = re.compile(
    r'(\w+)\.onMessage\("bonusBoxCollected",T=>\{e\.onBonusBoxCollected\(T\)\}\)'
)
MAP_DIMS_RE = re.compile(
    r"e\.map_width&&\(K\.mapWidth=e\.map_width\),e\.map_height&&\(K\.mapHeight=e\.map_height\)"
)
MAP_DIMS_ALREADY = "window.__RG_MAP_W__"


def _patch_game_hook(text: str) -> tuple[str, str | None]:
    if "window.__RG_GAME__=e" in text and GAME_HOOK_RE.search(text) is None:
        return text, "already"
    if GAME_HOOK_RE.search(text) is None:
        return text, None
    patched = GAME_HOOK_RE.sub(r"\1window.__RG_GAME__=e;\2", text, count=1)
    return patched, "patched"


def _patch_net_hook(text: str) -> tuple[str, str | None]:
    if NET_HOOK_ALREADY_RE.search(text):
        return text, "already"
    broken = NET_HOOK_BROKEN_RE.search(text)
    if broken:
        net_var, cls, freeze_var = broken.groups()
        repl = (
            f"const {net_var}=new {cls};window.__RG_NET__={net_var};"
            f"const {freeze_var}=Object.freeze(Object.defineProperty"
        )
        return NET_HOOK_BROKEN_RE.sub(repl, text, count=1), "fixed"
    m = NET_HOOK_RE.search(text)
    if not m:
        return text, None
    net_var, cls, freeze_var = m.groups()
    repl = (
        f"const {net_var}=new {cls};window.__RG_NET__={net_var};"
        f"const {freeze_var}=Object.freeze(Object.defineProperty"
    )
    return NET_HOOK_RE.sub(repl, text, count=1), "patched"


def _patch_state_hook(text: str) -> tuple[str, str | None]:
    if STATE_HOOK_ALREADY_RE.search(text):
        return text, "already"
    m = STATE_HOOK_RE.search(text)
    if not m:
        return text, None
    factory, set_var = m.groups()
    repl = f"const K={factory}();window.__RG_STATE__=K;const {set_var}=new Set"
    return text.replace(m.group(0), repl, 1), "patched"


def _patch_bonus_hook(text: str) -> tuple[str, str | None]:
    if "window.__RG_STORY_ON_BONUS__" in text:
        return text, "already"
    m = BONUS_HOOK_RE.search(text)
    if not m:
        return text, None
    net_var = m.group(1)
    repl = (
        f'{net_var}.onMessage("bonusBoxCollected",T=>{{e.onBonusBoxCollected(T),'
        "window.__RG_STORY_ON_BONUS__?.(T)})"
    )
    return BONUS_HOOK_RE.sub(repl, text, count=1), "patched"


def _patch_map_dims(text: str) -> tuple[str, str | None]:
    if MAP_DIMS_ALREADY in text:
        return text, "already"
    if MAP_DIMS_RE.search(text) is None:
        return text, None
    repl = (
        "e.map_width&&(K.mapWidth=e.map_width,window.__RG_MAP_W__=e.map_width),"
        "e.map_height&&(K.mapHeight=e.map_height,window.__RG_MAP_H__=e.map_height)"
    )
    return MAP_DIMS_RE.sub(repl, text, count=1), "patched"


def patch_one_asset(js_path: Path) -> dict[str, str]:
    """Patch hooks in one JS chunk. Returns status map for hooks that apply."""
    text = js_path.read_text(encoding="utf-8")
    # Skip tiny secondary chunks that never contain the Phaser bootstrap.
    if "new Mt.Game(" not in text and "bonusBoxCollected" not in text and "map_width" not in text:
        return {}

    results: dict[str, str] = {}
    writers = (
        ("game", _patch_game_hook),
        ("net", _patch_net_hook),
        ("state", _patch_state_hook),
        ("bonus", _patch_bonus_hook),
        ("map", _patch_map_dims),
    )
    changed = False
    for name, fn in writers:
        text, status = fn(text)
        if status:
            results[name] = status
            if status in ("patched", "fixed"):
                changed = True
                print(f"{status.capitalize()} {name} hook: {js_path}")
            else:
                print(f"{name.capitalize()} hook already present: {js_path}")

    if changed:
        js_path.write_text(text, encoding="utf-8")
    return results


def patch_asset_hooks(root: Path) -> None:
    assets = root / "assets"
    if not assets.is_dir():
        die(
            f"Missing assets directory: {assets}\n"
            "Extraction likely failed before Bastion patching (check brotli / update logs)."
        )

    js_files = sorted(assets.glob("index-*.js"))
    if not js_files:
        die(f"No assets/index-*.js found under {assets} (incomplete extraction)")

    # Prefer largest main bundle first (Vite entry chunk).
    js_files.sort(key=lambda p: p.stat().st_size, reverse=True)

    merged: dict[str, str] = {}
    for js_path in js_files:
        for key, status in patch_one_asset(js_path).items():
            merged.setdefault(key, status)

    required = ("game", "net", "state")
    missing = [name for name in required if name not in merged]
    if missing:
        die(
            "Bastion game hooks failed — autopilot cannot detect readiness "
            f"(missing: {', '.join(missing)}). "
            "Game JS layout may have changed; update apply_bastion_patches.py needles."
        )


def apply_patches(out_dir: Path, story_src: Path) -> None:
    story = resolve_story_files(story_src)
    overlay_story(out_dir, story)
    patch_index_html(out_dir)
    patch_asset_hooks(out_dir)
    if not (out_dir / "story" / "autopilot.js").is_file():
        die("Bastion patch failed: story/autopilot.js missing after overlay")
    if "__RG_STORY_MODE__" not in (out_dir / "index.html").read_text(encoding="utf-8"):
        die("Bastion patch failed: __RG_STORY_MODE__ missing from index.html")
    print(f"Bastion patches applied: {out_dir}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Apply Bastion story overlays and game hooks")
    parser.add_argument("--game-src", type=Path, help="Extracted official game web root")
    parser.add_argument("--story-src", type=Path, required=True, help="Bastion story source directory")
    parser.add_argument("--out", type=Path, help="Destination web root (copied from --game-src)")
    parser.add_argument("--in-place", type=Path, help="Patch an existing web root in place")
    args = parser.parse_args()

    if args.in_place:
        out_dir = args.in_place.resolve()
        if not (out_dir / "index.html").is_file():
            die(f"Missing index.html in --in-place: {out_dir}")
        apply_patches(out_dir, args.story_src.resolve())
        return 0

    if not args.game_src or not args.out:
        die("Provide --game-src and --out, or --in-place")

    game_src = args.game_src.resolve()
    out_dir = args.out.resolve()
    copy_game_tree(game_src, out_dir)
    apply_patches(out_dir, args.story_src.resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

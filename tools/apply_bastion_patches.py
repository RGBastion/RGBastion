#!/usr/bin/env python3
"""Apply Bastion/story overlays and game hooks onto extracted RedGalaxy web assets.

Usage:
  apply_bastion_patches.py --game-src DIR --story-src DIR --out DIR [--brand redgalaxy|reduniverse]
  apply_bastion_patches.py --in-place DIR --story-src DIR [--brand redgalaxy|reduniverse]

Story sources expected under --story-src:
  i18n.js | redgalaxy_story_autopilot.js | map_graph.json | scripts/*.json
  OR already-normalized: i18n.js | autopilot.js | map_graph.json | scripts/*.json

Canonical story sources use RedUniverse display strings. Pass --brand redgalaxy to
rewrite product UI strings to RedGalaxy before writing the overlay (never ships
RedUniverse Bastion chrome inside a RedGalaxy Bastion app).
"""
from __future__ import annotations

import argparse
import hashlib
import re
import shutil
import sys
from pathlib import Path

BASTION_STAMP_NAME = ".bastion-stamp"
VALID_BRANDS = ("redgalaxy", "reduniverse")

# Canonical story tree is authored as RedUniverse; rewrite for the twin brand.
_BRANDIFY_PHRASES = (
    ("RedUniverse Bastion", "RedGalaxy Bastion"),
    ("official RedUniverse web assets", "official RedGalaxy web assets"),
    ("ufficiali RedUniverse", "ufficiali RedGalaxy"),
    ("oficiales de RedUniverse", "oficiales de RedGalaxy"),
    # Story helper API hosts must follow the game brand (not UI-only rename).
    ("aws-prod-api.reduniverse.space", "aws-prod-api.redgalaxygame.space"),
    ("aws-test-api.reduniverse.space", "aws-api.redgalaxygame.space"),
    ("ticket.reduniverse.space", "www.redgalaxygame.space"),
    # Any remaining domain references (comments, docs) — never leave RU hosts in RG.
    ("reduniverse.space", "redgalaxygame.space"),
)
# Remaining product-name tokens that are not domains (reduniverse.space etc.).
_BRANDIFY_NAME_RE = re.compile(r"RedUniverse(?!\.(?:space|com|io|net|org)\b)")

# Game payload identity — package name is still "redgalaxy-client@" for both;
# distinguish by live API hosts embedded in the Vite entry chunk.
_RG_API_MARKERS = ("aws-prod-api.redgalaxygame.space", "aws-api.redgalaxygame.space")
_RU_API_MARKERS = ("aws-prod-api.reduniverse.space", "aws-test-api.reduniverse.space")


def die(msg: str) -> None:
    print(msg, file=sys.stderr)
    raise SystemExit(1)


def _main_asset_text(root: Path) -> str:
    index_path = root / "index.html"
    if not index_path.is_file():
        return ""
    html = index_path.read_text(encoding="utf-8", errors="ignore")
    m = re.search(r"""/assets/(index-[^"'>\s]+\.js)""", html)
    if not m:
        return ""
    asset = root / "assets" / m.group(1)
    if not asset.is_file():
        return ""
    return asset.read_text(encoding="utf-8", errors="ignore")


def assert_game_matches_brand(root: Path, brand: str) -> None:
    """Refuse to ship the twin game under the wrong Bastion brand."""
    js = _main_asset_text(root)
    if not js:
        die(f"Cannot verify game brand for {root}: missing index.html entry asset")
    if brand == "redgalaxy":
        if any(m in js for m in _RU_API_MARKERS):
            die(
                f"Refusing RedGalaxy Bastion build: game web at {root} talks to "
                "reduniverse.space APIs. Extract RedGalaxy-Setup.exe / redgalaxy-client.exe instead."
            )
        if not any(m in js for m in _RG_API_MARKERS):
            die(
                f"Refusing RedGalaxy Bastion build: game web at {root} has no "
                "redgalaxygame.space API hosts."
            )
    elif brand == "reduniverse":
        if any(m in js for m in _RG_API_MARKERS):
            die(
                f"Refusing RedUniverse Bastion build: game web at {root} talks to "
                "redgalaxygame.space APIs. Extract RedUniverse setup / reduniverse-pc-client.exe instead."
            )
        if not any(m in js for m in _RU_API_MARKERS):
            die(
                f"Refusing RedUniverse Bastion build: game web at {root} has no "
                "reduniverse.space API hosts."
            )
    else:
        die(f"Unknown brand for game identity check: {brand}")


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


def brandify_text(text: str, brand: str) -> str:
    """Rewrite canonical RedUniverse UI chrome to the target product brand."""
    if brand == "reduniverse":
        return text
    if brand != "redgalaxy":
        die(f"Unknown brand for story rewrite: {brand}")
    for src, dst in _BRANDIFY_PHRASES:
        text = text.replace(src, dst)
    text = _BRANDIFY_NAME_RE.sub("RedGalaxy", text)
    return text


def write_text_branded(src: Path, dst: Path, brand: str) -> None:
    raw = src.read_text(encoding="utf-8")
    dst.write_text(brandify_text(raw, brand), encoding="utf-8")


def write_bastion_stamp_from_dir(story_out: Path) -> Path:
    """Hash the on-disk story overlay (post-brandify) so App Support sync is brand-aware."""
    digest = hashlib.sha256()
    for name in ("autopilot.js", "i18n.js", "map_graph.json"):
        path = story_out / name
        digest.update(name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    scripts_out = story_out / "scripts"
    if scripts_out.is_dir():
        for src in sorted(scripts_out.glob("*.json")):
            digest.update(src.name.encode("utf-8"))
            digest.update(b"\0")
            digest.update(src.read_bytes())
            digest.update(b"\0")
    stamp_path = story_out / BASTION_STAMP_NAME
    stamp_path.write_text(digest.hexdigest() + "\n", encoding="utf-8")
    return stamp_path


def write_bastion_stamp(story_out: Path, story: dict[str, Path]) -> Path:
    stamp_path = story_out / BASTION_STAMP_NAME
    stamp_path.write_text(compute_story_stamp(story) + "\n", encoding="utf-8")
    return stamp_path


def overlay_story(out_dir: Path, story: dict[str, Path], brand: str) -> None:
    story_out = out_dir / "story"
    scripts_out = story_out / "scripts"
    scripts_out.mkdir(parents=True, exist_ok=True)
    write_text_branded(story["i18n"], story_out / "i18n.js", brand)
    write_text_branded(story["autopilot"], story_out / "autopilot.js", brand)
    shutil.copy2(story["map_graph"], story_out / "map_graph.json")
    for src in sorted(story["scripts"].glob("*.json")):
        shutil.copy2(src, scripts_out / src.name)
    stamp_path = write_bastion_stamp_from_dir(story_out)
    print(f"Wrote Bastion stamp ({brand}): {stamp_path}")
    if brand == "redgalaxy":
        for check in (story_out / "i18n.js", story_out / "autopilot.js"):
            text = check.read_text(encoding="utf-8")
            if "RedUniverse Bastion" in text:
                die(f"Brand leak: {check} still contains 'RedUniverse Bastion' after redgalaxy rewrite")
            if '"app.title": "RedGalaxy Bastion"' not in text and check.name == "i18n.js":
                die(f"Brand rewrite failed: {check} missing RedGalaxy Bastion app.title")


def patch_index_html(root: Path, brand: str) -> None:
    index_path = root / "index.html"
    html = index_path.read_text(encoding="utf-8")
    product = "RedGalaxy Bastion" if brand == "redgalaxy" else "RedUniverse Bastion"
    base = "RedGalaxy" if brand == "redgalaxy" else "RedUniverse"
    hook = f"""    <script>
      window.__RG_STORY_MODE__ = true;
      window.__BASTION_BRAND__ = "{brand}";
      window.__BASTION_BASE_NAME__ = "{base}";
      window.__BASTION_PRODUCT_NAME__ = "{product}";
    </script>
"""
    i18n = '    <script defer src="/story/i18n.js"></script>\n'
    autopilot = '    <script defer src="/story/autopilot.js"></script>\n'
    # Keep <title> aligned with the product the user launched.
    html = re.sub(
        r"<title>[^<]*</title>",
        f"<title>{product}</title>",
        html,
        count=1,
        flags=re.IGNORECASE,
    )
    if "__RG_STORY_MODE__" not in html:
        html = html.replace("</body>", f"{hook}{i18n}{autopilot}  </body>")
    else:
        # Refresh brand globals when re-patching an existing tree.
        html = re.sub(
            r"<script>\s*window\.__RG_STORY_MODE__\s*=\s*true;[\s\S]*?</script>",
            hook.strip(),
            html,
            count=1,
        )
        if "/story/i18n.js" not in html:
            html = html.replace("</body>", f"{i18n}  </body>")
        if "/story/autopilot.js" not in html:
            html = html.replace("</body>", f"{autopilot}  </body>")
    index_path.write_text(html, encoding="utf-8")
    print(f"Patched: {index_path} (brand={brand})")


# Minified identifiers change between game builds; match structural patterns instead.
# 0.6.23: Phaser ns Mt→Ct, game state K→W, bonus callback T→S — keep needles identifier-agnostic.
GAME_HOOK_RE = re.compile(
    r"(const e=new \w+\.Game\([A-Za-z0-9_$]+\);)(?!window\.__RG_GAME__)([A-Za-z0-9_$]+\(e\))"
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
# Prefer unique game-state marker; fallback = factory() + listener Set with .add.
STATE_HOOK_RE = re.compile(
    r"(preservedLocalSlow:null\}\})const (\w+)=(\w+)\(\),(\w+)=new Set"
)
STATE_HOOK_FALLBACK_RE = re.compile(
    r"const (\w+)=(\w+)\(\),(\w+)=new Set;function (\w+)\((\w+)\)\{\3\.add"
)
STATE_HOOK_ALREADY_RE = re.compile(
    r"const (\w+)=\w+\(\);window\.__RG_STATE__=\1;const \w+=new Set"
)
BONUS_HOOK_RE = re.compile(
    r'(\w+)\.onMessage\("bonusBoxCollected",(\w+)=>\{e\.onBonusBoxCollected\(\2\)\}\)'
)
MAP_DIMS_RE = re.compile(
    r"(\w+)\.map_width&&\((\w+)\.mapWidth=\1\.map_width\),\1\.map_height&&\(\2\.mapHeight=\1\.map_height\)"
)
MAP_DIMS_ALREADY = "window.__RG_MAP_W__"
GAME_BOOTSTRAP_RE = re.compile(r"new \w+\.Game\(")


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
    if m:
        prefix, state_var, factory, set_var = m.groups()
        repl = (
            f"{prefix}const {state_var}={factory}();"
            f"window.__RG_STATE__={state_var};const {set_var}=new Set"
        )
        return text.replace(m.group(0), repl, 1), "patched"
    m = STATE_HOOK_FALLBACK_RE.search(text)
    if not m:
        return text, None
    state_var, factory, set_var, fn_name, arg = m.groups()
    repl = (
        f"const {state_var}={factory}();window.__RG_STATE__={state_var};"
        f"const {set_var}=new Set;function {fn_name}({arg}){{{set_var}.add"
    )
    return text.replace(m.group(0), repl, 1), "patched"


def _patch_bonus_hook(text: str) -> tuple[str, str | None]:
    if "window.__RG_STORY_ON_BONUS__" in text:
        return text, "already"
    m = BONUS_HOOK_RE.search(text)
    if not m:
        return text, None
    net_var, arg = m.groups()
    repl = (
        f'{net_var}.onMessage("bonusBoxCollected",{arg}=>{{e.onBonusBoxCollected({arg}),'
        f"window.__RG_STORY_ON_BONUS__?.({arg})}})"
    )
    return text.replace(m.group(0), repl, 1), "patched"


def _patch_map_dims(text: str) -> tuple[str, str | None]:
    if MAP_DIMS_ALREADY in text:
        return text, "already"
    m = MAP_DIMS_RE.search(text)
    if m is None:
        return text, None
    msg_var, state_var = m.groups()
    repl = (
        f"{msg_var}.map_width&&({state_var}.mapWidth={msg_var}.map_width,"
        f"window.__RG_MAP_W__={msg_var}.map_width),"
        f"{msg_var}.map_height&&({state_var}.mapHeight={msg_var}.map_height,"
        f"window.__RG_MAP_H__={msg_var}.map_height)"
    )
    return text.replace(m.group(0), repl, 1), "patched"


def patch_one_asset(js_path: Path) -> dict[str, str]:
    """Patch hooks in one JS chunk. Returns status map for hooks that apply."""
    text = js_path.read_text(encoding="utf-8")
    # Skip tiny secondary chunks that never contain the Phaser bootstrap.
    if (
        GAME_BOOTSTRAP_RE.search(text) is None
        and "bonusBoxCollected" not in text
        and "map_width" not in text
    ):
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


def apply_patches(out_dir: Path, story_src: Path, brand: str) -> None:
    if brand not in VALID_BRANDS:
        die(f"Unknown --brand '{brand}' (use {'|'.join(VALID_BRANDS)})")
    assert_game_matches_brand(out_dir, brand)
    story = resolve_story_files(story_src)
    overlay_story(out_dir, story, brand)
    patch_index_html(out_dir, brand)
    patch_asset_hooks(out_dir)
    if not (out_dir / "story" / "autopilot.js").is_file():
        die("Bastion patch failed: story/autopilot.js missing after overlay")
    html = (out_dir / "index.html").read_text(encoding="utf-8")
    if "__RG_STORY_MODE__" not in html:
        die("Bastion patch failed: __RG_STORY_MODE__ missing from index.html")
    if f'__BASTION_BRAND__ = "{brand}"' not in html and f"__BASTION_BRAND__ = '{brand}'" not in html:
        die(f"Bastion patch failed: __BASTION_BRAND__={brand} missing from index.html")
    # Re-check after overlay: game entry chunk must still match brand (story rewrite
    # must not be confused with swapping the game).
    assert_game_matches_brand(out_dir, brand)
    if brand == "redgalaxy":
        auto = (out_dir / "story" / "autopilot.js").read_text(encoding="utf-8")
        if "reduniverse.space" in auto:
            die("Brand leak: story/autopilot.js still references reduniverse.space under redgalaxy")
    print(f"Bastion patches applied: {out_dir} (brand={brand})")


def infer_brand_from_story_src(story_src: Path) -> str | None:
    """When host re-patches App Support from a bundled story/, detect brand from files."""
    for name in ("i18n.js", "autopilot.js"):
        path = story_src / name
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        if "RedGalaxy Bastion" in text and "RedUniverse Bastion" not in text:
            return "redgalaxy"
        if "RedUniverse Bastion" in text:
            return "reduniverse"
        if "RedGalaxy Bastion" in text:
            return "redgalaxy"
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description="Apply Bastion story overlays and game hooks")
    parser.add_argument("--game-src", type=Path, help="Extracted official game web root")
    parser.add_argument("--story-src", type=Path, required=True, help="Bastion story source directory")
    parser.add_argument("--out", type=Path, help="Destination web root (copied from --game-src)")
    parser.add_argument("--in-place", type=Path, help="Patch an existing web root in place")
    parser.add_argument(
        "--brand",
        choices=VALID_BRANDS,
        default=None,
        help="Product brand for UI strings (required for clean dual builds; inferred from story-src when omitted)",
    )
    args = parser.parse_args()

    brand = args.brand
    story_src = args.story_src.resolve()
    if brand is None:
        brand = infer_brand_from_story_src(story_src) or "reduniverse"
        print(f"Inferred Bastion brand={brand} from story-src", file=sys.stderr)

    if args.in_place:
        out_dir = args.in_place.resolve()
        if not (out_dir / "index.html").is_file():
            die(f"Missing index.html in --in-place: {out_dir}")
        apply_patches(out_dir, story_src, brand)
        return 0

    if not args.game_src or not args.out:
        die("Provide --game-src and --out, or --in-place")

    game_src = args.game_src.resolve()
    out_dir = args.out.resolve()
    copy_game_tree(game_src, out_dir)
    apply_patches(out_dir, story_src, brand)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

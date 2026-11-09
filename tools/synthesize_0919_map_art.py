#!/usr/bin/env python3
"""Synthesize / restore 0.9.19+ map art missing from encrypted RGPAK packs.

Creates the files the client actually requests (pyro_walls.webp/json, ab_*.webp,
real PNG fogs, named worldProps, wiki map backgrounds) instead of only same-name
donor tree copies.

Usage:
  python3 tools/synthesize_0919_map_art.py /path/to/web [/path/to/web2 ...]
  python3 tools/synthesize_0919_map_art.py --default-roots
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageEnhance, ImageOps

SCRIPT_DIR = Path(__file__).resolve().parent
CACHE = SCRIPT_DIR / "asset-cache"
WIKI_CACHE = CACHE / "wiki-maps"
SYNTH_CACHE = CACHE / "synthesized-0919"


def is_jpeg(path: Path) -> bool:
    try:
        return path.read_bytes()[:3] == b"\xff\xd8\xff"
    except Exception:
        return False


def is_png(path: Path) -> bool:
    try:
        return path.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"
    except Exception:
        return False


def ensure_dir(p: Path) -> None:
    p.mkdir(parents=True, exist_ok=True)


def save_webp(im: Image.Image, dst: Path, quality: int = 80) -> None:
    ensure_dir(dst.parent)
    tmp = dst.with_suffix(".png")
    im.save(tmp, "PNG")
    try:
        subprocess.check_call(
            ["cwebp", "-q", str(quality), str(tmp), "-o", str(dst)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        im.save(dst, "WEBP", quality=quality, method=4)
    tmp.unlink(missing_ok=True)


def copy_tree_file(src: Path, dst: Path, overwrite: bool = False) -> bool:
    if not src.is_file() or src.stat().st_size <= 0:
        return False
    if dst.is_file() and dst.stat().st_size > 0 and not overwrite:
        return False
    ensure_dir(dst.parent)
    shutil.copy2(src, dst)
    return True


def install_cached_synth(maps: Path) -> None:
    cached = SYNTH_CACHE / "maps"
    if not cached.is_dir():
        return
    for src in cached.rglob("*"):
        if not src.is_file():
            continue
        rel = src.relative_to(cached)
        dst = maps / rel
        # Always refresh walls/ab/fog from cache when present (authoritative synth).
        overwrite = any(
            part in str(rel)
            for part in ("pyro_walls", "ab_", "fog_ash", "core_fog")
        )
        if copy_tree_file(src, dst, overwrite=overwrite):
            print(f"cache→ {dst}")


def install_wiki_bgs(maps: Path) -> None:
    mapping = {
        "map22": "map22.jpg",
        "map23": "map23.jpg",
        "map24": "map24.jpg",
        "pyro_core": "pyro_core.jpg",
        "pyro_2": "pyro_2.jpg",
    }
    for folder, name in mapping.items():
        src = WIKI_CACHE / name
        if not src.is_file() or src.stat().st_size < 1000:
            continue
        dst = maps / folder / "bg.jpg"
        ensure_dir(dst.parent)
        shutil.copy2(src, dst)
        print(f"wiki bg {folder} {dst.stat().st_size}")


def fix_fogs(maps: Path) -> None:
    jobs = [
        ("pyro", "fog_ash_a.png", ["map19/dust_ember.png", "map20/dust_gold.png"]),
        ("pyro", "fog_ash_b.png", ["map19/dust_crimson.png", "map20/dust_blue.png"]),
        ("pyro", "fog_ash_c.png", ["map21/dust_mist.png", "map19/dust_ember.png"]),
        ("pyro_core", "core_fog_a.png", ["map21/dust_jade.png", "map19/dust_ember.png"]),
        ("pyro_core", "core_fog_b.png", ["map21/dust_mist.png", "map20/dust_blue.png"]),
        ("pyro_2", "fog_ash_a.png", ["map19/dust_ember.png"]),
        ("pyro_2", "fog_ash_b.png", ["map19/dust_crimson.png"]),
    ]
    for folder, name, donors in jobs:
        dst = maps / folder / name
        if dst.is_file() and is_png(dst) and not is_jpeg(dst):
            continue
        src = None
        for d in donors:
            p = maps / d
            if p.is_file() and is_png(p):
                src = p
                break
        if not src:
            continue
        im = Image.open(src).convert("RGBA")
        ensure_dir(dst.parent)
        im.save(dst, "PNG", optimize=True)
        print(f"fog {dst} from {src.name}")


def load_hl_frames(web_root: Path):
    js_files = list((web_root / "assets").glob("index-*.js"))
    if not js_files:
        return None
    text = js_files[0].read_text(errors="ignore")
    i = text.find('const hl={version:"pyro_walls_v3')
    if i < 0:
        return None
    start = text.find("{", i)
    depth = 0
    end = None
    for j, c in enumerate(text[start:], start):
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                end = j + 1
                break
    if end is None:
        return None
    # Evaluate via node for fidelity
    tmp = Path("/tmp/hl_eval.js")
    tmp.write_text(
        "const hl="
        + text[start:end]
        + ";\nconsole.log(JSON.stringify({page:hl.page,scale:hl.ATLAS_SCALE||2,"
        "frames:Object.fromEntries(Object.entries(hl.frames).map(([k,v])=>[k,v.atlas])),"
        "kinds:Object.fromEntries(Object.entries(hl.frames).map(([k,v])=>[k,v.kind||'']))}))\n"
    )
    out = subprocess.check_output(["node", str(tmp)], text=True)
    return json.loads(out)


def build_pyro_walls(maps: Path, web_root: Path) -> None:
    pyro = maps / "pyro"
    dst_webp = pyro / "pyro_walls.webp"
    dst_json = pyro / "pyro_walls.json"
    if dst_webp.is_file() and dst_webp.stat().st_size > 100_000 and dst_json.is_file():
        return
    # Prefer cache
    c_webp = SYNTH_CACHE / "maps/pyro/pyro_walls.webp"
    c_json = SYNTH_CACHE / "maps/pyro/pyro_walls.json"
    if c_webp.is_file() and c_json.is_file():
        copy_tree_file(c_webp, dst_webp, overwrite=True)
        copy_tree_file(c_json, dst_json, overwrite=True)
        print(f"pyro_walls from cache {dst_webp.stat().st_size}")
        return
    hl = load_hl_frames(web_root)
    if not hl:
        print("WARN: cannot build pyro_walls (no hl frames)")
        return
    walls = [p for p in sorted(pyro.glob("pyro_wall_*.png")) if " " not in p.name]
    if not walls:
        print("WARN: no pyro_wall_*.png donors")
        return
    scale = int(hl.get("scale") or 2)
    page_w, page_h = hl["page"]["w"], hl["page"]["h"]
    tex_w, tex_h = page_w * scale, page_h * scale
    sheets = [Image.open(p).convert("RGBA") for p in walls]
    canvas = Image.new("RGBA", (tex_w, tex_h), (0, 0, 0, 0))
    frames = {}
    for i, (name, atlas) in enumerate(hl["frames"].items()):
        x, y, w, h = [int(v) * scale for v in atlas]
        sheet = sheets[i % len(sheets)]
        cover = ImageOps.fit(sheet, (w, h), Image.Resampling.LANCZOS, centering=(0.5, 0.5))
        kind = (hl.get("kinds") or {}).get(name, "strip")
        if kind in ("fringe", "chip"):
            cover = ImageEnhance.Brightness(cover).enhance(1.1)
        tile = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        tile.paste(cover, (0, 0))
        canvas.paste(tile, (x, y), tile)
        frames[name] = {
            "frame": {"x": x, "y": y, "w": w, "h": h},
            "rotated": False,
            "trimmed": False,
            "spriteSourceSize": {"x": 0, "y": 0, "w": w, "h": h},
            "sourceSize": {"w": w, "h": h},
        }
    save_webp(canvas, dst_webp, quality=75)
    meta = {
        "app": "Bastion",
        "version": "1.0",
        "image": "pyro_walls.webp",
        "format": "RGBA8888",
        "size": {"w": tex_w, "h": tex_h},
        "scale": "1",
    }
    dst_json.write_text(json.dumps({"frames": frames, "meta": meta}, separators=(",", ":")))
    print(f"built pyro_walls {dst_webp.stat().st_size} frames={len(frames)}")
    # refresh cache
    ensure_dir(SYNTH_CACHE / "maps/pyro")
    shutil.copy2(dst_webp, SYNTH_CACHE / "maps/pyro/pyro_walls.webp")
    shutil.copy2(dst_json, SYNTH_CACHE / "maps/pyro/pyro_walls.json")


def build_ab(maps: Path) -> None:
    pyro = maps / "pyro"
    body_src = next(
        (
            p
            for p in [
                maps / "map19/containers_body.png",
                maps / "map21/radar_body.png",
                maps / "map19/relay_body.png",
            ]
            if p.is_file()
        ),
        None,
    )
    glow_src = next(
        (
            p
            for p in [
                maps / "map19/containers_glow.png",
                maps / "map21/radar_glow.png",
                maps / "map19/relay_glow.png",
            ]
            if p.is_file()
        ),
        None,
    )
    if body_src and (
        not (pyro / "ab_body.webp").is_file()
        or (pyro / "ab_body.webp").stat().st_size < 10_000
    ):
        im = Image.open(body_src).convert("RGBA")
        r, g, b, a = im.split()
        r = r.point(lambda v: min(255, int(v * 1.2 + 15)))
        g = g.point(lambda v: int(v * 0.7))
        b = b.point(lambda v: int(v * 0.5))
        save_webp(Image.merge("RGBA", (r, g, b, a)), pyro / "ab_body.webp", 85)
        print("ab_body", (pyro / "ab_body.webp").stat().st_size)
    if glow_src and (
        not (pyro / "ab_glow.webp").is_file()
        or (pyro / "ab_glow.webp").stat().st_size < 1_000
    ):
        save_webp(Image.open(glow_src).convert("RGBA"), pyro / "ab_glow.webp", 85)
    donors = {
        "radar": maps / "map21/radar_dish.png",
        "tur3": maps / "map21/far_pylon_sg03_body.png",
        "tur2": maps / "map21/far_pylon_sg02_body.png",
        "tur1": maps / "map21/far_pylon_sg01_body.png",
        "lights": maps / "map19/holosign_glow.png",
    }
    for name, src in donors.items():
        if not src.is_file():
            continue
        webp = pyro / f"ab_{name}.webp"
        js = pyro / f"ab_{name}.json"
        if webp.is_file() and js.is_file() and webp.stat().st_size > 500:
            continue
        im = Image.open(src).convert("RGBA")
        w, h = im.size
        save_webp(im, webp, 85)
        frames = {
            name: {
                "frame": {"x": 0, "y": 0, "w": w, "h": h},
                "rotated": False,
                "trimmed": False,
                "spriteSourceSize": {"x": 0, "y": 0, "w": w, "h": h},
                "sourceSize": {"w": w, "h": h},
            }
        }
        meta = {
            "app": "Bastion",
            "version": "1.0",
            "image": webp.name,
            "format": "RGBA8888",
            "size": {"w": w, "h": h},
            "scale": "1",
        }
        js.write_text(json.dumps({"frames": frames, "meta": meta}, separators=(",", ":")))


def alias_named_missing(maps: Path, web_root: Path) -> None:
    js_files = list((web_root / "assets").glob("index-*.js"))
    if not js_files:
        return
    text = js_files[0].read_text(errors="ignore")
    pool = {p.name: p for p in maps.rglob("*") if p.is_file() and " " not in p.name}
    semantic = {
        "crystal_a_body.png": ["containers_body.png", "relay_body.png"],
        "crystal_a_glow.png": ["containers_glow.png", "relay_glow.png"],
        "crystal_a_mir_body.png": ["containers_body.png"],
        "crystal_a_mir_glow.png": ["containers_glow.png"],
        "crystal_b_body.png": ["far_shipyard_body.png", "containers_body.png"],
        "crystal_b_glow.png": ["far_shipyard_glow.png", "containers_glow.png"],
        "crystal_b_mir_body.png": ["far_shipyard_body.png"],
        "crystal_b_mir_glow.png": ["far_shipyard_glow.png"],
        "monolith_body.png": ["relay_body.png", "far_station_body.png"],
        "monolith_glow.png": ["relay_glow.png", "far_station_glow.png"],
        "monolith_mir_body.png": ["relay_body.png"],
        "monolith_mir_glow.png": ["relay_glow.png"],
        "spire_a_body.png": ["far_pylon_sg01_body.png", "far_probe_a_body.png"],
        "spire_a_glow.png": ["far_pylon_sg01_glow.png", "far_probe_a_glow.png"],
        "spire_a_mir_body.png": ["far_pylon_sg01_body.png"],
        "spire_a_mir_glow.png": ["far_pylon_sg01_glow.png"],
        "spire_b_body.png": ["far_pylon_sg02_body.png"],
        "spire_b_glow.png": ["far_pylon_sg02_glow.png"],
        "spire_b_mir_body.png": ["far_pylon_sg02_body.png"],
        "spire_b_mir_glow.png": ["far_pylon_sg02_glow.png"],
        "spire_c_body.png": ["far_pylon_sg03_body.png"],
        "spire_c_glow.png": ["far_pylon_sg03_glow.png"],
        "spire_c_mir_body.png": ["far_pylon_sg03_body.png"],
        "spire_c_mir_glow.png": ["far_pylon_sg03_glow.png"],
        "comet_a_body.png": ["far_probe_a_body.png"],
        "comet_a_glow.png": ["far_probe_a_glow.png"],
        "comet_a_tail_body.png": ["far_probe_a_body.png"],
        "comet_b_body.png": ["far_probe_b_body.png"],
        "comet_b_glow.png": ["far_probe_b_glow.png"],
        "comet_b_tail_body.png": ["far_probe_b_body.png"],
        "comet_c_body.png": ["far_probe_c_body.png"],
        "comet_c_glow.png": ["far_probe_c_glow.png"],
        "comet_c_tail_body.png": ["far_probe_c_body.png"],
        "harvester_body.png": ["far_station_body.png", "far_outpost_body.png"],
        "harvester_glow.png": ["far_station_glow.png", "far_outpost_glow.png"],
        "collector_body.png": ["far_outpost_body.png"],
        "collector_glow.png": ["far_outpost_glow.png"],
        "ash0_atlas.png": ["dust0_atlas.png"],
        "ash0.json": ["dust0.json"],
        "ash1_atlas.png": ["dust1_atlas.png"],
        "ash1.json": ["dust1.json"],
        "ash2_atlas.png": ["dust2_atlas.png"],
        "ash2.json": ["dust2.json"],
        "ash3_atlas.png": ["dust3_atlas.png"],
        "ash3.json": ["dust3.json"],
        "core_dust0_atlas.png": ["dust0_atlas.png"],
        "core_dust0.json": ["dust0.json"],
        "core_dust1_atlas.png": ["dust1_atlas.png"],
        "core_dust1.json": ["dust1.json"],
        "core_dust2_atlas.png": ["dust2_atlas.png"],
        "core_dust2.json": ["dust2.json"],
        "core_belt_atlas.png": ["belt_near_atlas.png", "dust0_atlas.png"],
        "core_belt.json": ["belt_near.json", "dust0.json"],
        "beacon_body.png": ["holosign_body.png", "relay_body.png"],
        "beacon_glow.png": ["holosign_glow.png", "relay_glow.png"],
        "beacon_a_body.png": ["holosign_body.png"],
        "beacon_a_glow.png": ["holosign_glow.png"],
        "beacon_b_body.png": ["holosign_body.png"],
        "beacon_b_glow.png": ["holosign_glow.png"],
        "beacon_a_flicker.png": ["holosign_glow.png"],
        "beacon_a_flicker.json": ["dust0.json"],
        "beacon_b_flicker.png": ["holosign_glow.png"],
        "beacon_b_flicker.json": ["dust0.json"],
        "dish_body.png": ["radar_body.png", "relay_body.png"],
        "dish_glow.png": ["radar_glow.png", "relay_glow.png"],
        "mast_far_body.png": ["far_pylon_sg01_body.png"],
        "mast_mid_body.png": ["far_pylon_sg02_body.png"],
        "mast_mid_glow.png": ["far_pylon_sg02_glow.png"],
        "pylon_far_body.png": ["far_pylon_sg01_body.png"],
        "pylon_far_glow.png": ["far_pylon_sg01_glow.png"],
        "pylon_mid_body.png": ["far_pylon_sg02_body.png"],
        "pylon_mid_glow.png": ["far_pylon_sg02_glow.png"],
        "relay_dish.png": ["radar_dish.png"],
        "relay_dish.json": ["radar_dish.json"],
        "buoy_body.png": ["far_probe_a_body.png"],
        "buoy_glow.png": ["far_probe_a_glow.png"],
        "wreck_bow_body.png": ["far_tanker_body.png", "containers_body.png"],
        "wreck_bow_glow.png": ["far_tanker_glow.png", "containers_glow.png"],
        "wreck_hulk_body.png": ["far_shipyard_body.png", "containers_body.png"],
        "wreck_hulk_glow.png": ["far_shipyard_glow.png"],
        "wreck_section_body.png": ["far_tanker_rev_body.png", "containers_body.png"],
        "wreck_section_glow.png": ["far_tanker_rev_glow.png"],
        "wreck_stern_body.png": ["far_tanker_body.png"],
        "wreck_stern_glow.png": ["far_tanker_glow.png"],
        "minimap.webp": ["minimap.webp"],
    }
    prefs = {
        "map22": ["map19", "map20", "map21"],
        "map23": ["map20", "map19", "map21"],
        "map24": ["map21", "map20", "map19"],
        "pyro": ["map19", "map20", "map21", "pyro"],
        "pyro_core": ["pyro", "map21", "map20", "map19"],
        "pyro_2": ["pyro", "map19", "map20", "map21"],
    }
    for folder, donor_pref in prefs.items():
        m = re.search(rf'assetFolder:"{folder}"', text)
        if not m:
            continue
        i = m.start()
        depth = 0
        start = None
        for k in range(i, max(0, i - 8000), -1):
            if text[k] == "}":
                depth += 1
            elif text[k] == "{":
                if depth == 0:
                    start = k
                    break
                depth -= 1
        if start is None:
            continue
        depth = 0
        blob = None
        for j, c in enumerate(text[start:], start):
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    blob = text[start : j + 1]
                    break
        if not blob:
            continue
        names = set(re.findall(r'"(?:body|glow|atlas|manifest|minimap)":"([^"]+)"', blob))
        names |= {n for n in re.findall(r'"([A-Za-z0-9_.-]+\.(?:png|jpg|webp|json))"', blob)}
        created = 0
        for name in sorted(names):
            dst = maps / folder / name
            if dst.is_file() and dst.stat().st_size > 0 and not (
                dst.suffix == ".png" and is_jpeg(dst)
            ):
                continue
            src = None
            for pref in donor_pref:
                cand = maps / pref / name
                if cand.is_file() and cand.stat().st_size > 0 and not (
                    cand.suffix == ".png" and is_jpeg(cand)
                ):
                    src = cand
                    break
            if src is None:
                for alt in semantic.get(name, []):
                    for pref in donor_pref + ["map19", "map20", "map21", "map3"]:
                        cand = maps / pref / alt
                        if cand.is_file() and cand.stat().st_size > 0:
                            src = cand
                            break
                    if src:
                        break
                    if alt in pool:
                        src = pool[alt]
                        break
            if src is None and name in pool:
                src = pool[name]
            if src is None:
                if name.endswith("_body.png") and "containers_body.png" in pool:
                    src = pool["containers_body.png"]
                elif name.endswith("_glow.png") and "containers_glow.png" in pool:
                    src = pool["containers_glow.png"]
                elif name.endswith(".json") and "dust0.json" in pool:
                    src = pool["dust0.json"]
                elif name.endswith("_atlas.png") and "dust0_atlas.png" in pool:
                    src = pool["dust0_atlas.png"]
            if src is None:
                continue
            ensure_dir(dst.parent)
            if dst.suffix.lower() == ".webp" and src.suffix.lower() != ".webp":
                save_webp(Image.open(src).convert("RGBA"), dst, 85)
            elif dst.suffix.lower() == ".png" and is_jpeg(src):
                Image.open(src).convert("RGBA").save(dst, "PNG", optimize=True)
            else:
                shutil.copy2(src, dst)
            created += 1
        print(f"alias {folder}: {created}")


def process_web_root(web_root: Path) -> None:
    maps = web_root / "maps"
    if not maps.is_dir():
        print(f"skip (no maps): {web_root}")
        return
    print(f"\n==== {web_root} ====")
    install_cached_synth(maps)
    install_wiki_bgs(maps)
    fix_fogs(maps)
    build_pyro_walls(maps, web_root)
    build_ab(maps)
    alias_named_missing(maps, web_root)
    critical = [
        "map22/bg.jpg",
        "map23/bg.jpg",
        "map24/bg.jpg",
        "pyro/bg.jpg",
        "pyro_core/bg.jpg",
        "pyro_2/bg.jpg",
        "pyro/pyro_walls.webp",
        "pyro/pyro_walls.json",
        "pyro/ab_body.webp",
        "pyro/fog_ash_a.png",
    ]
    for rel in critical:
        p = maps / rel
        ok = p.is_file() and p.stat().st_size > 0
        note = ""
        if ok and rel.endswith(".png"):
            note = " JPEG!" if is_jpeg(p) else " PNG"
        print(("OK" if ok else "MISS"), rel, p.stat().st_size if ok else 0, note)


def default_roots() -> list[Path]:
    home = Path.home()
    roots = [
        home / "Library/Application Support/RedGalaxy Bastion/web",
        home / "Library/Application Support/RedUniverse Bastion/web",
    ]
    proj = SCRIPT_DIR.parent
    for brand in ("redgalaxy", "reduniverse"):
        for kind in ("story", "native"):
            roots.append(proj / f"artifacts/redgalaxy-{kind}-web-{brand}")
    return [r for r in roots if r.is_dir()]


def main(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[1] == "--default-roots":
        roots = default_roots()
    elif len(argv) >= 2:
        roots = [Path(a) for a in argv[1:]]
    else:
        print(__doc__)
        return 2
    for root in roots:
        process_web_root(root)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

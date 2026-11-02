#!/usr/bin/env python3
from __future__ import annotations

import os
import re
import json
import hashlib
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path


TEXT_EXTS = {".html", ".js", ".css", ".json", ".svg", ".atlas", ".txt"}
KNOWN_PATH_EXTS = (
    ".json",
    ".html",
    ".css",
    ".js",
    ".png",
    ".svg",
    ".webp",
    ".jpg",
    ".jpeg",
    ".woff2",
    ".woff",
    ".ogg",
    ".wav",
    ".atlas",
)

PATH_RE = re.compile(
    rb"(?:/)?(?:assets|ui|lang|ships|box|drones|equip|extras|maps|missiles|ore|"
    rb"portals|ranks|corps|base|audio|shop|icons|turrets|resources|textures|sprites)"
    rb"[A-Za-z0-9_./@+\- ]*\.(?:json|html|css|js|png|svg|webp|jpg|jpeg|woff2?|ogg|wav|atlas)"
    rb"|/index\.html|redgalaxy\.png"
)
REF_RE = re.compile(
    r"(?:/)?(?:assets|ui|lang|ships|box|drones|equip|extras|maps|missiles|ore|"
    r"portals|ranks|corps|base|audio|shop|icons|turrets|resources|textures|sprites)"
    r"[A-Za-z0-9_./@+\- ]*\.(?:json|html|css|js|png|svg|webp|jpg|jpeg|woff2?|ogg|wav|atlas)"
    r"|/index\.html|redgalaxy\.png"
)


def normalize_path(raw: str) -> str:
    path = raw.strip().strip("'\"()")
    while path.startswith("./"):
        path = path[2:]
    path = path.lstrip("/")
    path = path.replace("\\", "/")
    parts = []
    for part in path.split("/"):
        if not part or part == ".":
            continue
        if part == "..":
            if parts:
                parts.pop()
            continue
        parts.append(part)
    return "/".join(parts)


def canonical_asset_rel(rel: str) -> str:
    """Strip Windows duplicate suffixes: ' - Copy' / ' - Kopya' / ' - Copia'."""
    norm = normalize_path(rel)
    if not norm:
        return ""
    return re.sub(r" - (?:Copy|Kopya|Copia)(\.[A-Za-z0-9]+)$", r"\1", norm, flags=re.IGNORECASE)


def path_search_variants(rel_or_path: str) -> list[str]:
    raw = str(rel_or_path or "")
    with_slash = raw if raw.startswith("/") else f"/{raw}"
    no_slash = with_slash[1:]
    canon = canonical_asset_rel(no_slash)
    out: list[str] = []
    seen: set[str] = set()
    variants = [no_slash, canon]
    if canon:
        for suf in (" - Copy", " - Kopya", " - Copia"):
            variants.append(re.sub(r"(\.[A-Za-z0-9]+)$", rf"{suf}\1", canon))
    for r in variants:
        if not r:
            continue
        for variant in (r, f"/{r}"):
            if variant not in seen:
                seen.add(variant)
                out.append(variant)
    return out


# RedUniverse Tauri embeds large binaries with 4-byte splice markers
# (b"\xfc\xff\x9f\x08") every 0x140000 payload bytes. Desplice only when that
# marker is present. Clean RedGalaxy streams have no markers — copy verbatim.
# Never skip bytes unconditionally (old `i += 3` fallback corrupted large RG assets).
EMBED_SPLICE_PERIOD = 0x140000
EMBED_SPLICE_MARKER = b"\xfc\xff\x9f\x08"


def desplice_embedded_payload(raw: bytes, target_len: int | None = None) -> bytes | None:
    if not raw:
        return None
    limit = len(raw) if target_len is None else target_len
    # No RU splice markers anywhere → clean embed; never invent skips.
    if EMBED_SPLICE_MARKER not in raw:
        if target_len is None:
            return bytes(raw)
        return bytes(raw[: min(len(raw), target_len)])
    out = bytearray()
    i = 0
    while i < len(raw) and len(out) < limit:
        room = EMBED_SPLICE_PERIOD - (len(out) % EMBED_SPLICE_PERIOD)
        take = min(room, len(raw) - i, limit - len(out))
        out.extend(raw[i : i + take])
        i += take
        if len(out) > 0 and len(out) % EMBED_SPLICE_PERIOD == 0 and i < len(raw) and len(out) < limit:
            # Only skip a proven RU marker; never unconditional i += 3.
            if raw[i : i + 4] == EMBED_SPLICE_MARKER:
                i += 4
    return bytes(out) if out else None


def is_valid_png_buffer(buf: bytes) -> bool:
    if len(buf) < 24 or not buf.startswith(b"\x89PNG\r\n\x1a\n"):
        return False
    i = 8
    while i + 8 <= len(buf):
        length = int.from_bytes(buf[i : i + 4], "big")
        typ = buf[i + 4 : i + 8]
        if length > 16_000_000 or i + 8 + length + 4 > len(buf):
            return False
        if not all(65 <= c <= 90 or 97 <= c <= 122 for c in typ):
            return False
        i += 8 + length + 4
        if typ == b"IEND":
            return True
    return False


def expand_path_candidates(raw: str) -> set[str]:
    rel = normalize_path(raw)
    if not rel:
        return set()
    candidates = {rel}
    canon = canonical_asset_rel(rel)
    if canon:
        candidates.add(canon)
    for ext in KNOWN_PATH_EXTS:
        start = 0
        while True:
            found = rel.find(ext, start)
            if found < 0:
                break
            # Skip shorter ext prefixes of a longer real extension (.js in .json, .woff in .woff2).
            rest = rel[found:]
            if any(
                other != ext and other.startswith(ext) and rest.startswith(other)
                for other in KNOWN_PATH_EXTS
            ):
                start = found + 1
                continue
            candidate = rel[: found + len(ext)]
            if candidate:
                candidates.add(candidate)
                c_canon = canonical_asset_rel(candidate)
                if c_canon:
                    candidates.add(c_canon)
            start = found + 1
    return {
        candidate
        for candidate in candidates
        if not candidate.endswith(("..", ".")) and is_sane_rel_path(candidate)
    }


def is_sane_rel_path(rel: str) -> bool:
    """Reject fused binary matches like froston1.atlasships/alien/...

    Important: longer extensions must win. The old check treated `.js` inside
    `.json` and `.woff` inside `.woff2` as fusion, which dropped every locale
    JSON and every woff2 font from extracts — WKWebView then hung forever on
    document.fonts.load() and never created the Phaser game (black viewport).
    """
    if not rel or ".." in rel or len(rel) > 220:
        return False
    lower = rel.lower()
    matched_ext = next(
        (ext for ext in sorted(KNOWN_PATH_EXTS, key=len, reverse=True) if lower.endswith(ext)),
        None,
    )
    if not matched_ext:
        return False
    # Scan only the path with the final extension removed so `.json` / `.woff2`
    # are not false-positive fused matches against `.js` / `.woff`.
    trimmed = lower[: len(lower) - len(matched_ext)]
    for part in trimmed.split("/"):
        if not part:
            continue
        for ext in KNOWN_PATH_EXTS:
            idx = part.find(ext)
            if idx >= 0 and idx + len(ext) <= len(part):
                # Embedded ext in a path segment (e.g. froston1.atlasships).
                if idx + len(ext) < len(part) or idx > 0:
                    return False
    return True


def write_file(out_dir: Path, rel: str, payload: bytes) -> bool:
    rel = normalize_path(rel)
    if not rel:
        return False
    target = out_dir / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and target.read_bytes() == payload:
        return False
    target.write_bytes(payload)
    return True


def extract_png(data: bytes, start: int) -> bytes | None:
    if not data.startswith(b"\x89PNG\r\n\x1a\n", start):
        return None
    slop = min(len(data), start + 20_000_000)
    max_ins = (slop - start) // EMBED_SPLICE_PERIOD + 2
    spliced = data[start : min(len(data), slop + max_ins * 4)]
    fixed = desplice_embedded_payload(spliced) or spliced
    end = fixed.find(b"IEND\xaeB\x60\x82")
    if end < 0:
        return None
    png = fixed[: end + 8]
    return png if is_valid_png_buffer(png) else None


def extract_jpeg(data: bytes, start: int) -> bytes | None:
    if not data.startswith(b"\xff\xd8\xff", start):
        return None
    end = data.find(b"\xff\xd9", start + 3)
    if end < 0:
        return None
    return data[start : end + 2]


def extract_riff(data: bytes, start: int) -> bytes | None:
    if not data.startswith(b"RIFF", start) or start + 8 > len(data):
        return None
    size = struct.unpack_from("<I", data, start + 4)[0] + 8
    if size <= 12:
        return None
    max_ins = size // EMBED_SPLICE_PERIOD + 1
    slop_end = min(len(data), start + size + max_ins * 4 + 8)
    if slop_end <= start + 12:
        return None
    spliced = data[start:slop_end]
    fixed = desplice_embedded_payload(spliced, size)
    if not fixed or len(fixed) < 12:
        if start + size > len(data):
            return None
        fixed = data[start : start + size]
    fixed = bytearray(fixed)
    struct.pack_into("<I", fixed, 4, len(fixed) - 8)
    if not fixed.startswith(b"RIFF"):
        return None
    if fixed[8:12] not in (b"WEBP", b"WAVE"):
        return None
    return bytes(fixed)


def extract_woff(data: bytes, start: int) -> bytes | None:
    if data.startswith(b"wOFF", start) and start + 8 <= len(data):
        size = struct.unpack_from(">I", data, start + 4)[0]
        if 20 <= size <= 20_000_000 and start + size <= len(data):
            return data[start : start + size]
    if data.startswith(b"wOF2", start) and start + 12 <= len(data):
        size = struct.unpack_from(">I", data, start + 8)[0]
        if 20 <= size <= 20_000_000 and start + size <= len(data):
            return data[start : start + size]
    return None


def extract_svg(data: bytes, start: int) -> bytes | None:
    if not data.startswith(b"<svg", start):
        return None
    end = data.find(b"</svg>", start)
    if end < 0:
        return None
    return data[start : end + len(b"</svg>")]


def extract_json_text(data: bytes, start: int) -> bytes | None:
    if not data.startswith((b"{", b"["), start):
        return None
    chunk = data[start : min(len(data), start + 8_000_000)]
    text = chunk.decode("utf-8", "ignore")
    leading = len(text) - len(text.lstrip())
    try:
        value, end = json.JSONDecoder().raw_decode(text.lstrip())
    except json.JSONDecodeError:
        return None
    if end <= 0:
        return None
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def looks_like_atlas_text(payload: bytes) -> bool:
    if not payload or len(payload) < 24 or len(payload) >= 2_000_000:
        return False
    probe = payload[: min(512, len(payload))]
    if b"\x00" in probe:
        return False
    if any(b < 0x09 or (0x0D < b < 0x20) for b in probe):
        return False
    head = payload[: min(4096, len(payload))]
    head_l = head.lower()
    return (
        b"\nsize:" in head
        or b"\nformat:" in head_l
        or b"\nrepeat:" in head_l
        or b"rotate:" in head_l
        or b"\nfilter:" in head_l
    )


def extract_text_until_marker(data: bytes, start: int, ext: str) -> bytes | None:
    if ext == ".json":
        payload = extract_json_text(data, start)
        if payload:
            return payload
    if ext == ".atlas":
        end = data.find(b"\x00", start)
        if end > start:
            payload = data[start:end]
            if looks_like_atlas_text(payload):
                return payload
    return None


def extract_ogg(data: bytes, start: int) -> bytes | None:
    if not data.startswith(b"OggS", start):
        return None
    pos = start
    while pos + 27 <= len(data) and data.startswith(b"OggS", pos):
        header_type = data[pos + 5]
        segments = data[pos + 26]
        seg_table_start = pos + 27
        seg_table_end = seg_table_start + segments
        if seg_table_end > len(data):
            return None
        page_size = 27 + segments + sum(data[seg_table_start:seg_table_end])
        if page_size <= 27 or pos + page_size > len(data):
            return None
        pos += page_size
        if header_type & 0x04:
            return data[start:pos]
    return data[start:pos] if pos > start else None


def _accept_brotli_output(out: bytes, ext: str) -> bytes | None:
    if len(out) < 8:
        return None
    if ext == ".ogg":
        decoded = extract_ogg(out, 0)
        if decoded:
            return decoded
    if ext == ".wav":
        decoded = extract_riff(out, 0)
        if decoded:
            return decoded
    if ext == ".json":
        return extract_json_text(out, 0)
    # Spine/libGDX atlas text has no `{` / JS markers — previously rejected → black world.
    if ext == ".atlas":
        return out if looks_like_atlas_text(out) else None
    if ext in {".jpg", ".jpeg"} and out.startswith(b"\xff\xd8\xff"):
        return out
    if ext == ".png" and out.startswith(b"\x89PNG"):
        return out
    if ext == ".webp" and out.startswith(b"RIFF"):
        return out
    if ext in {".woff", ".woff2"} and out.startswith((b"wOFF", b"wOF2")):
        return out
    if any(
        marker in out[:4096]
        for marker in (
            b"<!doctype html",
            b"import",
            b"const ",
            b"function",
            b"@font-face",
            b":root",
            b"{",
            b"<svg",
            b"OggS",
            b"RIFF",
            b"wOFF",
            b"wOF2",
        )
    ):
        return out
    return None


def brotli_decompress_slice(data: bytes, start: int, brotli_bin: str | None, ext: str) -> bytes | None:
    # Brotli has no magic bytes. The embedded stream is followed by unrelated binary data;
    # the CLI exits non-zero after outputting the valid first stream, which is acceptable.
    chunk = data[start : min(len(data), start + 30_000_000)]
    if not chunk:
        return None

    if brotli_bin:
        with tempfile.NamedTemporaryFile(delete=False) as tmp:
            tmp.write(chunk)
            tmp_path = tmp.name
        try:
            proc = subprocess.run(
                [brotli_bin, "-d", "-c", tmp_path],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=30,
            )
        except subprocess.TimeoutExpired:
            return None
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
        accepted = _accept_brotli_output(proc.stdout, ext)
        if accepted is not None:
            return accepted

    # Optional Python fallback (pip package "brotli") when CLI is unavailable.
    try:
        import brotli as _pybrotli  # type: ignore
    except ImportError:
        return None
    try:
        out = _pybrotli.decompress(chunk)
    except Exception:
        # Truncate trailing junk byte-by-byte is too slow; try progressive sizes.
        out = None
        for size in (len(chunk), min(len(chunk), 8_000_000), min(len(chunk), 2_000_000)):
            try:
                out = _pybrotli.decompress(chunk[:size])
                break
            except Exception:
                continue
        if out is None:
            return None
    return _accept_brotli_output(out, ext)


def resolve_brotli_bin() -> str | None:
    env = os.environ.get("BROTLI", "").strip()
    candidates: list[str] = []
    if env:
        candidates.append(env)
    which = shutil.which("brotli")
    if which:
        candidates.append(which)
    candidates.extend(
        [
            "/opt/homebrew/bin/brotli",
            "/usr/local/bin/brotli",
        ]
    )
    script_dir = Path(__file__).resolve().parent
    candidates.extend(
        [
            str(script_dir / "brotli" / "bin" / "brotli"),
            str(script_dir / "bin" / "brotli"),
        ]
    )
    seen: set[str] = set()
    for path in candidates:
        if not path or path in seen:
            continue
        seen.add(path)
        if not (os.path.isfile(path) and os.access(path, os.X_OK)):
            continue
        try:
            proc = subprocess.run(
                [path, "-c"],
                input=b"rg",
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                timeout=5,
            )
            if not proc.stdout:
                continue
            proc2 = subprocess.run(
                [path, "-d", "-c"],
                input=proc.stdout,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                timeout=5,
            )
            if proc2.stdout == b"rg":
                return path
        except (OSError, subprocess.TimeoutExpired):
            continue
    return None


def merge_locale_with_fallback(out_dir: Path, locale: str, fallback: str = "en") -> None:
    locale_dir = out_dir / "lang"
    locale_file = locale_dir / f"{locale}.json"
    fallback_file = locale_dir / f"{fallback}.json"
    if not locale_file.exists() or not fallback_file.exists():
        return

    try:
        fallback_obj = json.loads(fallback_file.read_text(encoding="utf-8"))
        locale_obj = json.loads(locale_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return

    if not isinstance(fallback_obj, dict):
        return

    if not isinstance(locale_obj, dict):
        locale_obj = {}

    merged = dict(fallback_obj)
    merged.update(locale_obj)
    locale_file.write_text(
        json.dumps(merged, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


ITALIAN_UI_OVERRIDES = {
    "auth.back": "INDIETRO",
    "auth.choose_nickname": "SCEGLI NOME PILOTA",
    "auth.connecting": "CONNESSIONE AL SERVER...",
    "auth.email": "EMAIL",
    "auth.forgot_password": "Password dimenticata?",
    "auth.have_account": "Hai gia' un account?",
    "auth.logging_in": "ACCESSO...",
    "auth.login": "ACCEDI",
    "auth.next": "AVANTI",
    "auth.nickname": "NOME PILOTA",
    "auth.no_account": "Non hai un account?",
    "auth.password": "PASSWORD",
    "auth.password_confirm": "CONFERMA PASSWORD",
    "auth.register": "REGISTRATI",
    "auth.registering": "REGISTRAZIONE...",
    "auth.remember_me": "Ricordami",
    "auth.saved_accounts": "ACCOUNT SALVATI",
    "auth.server": "SERVER",
    "auth.start_game": "AVVIA GIOCO",
    "auth.subtitle": "Accedi con il tuo account o creane uno nuovo",
    "auth.title": "ACCESSO",
    "auth.username": "NOME UTENTE",
    "chat.input_placeholder": "Scrivi un messaggio...",
    "chat.tab.clan": "CLAN",
    "chat.tab.faction": "FAZIONE",
    "chat.tab.global": "GLOBALE",
    "chat.tab.group": "GRUPPO",
    "chat.tab.lang": "IT",
    "chat.tag.lang": "IT",
    "chat.title": "CHAT",
    "clan.accept": "ACCETTA",
    "clan.apply_btn": "CANDIDATI",
    "clan.cancel_apply": "RITIRA",
    "clan.col.faction": "FAZIONE",
    "clan.col.level": "LIVELLO",
    "clan.col.map": "MAPPA",
    "clan.col.name": "NOME",
    "clan.col.role": "RUOLO",
    "clan.create.btn": "CREA CLAN",
    "clan.create.desc": "Descrizione",
    "clan.create.name": "Nome clan",
    "clan.create.tag": "Tag clan",
    "clan.demote": "DEGRADA",
    "clan.diplo.active": "RELAZIONI ATTIVE",
    "clan.diplo.alliance": "Alleanza",
    "clan.diplo.cancel": "ANNULLA",
    "clan.diplo.incoming": "OFFERTE IN ARRIVO",
    "clan.diplo.nap": "Non aggressione",
    "clan.diplo.none": "Nessuna relazione diplomatica",
    "clan.diplo.pending": "In attesa",
    "clan.diplo.propose": "INVIA OFFERTA",
    "clan.diplo.war": "Guerra",
    "clan.disband": "SCIOGLI CLAN",
    "clan.invite": "INVITA",
    "clan.kick": "ESPULSI",
    "clan.leave": "LASCIA CLAN",
    "clan.promote": "PROMUOVI",
    "clan.search_btn": "CERCA",
    "clan.tab.applications": "CANDIDATURE",
    "clan.tab.create": "CREA CLAN",
    "clan.tab.diplomacy": "DIPLOMAZIA",
    "clan.tab.find": "CERCA CLAN",
    "clan.tab.info": "INFO",
    "clan.tab.members": "MEMBRI",
    "clan.tab.settings": "IMPOSTAZIONI",
    "combat.friendly_fire": "Non puoi attaccare un giocatore della tua fazione.",
    "combat.no_weapon": "Devi avere un'arma per attaccare.",
    "combat.safe_zone": "Il giocatore e' in zona sicura, non puoi attaccare.",
    "input.collect": "Raccogli",
    "input.config_cooldown": "La configurazione puo' essere cambiata ogni 5 secondi.",
    "input.no_cargo": "Nessun carico vicino da raccogliere.",
    "input.no_portal": "Nessun portale vicino.",
    "input.no_target": "Nessun nemico vicino da agganciare.",
    "input.rocketFire": "Lancia razzo",
    "menu.hangar.active": "ATTIVA",
    "menu.hangar.batch_mode": "Modalita batch",
    "menu.hangar.buy_hangar": "Compra hangar",
    "menu.hangar.config1": "CONFIG 1",
    "menu.hangar.config2": "CONFIG 2",
    "menu.hangar.destroyed": "DISTRUTTA",
    "menu.hangar.empty_slot": "-- Vuoto --",
    "menu.hangar.equip_error.title": "ERRORE EQUIPAGGIAMENTO",
    "menu.hangar.extras": "EXTRA",
    "menu.hangar.generators": "Generatori",
    "menu.hangar.group": "Gruppo",
    "menu.hangar.make_active": "RENDI ATTIVA",
    "menu.hangar.no_equipment": "-- Nessun equipaggiamento --",
    "menu.hangar.no_extras": "-- Nessuno slot extra --",
    "menu.hangar.no_generators": "Nessun generatore",
    "menu.hangar.no_launcher": "-- Nessun lanciatore --",
    "menu.hangar.no_weapons": "-- Nessuna arma --",
    "menu.hangar.repair": "RIPARA",
    "menu.hangar.replace_title": "HANGAR PIENO -- Cambia nave",
    "menu.hangar.research.badge_active": "ATTIVA",
    "menu.hangar.research.badge_gate": "PORTALE",
    "menu.hangar.research.badge_passive": "PASSIVA",
    "menu.hangar.research.buy": "RICERCA",
    "menu.hangar.research.cat_defense": "DIFESA",
    "menu.hangar.research.cat_drones": "DRONI RICERCA",
    "menu.hangar.research.cat_offense": "ATTACCO",
    "menu.hangar.research.level": "Livello {n}",
    "menu.hangar.research.locked": "BLOCCATO",
    "menu.hangar.research.max": "LIVELLO MASSIMO",
    "menu.hangar.research.unlock": "SBLOCCA",
    "menu.hangar.research.upgrade": "MIGLIORA LIVELLO",
    "menu.hangar.tab.drones": "DRONI",
    "menu.hangar.tab.equipment": "EQUIPAGGIAMENTO",
    "menu.hangar.tab.research": "RICERCA",
    "menu.hangar.tab.ship": "NAVE",
    "menu.hangar.tab.ships": "HANGAR",
    "menu.shop.tab.ammo": "Munizioni",
    "menu.shop.tab.drones": "Droni",
    "menu.shop.tab.extras": "Extra",
    "menu.shop.tab.generators": "Generatori",
    "menu.shop.tab.launchers": "Lanciatori",
    "menu.shop.tab.rockets": "Razzi",
    "menu.shop.tab.ships": "Navi",
    "menu.shop.tab.weapons": "Armi",
    "menu.tab.auction": "ASTA",
    "menu.tab.clan": "CLAN",
    "menu.tab.hangar": "HANGAR",
    "menu.tab.premium": "PREMIUM",
    "menu.tab.profile": "PROFILO",
    "menu.tab.quest": "MISSIONI",
    "menu.tab.raid": "RAID",
    "menu.tab.settings": "IMPOSTAZIONI",
    "menu.tab.shop": "NEGOZIO",
    "menu.tab.social": "SOCIALE",
    "menu.title": "MENU",
    "notif.attack_started": "Attacco avviato su {name}",
    "notif.attack_stopped": "Attacco fermato su {name}",
    "notif.bonus_box": "Box bonus!",
    "notif.cargo_steal_penalty": "CARICO RUBATO",
    "notif.collect_failed": "Stiva piena!",
    "notif.collect_success": "Carico raccolto",
    "notif.config_switched": "Configurazione cambiata",
    "notif.equip_not_safe": "Devi essere in zona sicura per cambiare equipaggiamento!",
    "notif.jump_approved": "Portale pronto",
    "notif.jump_cancelled": "Entrato in combattimento -- salto annullato!",
    "notif.jump_execute": "Salto verso la mappa...",
    "notif.kill_reward": "BERSAGLIO DISTRUTTO",
    "notif.no_ammo": "Munizioni finite!",
    "notif.no_launcher": "Nessun lanciarazzi equipaggiato!",
    "notif.no_rocket": "Razzi finiti!",
    "notif.sell_failed": "Vendita fallita!",
    "notif.sell_success": "{name} venduto -- +{price} CR",
    "ore.ANTIMATTER": "Antimateria",
    "ore.COPPER": "Rame",
    "ore.GOLD": "Oro",
    "ore.IRON": "Ferro",
    "ore.PLUTONIUM": "Plutonio",
    "ore.SILVER": "Argento",
    "ore.TITANIUM": "Titanio",
    "ore.TRITIUM": "Tritio",
    "ore.URANIUM": "Uranio",
    "ore.title": "MINERALI",
    "profile.booty_keys": "CHIAVI",
    "profile.clan_rank.members": "MEMBRI",
    "profile.clan_rank.name": "CLAN",
    "profile.clan_rank.points": "PUNTI TOTALI",
    "profile.clan_rank.title": "CLASSIFICA CLAN",
    "profile.completed_quests": "MISSIONI",
    "profile.copy_id": "Copia ID",
    "profile.credits": "CREDITI",
    "profile.deaths": "MORTI",
    "profile.enemy_kills": "NEMICI",
    "profile.honor": "ONORE",
    "profile.lb.clan": "TOP 20 CLAN",
    "profile.lb.player": "TOP 20 GIOCATORI",
    "profile.leaderboard": "CLASSIFICA",
    "profile.level": "LIVELLO",
    "profile.log": "REGISTRO EVENTI",
    "profile.mecha_token": "MECHA TOKEN",
    "profile.myrank.breakdown": "DETTAGLIO PUNTI",
    "profile.myrank.completed_quests": "Missioni completate",
    "profile.myrank.current_rank": "RANGO ATTUALE",
    "profile.myrank.deaths": "Morti",
    "profile.myrank.enemy_kills": "Uccisioni nemiche",
    "profile.myrank.honor": "Onore",
    "profile.myrank.level": "Livello",
    "profile.myrank.max_rank": "Hai raggiunto il rango massimo!",
    "profile.myrank.next_rank": "PROSSIMO RANGO",
    "profile.myrank.npc_kills": "Uccisioni NPC",
    "profile.myrank.title": "DETTAGLI RANGO",
    "profile.myrank.total_points": "PUNTI RANGO TOTALI",
    "profile.npc_kills": "NPC",
    "profile.rank": "RANGO",
    "profile.rank.full_list": "CLASSIFICA GIOCATORI",
    "profile.rank.loading": "Caricamento...",
    "profile.rank.my_position": "IL TUO RANGO",
    "profile.rank.nickname": "NOME",
    "profile.rank.points": "PUNTI",
    "profile.rank.rank": "RANGO",
    "profile.rank.search_placeholder": "Cerca giocatore...",
    "profile.rank_points": "PUNTI RANGO",
    "profile.red_matter": "RED MATTER",
    "profile.sub.clan_ranking": "Classifica clan",
    "profile.sub.general": "Panoramica",
    "profile.sub.myrank": "Il mio rango",
    "profile.sub.ranking": "Classifica",
    "profile.xp": "ESPERIENZA",
    "refine.button": "RAFFINA",
    "settings.account.change_faction": "CAMBIA FAZIONE",
    "settings.account.change_nickname": "CAMBIA NOME PILOTA",
    "settings.account.change_password": "CAMBIA PASSWORD",
    "settings.account.current_password": "Password attuale",
    "settings.account.faction": "FAZIONE",
    "settings.account.honor": "ONORE",
    "settings.account.loading": "Caricamento...",
    "settings.account.new_nickname": "Nuovo nome pilota",
    "settings.account.new_password": "Nuova password",
    "settings.account.nickname": "NOME PILOTA",
    "settings.account.red_matter": "RED MATTER",
    "settings.account.save": "SALVA",
    "settings.account.username": "NOME UTENTE",
    "settings.audio.master": "VOLUME GENERALE",
    "settings.audio.music": "MUSICA",
    "settings.audio.mute": "MUTO",
    "settings.audio.sfx": "EFFETTI",
    "settings.audio.ui": "SUONI UI",
    "settings.coming_soon": "IN ARRIVO",
    "settings.tab.account": "ACCOUNT",
    "settings.tab.audio": "AUDIO",
    "settings.tab.controls": "CONTROLLI",
    "settings.tab.graphics": "GRAFICA",
    "settings.tab.interface": "INTERFACCIA",
    "social.tab.blocked": "Bloccati",
    "social.tab.friends": "Amici",
    "social.tab.messages": "Messaggi",
    "social.tab.settings": "Impostazioni",
}


def apply_italian_ui_overrides(out_dir: Path) -> None:
    locale_file = out_dir / "lang" / "it.json"
    if not locale_file.exists():
        return
    try:
        data = json.loads(locale_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return
    if not isinstance(data, dict):
        return
    data.update(ITALIAN_UI_OVERRIDES)
    locale_file.write_text(
        json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def is_valid_json(path: Path) -> bool:
    try:
        json.loads(path.read_text(encoding="utf-8"))
        return True
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return False


def is_valid_webp(path: Path) -> bool:
    try:
        buf = path.read_bytes()
    except OSError:
        return False
    if len(buf) < 16 or not buf.startswith(b"RIFF") or b"WEBP" not in buf[:16]:
        return False
    declared = struct.unpack_from("<I", buf, 4)[0] + 8
    return abs(declared - len(buf)) <= 16


def is_valid_png(path: Path) -> bool:
    try:
        return is_valid_png_buffer(path.read_bytes())
    except OSError:
        return False


def atlas_page_file_name(atlas_text: str) -> str:
    for line in atlas_text.splitlines():
        if not line or line.startswith(" ") or ":" in line:
            continue
        return line.strip()
    return ""


def atlas_page_is_broken(atlas_path: Path) -> bool:
    try:
        text = atlas_path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return True
    if not looks_like_atlas_text(text.encode("utf-8", errors="ignore")):
        return True
    page = atlas_page_file_name(text)
    if not page or "/" in page or page.count(".") > 1:
        return True
    return not (atlas_path.parent / page).exists()


def rewrite_atlas_page_name(atlas_text: str, new_page: str) -> str:
    lines = atlas_text.splitlines()
    rewritten = False
    out: list[str] = []
    for idx, line in enumerate(lines):
        if rewritten:
            out.append(line)
            continue
        if not line or line.startswith(" ") or ":" in line:
            out.append(line)
            continue
        if idx == 0 or all(not l.strip() for l in lines[:idx]):
            out.append(new_page)
            rewritten = True
            continue
        if re.search(r"\.(webp|png)$", line.strip(), re.I):
            out.append(new_page)
            rewritten = True
            continue
        out.append(line)
    if not rewritten:
        out.insert(0, new_page)
    return "\n".join(out) + ("\n" if atlas_text.endswith("\n") else "")


def copy_asset_alias(out_dir: Path, source: str, target: str) -> bool:
    source_path = out_dir / source
    target_path = out_dir / target
    if not source_path.exists():
        return False
    ext = target_path.suffix.lower()
    if target_path.exists():
        if ext == ".json" and is_valid_json(target_path):
            return False
        if ext == ".webp" and is_valid_webp(target_path):
            return False
        if ext == ".png" and is_valid_png(target_path):
            return False
        if ext == ".atlas":
            if not atlas_page_is_broken(target_path):
                return False
        elif ext not in {".json", ".webp", ".png"}:
            return False
    target_path.parent.mkdir(parents=True, exist_ok=True)
    if ext == ".atlas":
        try:
            text = source_path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            return False
        want_webp = f"{target_path.stem}.webp"
        want_png = f"{target_path.stem}.png"
        page_name = want_webp if (target_path.parent / want_webp).exists() else want_png
        body = rewrite_atlas_page_name(text, page_name)
        if not body.endswith("\n"):
            body += "\n"
        target_path.write_text(body, encoding="utf-8")
        return True
    shutil.copy2(source_path, target_path)
    return True


def ensure_missing_ship_atlases(out_dir: Path) -> None:
    roots = [out_dir / "ships" / "player", out_dir / "ships" / "alien", out_dir / "ships" / "system"]
    template = None
    for root in roots:
        if not root.is_dir():
            continue
        for atlas in sorted(root.glob("*.atlas")):
            try:
                text = atlas.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            if looks_like_atlas_text(text.encode("utf-8", errors="ignore")):
                template = text
                break
        if template:
            break
    if not template:
        return
    for root in roots:
        if not root.is_dir():
            continue
        for img in list(root.glob("*.webp")) + list(root.glob("*.png")):
            atlas_path = root / f"{img.stem}.atlas"
            if atlas_path.exists():
                continue
            atlas_path.write_text(rewrite_atlas_page_name(template, img.name), encoding="utf-8")


def ensure_runtime_asset_aliases(out_dir: Path) -> None:
    aliases = {
        "ships/alien/alien21.json": "ships/alien/alien20.json",
        "ships/alien/alien31.json": "ships/alien/alien30.json",
        "ships/alien/alien41.json": "ships/alien/alien40.json",
        "ships/alien/noxon1.json": "ships/alien/noxon.json",
        "ships/alien/raidon1.json": "ships/alien/raidon.json",
        "ships/alien/talon1.json": "ships/alien/talon.json",
        "ships/alien/voxion1.json": "ships/alien/voxion.json",
        "ships/alien/froston1.json": "ships/alien/froston.json",
        "ships/alien/froston1.webp": "ships/alien/froston.webp",
        "ships/alien/froston1.atlas": "ships/alien/froston.atlas",
        "ships/alien/alien21.atlas": "ships/alien/alien20.atlas",
        "ships/alien/alien31.atlas": "ships/alien/alien30.atlas",
        "ships/alien/alien41.atlas": "ships/alien/alien40.atlas",
        "ships/alien/noxon1.atlas": "ships/alien/noxon.atlas",
        "ships/alien/raidon1.atlas": "ships/alien/raidon.atlas",
        "ships/alien/talon1.atlas": "ships/alien/talon.atlas",
        "ships/alien/voxion1.atlas": "ships/alien/voxion.atlas",
        # Do NOT alias ship100.atlas → ship10.atlas (RedUniverse packs real Wraith as " - Copy").
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
        # Booty atlas page is typo'd "bootyy.webp" in RU 1.0.12.
        "box/bootyy.webp": "box/booty.webp",
        # RU packs Wraith config only under ship103; runtime still requests ship100.json.
        "ships/player/ship100.json": "ships/player/ship103.json",
        # PC 0.9.x PE embeds redgalaxy2.png; login/boot UI requests redgalaxy.png.
        "redgalaxy.png": "redgalaxy2.png",
        # Halloween event skins live in encrypted .rgpak; map to base hulls until packs decrypt.
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
        "equip/skins/halloween.webp": "equip/skins/crimson.webp",
        "shop/drones/preview/halloween.webp": "equip/skins/crimson.webp",
        "shop/drones/halloween.webp": "equip/skins/crimson.webp",
    }
    for _ in range(2):
        for target, source in aliases.items():
            copy_asset_alias(out_dir, source, target)
    ensure_shop_art_fallbacks(out_dir)
    ensure_missing_ship_atlases(out_dir)
    fix_ship_atlas_page_names(out_dir)


def ensure_shop_art_fallbacks(out_dir: Path) -> None:
    """Mirror hangar equip/box/ship art into shop/** when encrypted shop-*.rgpak is unavailable."""
    mirrors = [
        ("equip/extras", "shop/extras"),
        ("equip/extras", "shop/extras/preview"),
        ("equip/ammo", "shop/ammo"),
        ("equip/ammo", "shop/ammo/preview"),
        ("equip/gen", "shop/gen"),
        ("equip/gen", "shop/gen/preview"),
        ("equip/launcher", "shop/launcher"),
        ("equip/launcher", "shop/launcher/preview"),
        ("equip/drone", "shop/drones"),
        ("equip/drone", "shop/drones/preview"),
        ("equip/laser", "shop/repeaters"),
        ("equip/laser", "shop/repeaters/preview"),
    ]
    for src_rel, dst_rel in mirrors:
        src_dir = out_dir.joinpath(*src_rel.split("/"))
        dst_dir = out_dir.joinpath(*dst_rel.split("/"))
        if not src_dir.is_dir():
            continue
        for src in src_dir.iterdir():
            if not src.is_file():
                continue
            name = src.name
            if " 2." in name or " 3." in name:
                continue
            lower = name.lower()
            if not lower.endswith((".webp", ".png", ".jpg", ".jpeg")):
                continue
            dest_name = name
            if src_rel == "equip/laser" and lower.endswith(".png"):
                dest_name = name[:-4] + ".webp"
            dest = dst_dir / dest_name
            if dest.exists():
                continue
            try:
                dst_dir.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dest)
            except OSError:
                pass
    player_dir = out_dir / "ships" / "player"
    shop_ship = out_dir / "shop" / "ship"
    shop_ship_preview = shop_ship / "preview"
    if player_dir.is_dir():
        for src in player_dir.glob("ship*.webp"):
            if " 2." in src.name or " 3." in src.name:
                continue
            for dest_dir in (shop_ship, shop_ship_preview):
                dest = dest_dir / src.name
                if dest.exists():
                    continue
                try:
                    dest_dir.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(src, dest)
                except OSError:
                    pass
    for rel in (
        "shop/extras",
        "shop/ammo",
        "shop/gen",
        "shop/launcher",
        "shop/drones",
        "shop/repeaters",
        "shop/ship",
    ):
        base = out_dir.joinpath(*rel.split("/"))
        preview = base / "preview"
        if not base.is_dir():
            continue
        for src in base.iterdir():
            if not src.is_file():
                continue
            if " 2." in src.name or " 3." in src.name:
                continue
            if not src.name.lower().endswith((".webp", ".png")):
                continue
            dest = preview / src.name
            if dest.exists():
                continue
            try:
                preview.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dest)
            except OSError:
                pass


def fix_ship_atlas_page_names(out_dir: Path) -> None:
    roots = [out_dir / "ships" / "player", out_dir / "ships" / "alien", out_dir / "ships" / "system"]
    for root in roots:
        if not root.is_dir():
            continue
        for atlas_path in sorted(root.glob("*.atlas")):
            want_webp = f"{atlas_path.stem}.webp"
            want_png = f"{atlas_path.stem}.png"
            if (root / want_webp).exists():
                page_name = want_webp
            elif (root / want_png).exists():
                page_name = want_png
            else:
                continue
            try:
                text = atlas_path.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            if not looks_like_atlas_text(text.encode("utf-8", errors="ignore")):
                continue
            page = atlas_page_file_name(text)
            if page == page_name and (root / page).exists():
                continue
            body = rewrite_atlas_page_name(text, page_name)
            if not body.endswith("\n"):
                body += "\n"
            atlas_path.write_text(body, encoding="utf-8")


def extract_payload(data: bytes, path: str, offset: int, brotli_bin: str | None) -> bytes | None:
    raw_path = path.encode()
    start = offset + len(raw_path)
    ext = Path(path).suffix.lower()

    # Only probe binary magics for matching extensions — otherwise a WEBP sitting
    # near ship20.json in the path table poisons the JSON extract.
    binary_extractors = []
    if ext == ".png":
        binary_extractors.append(extract_png)
    if ext in {".jpg", ".jpeg"}:
        binary_extractors.append(extract_jpeg)
    if ext in {".webp", ".wav"}:
        binary_extractors.append(extract_riff)
    if ext in {".woff", ".woff2"}:
        binary_extractors.append(extract_woff)
    if ext == ".svg":
        binary_extractors.append(extract_svg)
    if ext == ".ogg":
        binary_extractors.append(extract_ogg)

    # RedUniverse " - Copy.webp" blobs often sit a few bytes after the path marker.
    for delta in range(0, 48):
        probe = start + delta
        for extractor in binary_extractors:
            payload = extractor(data, probe)
            if payload:
                return payload

    payload = extract_text_until_marker(data, start, ext)
    if payload:
        return payload

    return brotli_decompress_slice(data, start, brotli_bin, ext)


def discover_paths_from_binary(data: bytes) -> set[str]:
    found: set[str] = {"/index.html"}
    for match in PATH_RE.finditer(data):
        try:
            text = match.group(0).decode("utf-8", "ignore")
        except UnicodeDecodeError:
            continue
        for rel in expand_path_candidates(text):
            if len(rel) < 220 and ".." not in rel:
                found.add("/" + rel)
    return found


def discover_paths_from_output(out_dir: Path) -> set[str]:
    found: set[str] = set()
    for file in out_dir.rglob("*"):
        if not file.is_file() or file.suffix.lower() not in TEXT_EXTS:
            continue
        try:
            text = file.read_text(errors="ignore")
        except OSError:
            continue
        for match in REF_RE.finditer(text):
            for rel in expand_path_candidates(match.group(0)):
                if rel:
                    found.add("/" + rel)
    return found


def offset_looks_like_blob(data: bytes, search_path: str, offset: int) -> bool:
    start = offset + len(search_path.encode())
    ext = Path(search_path).suffix.lower()
    for delta in range(0, 48):
        p = start + delta
        if p + 12 > len(data):
            break
        if ext == ".png" and data.startswith(b"\x89PNG", p):
            return True
        if ext in {".jpg", ".jpeg"} and data.startswith(b"\xff\xd8", p):
            return True
        if ext in {".webp", ".wav"} and data.startswith(b"RIFF", p):
            return True
        if ext == ".json" and data[p] in (0x7B, 0x5B):
            return True
        if ext == ".atlas" and data[p] not in (0,):
            probe = data[p : p + 64]
            if b"size:" in probe or b".webp" in probe or b".png" in probe:
                return True
    return False


# --- Structured embedded asset tables (authoritative, format-independent of neighbors) ---
# Newer official clients (Oct 2026+) ship two tables in .rdata:
#   1. Tauri frontend map: 32-byte records (key_ptr, key_len, val_ptr, val_len),
#      key like "/assets/index-*.js", value = one brotli stream.
#   2. Game asset embed: 104-byte records with name (ptr, len) at +0, sha256 at +48
#      and raw (uncompressed) data (ptr, len) at +88. Names are packed together and
#      identical files are deduplicated by the linker, so the "data follows the
#      path string" heuristic cannot find them (drones/*.atlas, ships/*.json, ...).
# Reading the pointer tables gives exact bytes; embed entries are sha256-verified.
TABLE_NAME_RE = re.compile(rb"^/?[A-Za-z0-9_@+\-][A-Za-z0-9_./@+\- ]*\.[A-Za-z0-9]{1,6}$")
EMBED_RECORD_HASH_OFF = 48
EMBED_RECORD_DATA_OFF = 88
EMBED_RECORD_SIZE = 104


def pe64_layout(data: bytes):
    if len(data) < 0x400 or data[:2] != b"MZ":
        return None
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    if pe + 24 > len(data) or data[pe : pe + 4] != b"PE\x00\x00":
        return None
    nsec = struct.unpack_from("<H", data, pe + 6)[0]
    optsz = struct.unpack_from("<H", data, pe + 20)[0]
    opt = pe + 24
    if struct.unpack_from("<H", data, opt)[0] != 0x20B:  # PE32+ only (x64 client)
        return None
    image_base = struct.unpack_from("<Q", data, opt + 24)[0]
    sections = []
    for i in range(nsec):
        o = opt + optsz + 40 * i
        if o + 40 > len(data):
            break
        _vsize, va, rsize, raw = struct.unpack_from("<IIII", data, o + 8)
        chars = struct.unpack_from("<I", data, o + 36)[0]
        rsize = min(rsize, max(0, len(data) - raw))
        if rsize > 0:
            sections.append((va, raw, rsize, chars))
    return image_base, sections


def brotli_decompress_exact(chunk: bytes, brotli_bin: str | None) -> bytes | None:
    try:
        import brotli as _pybrotli  # type: ignore

        return _pybrotli.decompress(chunk)
    except ImportError:
        pass
    except Exception:
        return None
    if not brotli_bin:
        return None
    try:
        proc = subprocess.run(
            [brotli_bin, "-d", "-c"],
            input=chunk,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    return proc.stdout if proc.returncode == 0 and proc.stdout else None


def find_embedded_asset_tables(data: bytes) -> dict[str, tuple[str, int, int]]:
    """Return rel -> (kind, file_offset, length); kind is "raw" (sha256-verified) or "br"."""
    layout = pe64_layout(data)
    if not layout:
        return {}
    image_base, sections = layout
    if not sections:
        return {}
    vmin = image_base + min(s[0] for s in sections)
    vmax = image_base + max(s[0] + s[2] for s in sections)

    def v2o(v: int) -> int | None:
        r = v - image_base
        for va, raw, rsize, _c in sections:
            if va <= r < va + rsize:
                return raw + (r - va)
        return None

    found: dict[str, tuple[str, int, int]] = {}
    n = len(data)
    view = memoryview(data)
    for _va, raw, rsize, chars in sections:
        if chars & 0x20000000:  # skip executable code sections
            continue
        start = raw + ((8 - raw % 8) % 8)
        count = (raw + rsize - start) // 8
        if count < 4:
            continue
        qs = view[start : start + count * 8].cast("Q")
        for i in range(count - 3):
            p = qs[i]
            if p < vmin or p >= vmax:
                continue
            ln = qs[i + 1]
            if ln < 3 or ln > 260:
                continue
            no = v2o(p)
            if no is None or no + ln > n:
                continue
            name = bytes(view[no : no + ln])
            if not TABLE_NAME_RE.match(name):
                continue
            rel = normalize_path(name.decode("ascii", "ignore"))
            if not rel or not is_sane_rel_path(rel):
                continue
            rec = start + i * 8
            # Game asset embed record (raw bytes + sha256).
            if i + 12 < count:
                dp, dl = qs[i + 11], qs[i + 12]
                if vmin <= dp < vmax and 0 < dl <= 200_000_000:
                    do = v2o(dp)
                    if do is not None and do + dl <= n:
                        digest = bytes(view[rec + EMBED_RECORD_HASH_OFF : rec + EMBED_RECORD_HASH_OFF + 32])
                        if hashlib.sha256(view[do : do + dl]).digest() == digest:
                            found.setdefault(rel, ("raw", do, dl))
                            continue
            # Tauri frontend map record (brotli value).
            if name.startswith(b"/"):
                vp, vl = qs[i + 2], qs[i + 3]
                if vmin <= vp < vmax and 0 < vl <= 200_000_000:
                    vo = v2o(vp)
                    if vo is not None and vo + vl <= n and rel not in found:
                        found[rel] = ("br", vo, vl)
    return found


def extract_from_asset_tables(
    data: bytes, out_dir: Path, brotli_bin: str | None
) -> tuple[set[str], set[str]]:
    table = find_embedded_asset_tables(data)
    ok: set[str] = set()
    bad: set[str] = set()
    for rel, (kind, off, length) in sorted(table.items()):
        chunk = data[off : off + length]
        payload = chunk if kind == "raw" else brotli_decompress_exact(chunk, brotli_bin)
        if not payload:
            bad.add(rel)
            continue
        write_file(out_dir, rel, payload)
        ok.add(rel)
        canon = canonical_asset_rel(rel)
        if canon and canon != rel and canon not in table:
            write_file(out_dir, canon, payload)
            ok.add(canon)
    if table:
        print(f"asset_table entries={len(table)} decoded={len(ok)} bad={len(bad)}", file=sys.stderr)
    return ok, bad


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: extract_redgalaxy_web.py /path/to/reduniverse-pc-client.exe /output/dir", file=sys.stderr)
        return 2

    exe = Path(sys.argv[1]).expanduser()
    out_dir = Path(sys.argv[2]).expanduser()
    brotli_bin = resolve_brotli_bin()
    try:
        import brotli as _pybrotli  # noqa: F401
        has_pybrotli = True
    except ImportError:
        has_pybrotli = False
    if not brotli_bin and not has_pybrotli:
        print(
            "brotli command not found. Reinstall the app DMG (ships brotli) or: brew install brotli",
            file=sys.stderr,
        )
        return 2

    if not exe.is_file():
        print(f"Client exe not found: {exe}", file=sys.stderr)
        return 2
    data = exe.read_bytes()
    # A truncated / still-installing / wrong file has no PE header or is tiny.
    if len(data) < 1_000_000 or data[:2] != b"MZ":
        print(
            f"Client exe is not a complete official client (size={len(data)} bytes, "
            f"header={data[:2]!r}): {exe}. Reinstall/finish installing the official client and retry.",
            file=sys.stderr,
        )
        return 3
    out_dir.mkdir(parents=True, exist_ok=True)

    pending = discover_paths_from_binary(data)
    # Exact extraction from the client's embedded asset tables first.
    table_ok, _table_bad = extract_from_asset_tables(data, out_dir, brotli_bin)
    extracted: set[str] = set(table_ok)
    pending |= {"/" + rel for rel in table_ok}
    failed: set[str] = set()

    for _ in range(4):
        progress = False
        for path in sorted(pending):
            rel = canonical_asset_rel(path) or normalize_path(path)
            if not rel or rel in extracted or rel in failed:
                continue
            offsets = []
            for search_path in path_search_variants(path):
                raw = search_path.encode()
                start = 0
                while True:
                    off = data.find(raw, start)
                    if off < 0:
                        break
                    offsets.append((search_path, off))
                    start = off + 1
            if not offsets:
                failed.add(rel)
                continue

            offsets.sort(key=lambda item: 0 if offset_looks_like_blob(data, item[0], item[1]) else 1)
            payload = None
            for search_path, off in offsets[:40]:
                payload = extract_payload(data, search_path, off, brotli_bin)
                if payload:
                    break
            if payload:
                write_file(out_dir, rel, payload)
                extracted.add(rel)
                failed.discard(rel)
                progress = True
            else:
                failed.add(rel)

        new_refs = discover_paths_from_output(out_dir)
        before = len(pending)
        pending |= new_refs
        progress = progress or len(pending) > before
        if not progress:
            break

    merge_locale_with_fallback(out_dir, "it")
    merge_locale_with_fallback(out_dir, "quest.it", fallback="quest.en")
    apply_italian_ui_overrides(out_dir)
    # RedUniverse-only: never heal/copy from RedGalaxy twin exe.
    ensure_runtime_asset_aliases(out_dir)

    critical = ["box/cargo.png", "base/orion.png"]
    missing_critical = []
    for rel in critical:
        full = out_dir.joinpath(*rel.split("/"))
        if not full.is_file() or not is_valid_png(full):
            missing_critical.append(rel)
    if missing_critical:
        print(
            f"WARN: missing/invalid critical assets after extract: {', '.join(missing_critical)}",
            file=sys.stderr,
        )

    # With a structured table present, a referenced path that is neither in the table
    # nor recoverable by the heuristic is simply not shipped in the official client
    # (e.g. icons/128x128.png is the Tauri bundle icon string from tauri.conf).
    # PC 0.9.x also keeps ships/maps/box art in encrypted .rgpak — those land here.
    not_in_client: set[str] = set()
    if table_ok:
        not_in_client = {rel for rel in failed if rel not in table_ok}
        failed -= not_in_client
    print(
        f"extracted={len(extracted)} failed={len(failed)} not_in_client={len(not_in_client)} output={out_dir}"
    )
    if not_in_client:
        print("not_in_client (referenced, but not embedded in the official exe):")
        for item in sorted(not_in_client)[:80]:
            print(f"  {item}")
    if failed:
        sample = sorted(failed)[:80]
        print("failed_sample:")
        for item in sample:
            print(f"  {item}")
    # Do not fail the process solely because rgpak-backed art is absent from the PE.
    # Bastion merges ships/maps from a prior web / bundle donor, then completeness-gates.
    blocking_critical = [rel for rel in missing_critical if rel not in not_in_client]
    if failed:
        return 1
    return 1 if blocking_critical else 0


if __name__ == "__main__":
    raise SystemExit(main())

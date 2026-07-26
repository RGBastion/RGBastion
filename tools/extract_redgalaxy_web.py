#!/usr/bin/env python3
from __future__ import annotations

import os
import re
import json
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
    rb"[A-Za-z0-9_./@+\-]*\.(?:json|html|css|js|png|svg|webp|jpg|jpeg|woff2?|ogg|wav|atlas)"
    rb"|/index\.html|redgalaxy\.png"
)
REF_RE = re.compile(
    r"(?:/)?(?:assets|ui|lang|ships|box|drones|equip|extras|maps|missiles|ore|"
    r"portals|ranks|corps|base|audio|shop|icons|turrets|resources|textures|sprites)"
    r"[A-Za-z0-9_./@+\-]*\.(?:json|html|css|js|png|svg|webp|jpg|jpeg|woff2?|ogg|wav|atlas)"
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


def expand_path_candidates(raw: str) -> set[str]:
    rel = normalize_path(raw)
    if not rel:
        return set()
    candidates = {rel}
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
    end = data.find(b"IEND\xaeB\x60\x82", start)
    if end < 0:
        return None
    return data[start : end + 8]


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
    if size <= 12 or start + size > len(data):
        return None
    return data[start : start + size]


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


def extract_text_until_marker(data: bytes, start: int, ext: str) -> bytes | None:
    if ext == ".json":
        payload = extract_json_text(data, start)
        if payload:
            return payload
    if ext == ".atlas":
        end = data.find(b"\x00", start)
        if end > start:
            payload = data[start:end]
            if b"\n" in payload[:2048] and len(payload) < 2_000_000:
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
        head = path.read_bytes()[:16]
    except OSError:
        return False
    return head.startswith(b"RIFF") and b"WEBP" in head[:16]


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
        if ext not in {".json", ".webp"}:
            return False
    target_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source_path, target_path)
    return True


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
    }
    for target, source in aliases.items():
        copy_asset_alias(out_dir, source, target)


def extract_payload(data: bytes, path: str, offset: int, brotli_bin: str | None) -> bytes | None:
    raw_path = path.encode()
    start = offset + len(raw_path)
    ext = Path(path).suffix.lower()

    for delta in range(0, 9):
        probe = start + delta
        for extractor in (extract_png, extract_jpeg, extract_riff, extract_woff, extract_svg, extract_ogg):
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


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: extract_redgalaxy_web.py /path/to/redgalaxy-client.exe /output/dir", file=sys.stderr)
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

    data = exe.read_bytes()
    out_dir.mkdir(parents=True, exist_ok=True)

    pending = discover_paths_from_binary(data)
    extracted: set[str] = set()
    failed: set[str] = set()

    for _ in range(4):
        progress = False
        for path in sorted(pending):
            rel = normalize_path(path)
            if not rel or rel in extracted or rel in failed:
                continue
            offsets = []
            search_paths = [path]
            if path.startswith("/"):
                search_paths.append(path[1:])
            else:
                search_paths.append("/" + path)
            for search_path in dict.fromkeys(search_paths):
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

            payload = None
            for search_path, off in offsets[:20]:
                payload = extract_payload(data, search_path, off, brotli_bin)
                if payload:
                    break
            if payload:
                write_file(out_dir, rel, payload)
                extracted.add(rel)
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
    ensure_runtime_asset_aliases(out_dir)

    print(f"extracted={len(extracted)} failed={len(failed)} output={out_dir}")
    if failed:
        sample = sorted(failed)[:80]
        print("failed_sample:")
        for item in sample:
            print(f"  {item}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

# RedGalaxy Mac Runner / Bastion / Native

Runner gratuito per installare e testare `~/Desktop/RedGalaxy-Setup.exe` su macOS senza CrossOver, abbonamenti o wrapper commerciali.

**Scope di questo progetto:** solo **RedGalaxy**, **RedGalaxy Native**, **RedGalaxy Bastion** (Mac + Windows). RedUniverse non fa parte del workflow e i build script lo rifiutano.

## Modalita principale: native-web

Il client RedGalaxy installato dall'EXE e' una app Tauri/WebView2. Su questo Mac il runtime Windows parte con Wine, ma WebView2 crasha durante l'inizializzazione Vulkan/MoltenVK. Per evitarlo, il runner estrae HTML, JS, CSS, immagini, font e lingue direttamente dal client Windows, poi li serve in locale dal browser del Mac.

Avvio consigliato:

```bash
./bin/redgalaxy-mac-runner serve-web-foreground
```

Oppure doppio clic su:

```text
Apri RedGalaxy.command
```

URL locale:

```text
http://127.0.0.1:8765/
```

Tieni aperta la finestra Terminale avviata dal comando. Chiudendola, il server locale si ferma.

Stop per eventuali processi in background:

```bash
./bin/redgalaxy-mac-runner stop
```

## Pacchetto installabile (RedGalaxy Native)

App nativa macOS, senza Wine e senza Python sul Mac di destinazione. Contiene gli asset web gia' estratti e avvia un piccolo server locale integrato.

```bash
./tools/build_redgalaxy_dmg.sh
```

Output:

```text
dist/RedGalaxy-Native.dmg   # contiene RedGalaxy Native.app
```

## Variante Story / Bastion (click automatici / narrativa)

DMG macOS + exe Windows per **guidare la nave in autonomia**:

```bash
./tools/build_redgalaxy_story_dmg.sh      # → dist/RedGalaxy-Bastion.dmg
./tools/build_redgalaxy_bastion_exe.sh    # → dist/RedGalaxy-Bastion.exe (+ zip)
```

Default brand: **redgalaxy only**. `BASTION_BRAND=both` / `reduniverse` sono rifiutati.

Avvio bot dopo login: `http://127.0.0.1:8765/?auto=1`

Dettagli: `tools/story/README.md`, `tools/windows-bastion/README.md`.

Manifest update in-app: `tools/bastion-latest.json` (RedGalaxy Bastion only).

## Aggiornamenti (senza rifare il DMG ogni volta)

Le app Mac controllano all’avvio il manifest ufficiale e offrono **Gioco → Aggiorna gioco…**:

```text
https://updates.redgalaxygame.space/pc/latest.json
```

### RedGalaxy Native (solo gioco ufficiale)

```bash
./bin/redgalaxy-mac-runner check-updates
./bin/redgalaxy-mac-runner update-native --yes --silent
```

| | Path |
|--|------|
| Asset aggiornati | `~/Library/Application Support/RedGalaxy Native/web` |
| Log update | `~/Library/Logs/RedGalaxy Native/` |
| Fallback | web in `RedGalaxy Native.app/Contents/Resources/web` |

### RedGalaxy Bastion (stesso flusso + patch story)

```bash
REDGALAXY_BASTION=1 ./bin/redgalaxy-mac-runner update-bastion --yes --silent
```

| | Path |
|--|------|
| Asset aggiornati | `~/Library/Application Support/RedGalaxy Bastion/web` |
| Log update | `~/Library/Logs/RedGalaxy Bastion/` |
| Fallback | web incluso nel `.app` |

## Comandi utili

```bash
./bin/redgalaxy-mac-runner doctor
./bin/redgalaxy-mac-runner install --silent
./bin/redgalaxy-mac-runner extract-web
./bin/redgalaxy-mac-runner serve-web-foreground --no-open
```

## Dipendenze

- `python3`
- `brotli` (Homebrew) per decomprimere gli asset Tauri
- Wine locale gratuito solo per eseguire l'installer Windows e ottenere il client; non e' usato per giocare in modalita `native-web`

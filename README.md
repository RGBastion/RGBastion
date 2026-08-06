# RedUniverse Mac Runner (ex RedGalaxy)

Runner gratuito per installare e testare `~/Desktop/RedGalaxy-Setup.exe` su macOS senza CrossOver, abbonamenti o wrapper commerciali.

## Modalita principale: native-web

Il client RedGalaxy installato dall'EXE e' una app Tauri/WebView2. Su questo Mac il runtime Windows parte con Wine, ma WebView2 crasha durante l'inizializzazione Vulkan/MoltenVK. Per evitarlo, il runner estrae HTML, JS, CSS, immagini, font e lingue direttamente da `reduniverse-pc-client.exe`, poi li serve in locale dal browser del Mac.

Avvio consigliato:

```bash
./bin/redgalaxy-mac-runner serve-web-foreground
```

Oppure doppio clic su:

```text
~/Desktop/Apri RedUniverse.command
RedUniverse Native Web.command
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

## Pacchetto installabile

Ho aggiunto anche una app nativa macOS, senza Wine e senza Python sul Mac di destinazione. L'app contiene gli asset web gia' estratti e avvia un piccolo server locale integrato.

DMG generato:

```text
dist/RedUniverse-Native.dmg
```

Dentro al DMG c'e' `RedUniverse Native.app`. Trascinala in `Applications` e aprila: sceglie `127.0.0.1:8765` se libero, altrimenti prova le porte successive, e apre una finestra dedicata della app (embed) con il gioco.

Se al momento del build manca Swift/Xcode, l'app torna automaticamente al launcher legacy (che apre il browser esterno), altrimenti viene usata la shell WebView integrata.

Il file `RedUniverse Native Web.command` ora lancia l'app solo se disponibile l'host embed (`redgalaxy-native-host`); altrimenti usa il launcher CLI in `serve-web-foreground`.

Per rigenerare il DMG:

```bash
./tools/build_redgalaxy_dmg.sh
```

## Variante Story / Bastion (click automatici / narrativa)

Esiste una DMG macOS per **guidare la nave in autonomia**:

- click casuali sulla **minimappa**
- raccolta automatica dei **bonus box**
- funziona in background mentre usi il Mac

```bash
./tools/build_redgalaxy_story_dmg.sh
```

Output: `dist/RedUniverse-Bastion.dmg` con `RedUniverse Bastion.app`.

Avvio bot dopo login: `http://127.0.0.1:8765/?auto=1`

Dettagli: `tools/story/README.md`.

### Windows (.exe)

Stesso contenuto story/autopilot, host Electron (finestra nativa + server HTTP locale su `127.0.0.1:8765`).

```bash
# Da macOS/Linux (produce almeno il .zip Windows; .exe portable se c'e' Wine)
./tools/build_redgalaxy_bastion_exe.sh

# Su Windows (PowerShell + Git Bash/WSL)
.\tools\build_redgalaxy_bastion_exe.ps1
```

Artifact tipici:

```text
dist/RedUniverse-Bastion.exe              # portable single-file (anche buildabile da macOS)
dist/RedUniverse-Bastion-1.0.2-x64.zip    # cartella Electron unpackata
dist/windows-bastion/                   # output completo electron-builder
```

Licenza prodotto: `redgalaxy-story` (invariata). Dettagli: `tools/windows-bastion/README.md`.

## Aggiornamenti (senza rifare il DMG ogni volta)

Entrambe le app Mac controllano all’avvio il manifest ufficiale e offrono **Gioco → Aggiorna gioco…**:

```text
https://pub-792ad9615ccc4d05840f6f77a6fb33b9.r2.dev/updates/latest.json
```

L’updater scarica l’installer ufficiale, estrae il client web (brotli incluso nel `.app`) e scrive in Application Support. Se l’update fallisce, resta il web incluso nel bundle.

### RedUniverse Native (solo gioco ufficiale)

Nessuna patch Bastion/story: solo gli asset ufficiali del gioco. Dopo l’update l’app ricarica da sola.

Dall’app: dialogo all’avvio / menu **Gioco → Aggiorna gioco…**.

Da CLI:

```bash
./bin/redgalaxy-mac-runner check-updates
./bin/redgalaxy-mac-runner update-native --yes --silent
```

| | Path |
|--|------|
| Asset aggiornati | `~/Library/Application Support/RedUniverse Native/web` |
| Log update | `~/Library/Logs/RedUniverse Native/` |
| Fallback | web in `RedUniverse Native.app/Contents/Resources/web` |

### RedUniverse Bastion (stesso flusso + patch story)

Bastion aggiorna gli asset **ufficiali** del gioco e riapplica autopilot/hook Bastion.

```bash
REDGALAXY_BASTION=1 ./bin/redgalaxy-mac-runner update-bastion --yes --silent
```

Oppure dall’app: all’avvio (dialogo) / menu **Gioco → Aggiorna gioco…** / tab **Sicurezza → Aggiorna gioco**.

| | Path |
|--|------|
| Asset aggiornati | `~/Library/Application Support/RedUniverse Bastion/web` |
| Log update | `~/Library/Logs/RedUniverse Bastion/` |
| Fallback | web incluso nel `.app` |

Dettagli: `tools/story/README.md`.

Nota: il pacchetto risolve l'avvio locale del client web. Il gioco continua comunque a dipendere dai server RedGalaxy esterni per login/API e connessione realtime.

## Comandi utili

Diagnosi:

```bash
./bin/redgalaxy-mac-runner doctor
```

Installa dall'EXE, se serve rifarlo:

```bash
./bin/redgalaxy-mac-runner install --silent
```

Rigenera solo gli asset web:

```bash
./bin/redgalaxy-mac-runner extract-web
```

Avvia solo il server locale in primo piano, senza aprire il browser:

```bash
./bin/redgalaxy-mac-runner serve-web-foreground --no-open
```

## Stato del test

Installazione Windows completata. Client installato:

```text
~/Library/Application Support/RedUniverse Mac Runner/prefix/drive_c/users/andersonguillin/AppData/Local/RedGalaxy/reduniverse-pc-client.exe
```

Estrazione native-web completata in:

```text
artifacts/redgalaxy-native-web
```

Verifiche eseguite:

- Asset estratti: 560 file, inclusi logo, lingue, font, UI, audio completi e sfondi mappa.
- `index.html`: HTTP 200.
- `redgalaxy.png`: HTTP 200.
- `lang/tr.json`: HTTP 200 e JSON valido.
- Browser locale: titolo `RedGalaxy`, canvas presente, schermata login tradotta, nessuna immagine rotta, nessun errore console.
- DMG `dist/RedUniverse-Native.dmg`: creato e verificato con checksum valido.
- Server nativo dentro `RedUniverse Native.app`: `index.html` e `assets/index-uwR9Xy88.js` testati con HTTP 200.
- API esterne `aws-prod-api.redgalaxygame.space` e `aws-api.redgalaxygame.space`: raggiungibili via HTTPS.
- Server realtime `aws-prod-game.redgalaxygame.space:2567` e `aws-game.redgalaxygame.space:2567`: porta TCP raggiungibile.

Non ho inviato credenziali ne' eseguito login su server esterni.

## Dipendenze

- `python3`, gia' disponibile su macOS in questo ambiente.
- `brotli`, installato con Homebrew per decomprimere gli asset Tauri.
- Wine locale gratuito solo per eseguire l'installer Windows e ottenere `reduniverse-pc-client.exe`; non e' usato per giocare nella modalita `native-web`.

## AntiBot Lab

Ho aggiunto anche uno strumento difensivo per analizzare telemetria e replay senza creare un bot operativo:

```bash
./tools/redgalaxy_antibot_lab.py make-sample artifacts/antibot-sample.jsonl
./tools/redgalaxy_antibot_lab.py analyze artifacts/antibot-sample.jsonl
```

Documentazione: `docs-antibot-lab.md`.

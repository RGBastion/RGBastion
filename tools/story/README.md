# RedGalaxy Bastion / Autopilot

Variante DMG/exe con bot **autonomo** che gioca da solo mentre usi il Mac o Windows.

Questo workflow produce **solo RedGalaxy Bastion** (Mac + Windows). RedUniverse non fa parte del progetto.

## Build

### macOS DMG

```bash
./tools/build_redgalaxy_story_dmg.sh
```

Output: `dist/RedGalaxy-Bastion.dmg`

### Windows .exe / .zip

```bash
./tools/build_redgalaxy_bastion_exe.sh
# oppure su Windows:
# .\tools\build_redgalaxy_bastion_exe.ps1
```

Output tipico: `dist/RedGalaxy-Bastion-*-x64.zip` e `dist/RedGalaxy-Bastion.exe`.

Vedi `tools/windows-bastion/README.md`.

## Aggiornamenti gioco (in-app, senza rifare DMG/exe)

Bastion può scaricare gli **asset web ufficiali** RedGalaxy e riapplicare i layer Bastion (autopilot, i18n, hook `__RG_*`).

### Cosa si aggiorna / cosa resta Bastion

| Aggiornato dal CDN ufficiale | Resta sotto controllo Bastion |
|------------------------------|-------------------------------|
| HTML/JS/CSS/immagini/mappe/lingue del gioco | `story/autopilot.js`, `story/i18n.js`, `map_graph`, script narrativi |
| Versione client (es. 0.6.18) | Licenza, pannello UI, host Mac/Windows |

Asset aggiornati (scrivibili, fuori dal bundle):

```text
macOS:  ~/Library/Application Support/RedGalaxy Bastion/web
Windows: %APPDATA%/redgalaxy-bastion/game-web/web
```

Se l'update fallisce, l'app continua con gli asset inclusi nel bundle.

### Uso (utente)

1. Apri **RedGalaxy Bastion**
2. All'avvio, se c'è una versione ufficiale più nuova → dialogo **Aggiorna ora**
3. Oppure: menu **Gioco → Aggiorna gioco…** (Mac) / tab **Sicurezza → Aggiorna gioco**
4. Dopo l'update Mac ricarica da solo; su Windows serve Python 3 (`py`/`python`) + brotli per l'estrazione

### Uso (sviluppo / CLI)

```bash
# Controlla versione ufficiale
./bin/redgalaxy-mac-runner check-updates

# Aggiorna asset Bastion (download installer → Wine install → extract → patch story)
REDGALAXY_BASTION=1 ./bin/redgalaxy-mac-runner update-bastion --yes --silent
```

Manifest ufficiale:

```text
https://updates.redgalaxygame.space/pc/latest.json
```

### Rebuild completo (solo se cambi host/autopilot/licenza)

```bash
./tools/build_redgalaxy_story_dmg.sh
./tools/build_redgalaxy_bastion_exe.sh
```

Vedi anche `README.md` (sezione aggiornamenti).

## Modalità Autonomo (priorità)

Comportamento base:

1. **Click casuali sulla minimappa** → la nave si sposta come un giocatore reale
2. **Se vede un bonus box** → va a raccoglierlo in autonomia
3. Poi riprende a esplorare

### Uso

1. Installa `RedGalaxy Bastion.app`
2. Fai login ed entra in mappa
3. Clicca **Play** nel pannello
4. Puoi passare ad altre app: il bot continua a lavorare

Avvio automatico dopo login:

```text
http://127.0.0.1:8765/?auto=1
```

### Background / usa il PC mentre lavora

Il gioco di default si **ferma** quando la finestra perde focus (`document.hidden` + pausa Phaser).

L'autopilot applica un keep-alive che:

- mantiene il gioco "visibile" per il client
- forza `resume()` se Phaser va in pausa
- continua a inviare `sendMove` al server

**Consiglio pratico:** lascia `RedGalaxy Bastion.app` aperta (anche dietro altre finestre). Non chiuderla. Su macOS funziona bene in background; se minimizzi troppo a lungo il sistema può rallentare i timer, ma non dovrebbe fermarsi del tutto.

## Pannello

| Pulsante | Azione |
|----------|--------|
| **Autonomo** | Avvia loop minimappa + bonus box |
| **Pausa** | Mette in pausa il bot |
| **Stop** | Ferma tutto |
| **Storia demo** | Script JSON narrativo (fase 2) |
| **⚙ Impostazioni** | Accanto a minimizza/sfera: licenza, lingua, Device ID, zoom UI app (75–125%, solo pannello Bastion) |

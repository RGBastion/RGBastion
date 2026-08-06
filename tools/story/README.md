# RedUniverse Bastion / Autopilot

Variante DMG con bot **autonomo** che gioca da solo mentre usi il Mac.

## Build

### macOS DMG

```bash
./tools/build_redgalaxy_story_dmg.sh
```

Output: `dist/RedUniverse-Bastion.dmg`

### Windows .exe / .zip

```bash
./tools/build_redgalaxy_bastion_exe.sh
# oppure su Windows:
# .\tools\build_redgalaxy_bastion_exe.ps1
```

Output tipico: `dist/RedUniverse-Bastion-*-x64.zip` e, se disponibile, `dist/RedUniverse-Bastion.exe`.

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
macOS:  ~/Library/Application Support/RedUniverse Bastion/web
Windows: %APPDATA%/reduniverse-bastion/game-web/web
```

Se l'update fallisce, l'app continua con gli asset inclusi nel bundle.

### Uso (utente)

1. Apri **RedUniverse Bastion**
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
https://pub-792ad9615ccc4d05840f6f77a6fb33b9.r2.dev/updates/latest.json
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

1. Installa `RedUniverse Bastion.app`
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

**Consiglio pratico:** lascia `RedUniverse Bastion.app` aperta (anche dietro altre finestre). Non chiuderla. Su macOS funziona bene in background; se minimizzi troppo a lungo il sistema può rallentare i timer, ma non dovrebbe fermarsi del tutto.

## Pannello

| Pulsante | Azione |
|----------|--------|
| **Autonomo** | Avvia loop minimappa + bonus box |
| **Pausa** | Mette in pausa il bot |
| **Stop** | Ferma tutto |
| **Storia demo** | Script JSON narrativo (fase 2) |
| **⚙ Impostazioni** | Accanto a minimizza/sfera: licenza, lingua, Device ID, zoom UI app (75–125%, solo pannello Bastion) |

Contatore **Bonus raccolti** in tempo reale.

### Note UI recenti

- **Compra automatica chiavi booty** sta nel tab Raccolta, accanto a Bauli (non più in Sicurezza).
- **Deriva portale** (opt-in, Attacco): lieve bias verso il portale alleato durante l’orbita su mappe standard.
- **Usa SAP Scudo in fuga PvP** (opt-in, Sicurezza): spara SAP al inseguitore senza cambiare il percorso di fuga.
- Su mappe standard, se accerchiato / bloccato in angolo in orbita, breakout leggero (stile raid gate) senza FSM danger.

## Avvio manuale

L'app **non parte più da sola**. Dopo login in mappa:

1. Seleziona uno o più **tipi NPC** (clic multiplo; anche se non visibili in mappa)
2. Premi **Play** → autonomo (bonus + esplorazione) e, se hai scelto NPC, anche attacco
3. **Stop** ferma tutto

## NPC e combattimento

Elenco tipi NPC ordinato per **forza crescente**: base → Elite per famiglia, poi tutti i Commander nello stesso ordine, infine boss speciali. Clicca per **selezionare/deselezionare** più tipi. Pulsante **✕** azzera la selezione.

## Mappa / Sector X / refresh galattico

- I portali diretti tra fazioni nemiche (ex x-3 H/N/O) sono rimossi: per raggiungere una mappa nemica il path passa da **Sector X**.
- All’avvio dopo un aggiornamento Bastion, e a ogni cambio mappa, l’autopilot unisce i **portali live** del client in `MAP_GRAPH` (senza reintrodurre scorciatoie cross-faction).
- Per un refresh “galattico” completo servirebbe visitare le mappe (o un export ufficiale del grafo): fino ad allora il grafo statico + harden runtime + merge portali è sufficiente al travel.

## Bonus

Il contatore bonus usa l'evento server `bonusBoxCollected` (re-registrato dopo ogni login).

Da console:

```javascript
RedGalaxyStory.listNpcTypes()
RedGalaxyStory.selectNpcType("RAIDON")
RedGalaxyStory.attackSelected()
RedGalaxyStory.stopCombat()
```

## API console

```javascript
RedGalaxyStory.startAuto()
RedGalaxyStory.stopAuto()
RedGalaxyStory.listBonusBoxes(2000)
RedGalaxyStory.clickMinimapRandom()
RedGalaxyStory.getShipPosition()
```

## Storia (fase 2)

Quando la modalità autonoma base funziona, si passa a script JSON con capitoli, didascalie e sequenze fisse.

Vedi step disponibili nel file precedente (`caption`, `move`, `patrol`, ecc.) in `tools/story/scripts/`.

## Personalizzazione autonomo

Parametri in cima a `tools/story/redgalaxy_story_autopilot.js` (oggetto `AUTO`):

| Campo | Default | Significato |
|-------|---------|-------------|
| `bonusRadius` | 2200 | Distanza max per cercare bonus box |
| `wanderMinMs` / `wanderMaxMs` | 2200–5200 | Pausa tra click minimappa |
| `tickMs` | 350 | Frequenza decisionale del bot |

Dopo modifiche:

```bash
./tools/prepare_redgalaxy_story_web.sh
# oppure rebuild completo DMG
./tools/build_redgalaxy_story_dmg.sh
```

## Licenze

Il secret HMAC è `LICENSE_HMAC_SECRET` in `tools/story/redgalaxy_story_autopilot.js` (embedded nella build).

Genera una chiave (il generatore legge automaticamente quel secret se `RG_STORY_LICENSE_SECRET` non è impostato):

```bash
# Chiave legata al Device ID del cliente (tab Sicurezza → copia ID)
node tools/story/generate_story_license.js 30 --device=RGD-0123ABCD4567EF89

# Verifica locale di una chiave
node tools/story/generate_story_license.js --verify='RG1....'
```

Dopo aver cambiato `LICENSE_HMAC_SECRET`, rifai prepare + build exe/dmg, altrimenti le nuove chiavi non matcheranno le app già distribuite.

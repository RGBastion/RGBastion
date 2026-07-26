# RedGalaxy Bastion Autopilot — Audit di coesistenza delle funzionalità

**Fonte principale:** `tools/story/redgalaxy_story_autopilot.js`  
**Gate correlati:** `tools/story/i18n.js` (solo testi UI; il comportamento è governato nell’autopilot)  
**Data audit:** 2026-07-26  
**Ambito:** sticky del bersaglio, movimento in combattimento, cargo, morte/fuga, raid/PvP, toggle delle impostazioni, ramificazione per modalità mappa  

I numeri di riga si riferiscono al file workspace **post-fix**, salvo dove indicato **(pre-fix)**.

---

## Sintesi esecutiva

Il bug confermato dall’utente — **la nave abbandona un NPC a metà attacco quando ne compare un altro di tipo diverso** — è reale e **non** era un mito di “priorità per bounty tier”. Derivava da due percorsi che cooperavano:

1. **Il type-sync azzera gli ID sticky** quando un nuovo tipo di NPC visibile viene unito alla selezione (`syncRaidNpcSelectionFromMap` → `refreshCombatTargetTypesFromSelection` azzerava `combatFocusId` / `combatTargetId`).
2. **Il combattimento raid ri-risolve a ogni tick** tramite `driveRaidCombatEngage` → `resolveRaidCombatTarget`, che **(pre-fix)** manteneva lo sticky solo per bersagli preferiti a HP bassi e altrimenti saltava a NPC più vicini / minaccia locale (spesso di tipo diverso).

**Correzione chirurgica applicata** (e sincronizzata su App Support `…/web/story/autopilot.js`):

- `refreshCombatTargetTypesFromSelection` — preserva lo sticky vivente attraverso gli aggiornamenti del set di tipi.
- `resolveRaidCombatTarget` — sticky-first: completa il preferito vivente prima di qualsiasi nuova acquisizione.
- `getFocusedCombatNpc` — mantiene il focus vivente anche se il set di tipi diverge momentaneamente.

**Conteggi verdetto (aree funzionalità sotto):** **OK 6 · RISCHIO 5 · FALLITO 1**  
(Il FALLITO era lo sticky/abbandono per tipo; marcato **FALLITO → CORRETTO** dopo la patch chirurgica. Gli elementi residui sono RISCHIO, non FALLITO.)

---

## CRITICO: Abbandono sticky / priorità di tipo

### Comportamento richiesto

Completare l’uccisione corrente (**bersaglio sticky**) prima di navigare/cliccare un altro NPC. **Nessun retarget per priorità di tipo a metà combattimento.** Abbandonare solo se morto / non valido / honor straniero / l’utente ferma esplicitamente il combattimento.

### Grafo esatto delle chiamate (ha bersaglio di combattimento corrente → seleziona nuovo NPC → clicca minimappa/entità)

```
mainTick (11055)
  └─ clearTaskIfDone (6501)          // only clears when confirmed gone
  └─ runCurrentTask (7349)
       ├─ [raid] driveRaidCombatEngage (6732)
       │     npc = resolveRaidCombatTarget(npc.id || taskTargetId)   // ★ every tick
       │     AUTO.task/focus/targetId = npc.id                       // ★ can overwrite
       │     setLockedTarget / engageNpc
       │     moveViaMinimap / applyCombatOrbit                       // clicks / soft moves
       └─ [std]  driveCombatEngage (6836)
             sticks to focusId via getNpcEntry / getStickyCombatNpcEntry
  └─ pickNewTask (6616) only if no currentTask
       ├─ [raid] startRaidCombatTask → engageRaidNearestEnemy → resolveRaidCombatTarget()
       └─ [std]  getFocusedCombatNpc → startCombatTask

Parallel (UI ~1s):
  ensureUiLoop → syncRaidNpcSelectionFromMap (4139)
    → refreshCombatTargetTypesFromSelection (4089)   // ★ cleared focus (pre-fix)
```

### Funzioni + intervalli di riga (sticky / acquisizione / filtri)

| Funzione | Righe | Ruolo |
|---|---|---|
| `listNpcs` | 5989–6014 | NPC vivi ordinati per distanza; filtrati per honor |
| `listNpcsByType` | 4000–4025 | Come sopra, filtrati a un solo tipo |
| `nearestNpcOfType` | 6954–6957 | Più vicino di un tipo |
| `nearestNpcOfTypes` | 4027–4036 | Più vicino tra i tipi selezionati (solo distanza — **nessun punteggio bounty tier**) |
| `resolveCombatTarget` | 6429–6431 | `nearestNpcOfTypes(combatTargetTypes)` |
| `getFocusedCombatNpc` | 6426–6475 | Risolutore sticky standard |
| `getNpcEntry` / `getStickyCombatNpcEntry` | 6104–6198 | Lookup combattibile; sticky ignora esclusione honor breve |
| `isNpcStillFightable` | 6035–6047 | Tollerante a flicker HP/vivo |
| `isCombatTargetConfirmedGone` | 6067–6093 | Conferma prima del retarget |
| `sustainCombatOnStickyId` | 6104–6114 | Lock/fuoco durante frame brevemente invalidi |
| `resolveRaidCombatTarget` | 6201–6254 | Raid sticky-first (post-fix) |
| `driveRaidCombatEngage` | 6732–6834 | Tick raid: ri-risolve + orbit/spara |
| `driveCombatEngage` | 6836–6947 | Tick standard: sticky sull’id passato |
| `refreshCombatTargetTypesFromSelection` | 4089–4106 | Sincronizza set tipi; **non deve azzerare sticky vivente** |
| `syncRaidNpcSelectionFromMap` | 4139–4164 | Aggiunge tipi appena visibili → refresh |
| `pickRaidThreatCombatTarget` / `scoreRaidThreatTarget` | 4618–4666 | Scoring distanza/attaccante — **non priorità di tipo**; inutilizzati sul hot path |
| `pickRaidEdgeCombatTarget` | 4684–4716 | Scoring bordo-sciame; inutilizzato sul hot path |
| `hasCloserRaidThreatThan` | 4719–4729 | Helper minaccia più vicina; residuo |
| `handleEntityKill` | 3416–3447 | Solo HP≤0; rifiuta flicker vivente |
| `clearTaskIfDone` | 6501–6572 | Pulisce combat solo dopo confirmed gone |
| `pickNewTask` / `startCombatTask` | 6616–6644 / 6574–6592 | Nuova acquisizione solo a task vuoto |

### Comportamento previsto vs pre-fix

**Previsto:** sticky fino a finish-kill.  
**Raid pre-fix:** sticky solo quando il preferito era “low HP”; altrimenti vinceva nearest / minaccia locale — **hop di distanza indipendente dal tipo**, che *sembra* priorità di tipo quando un nuovo tipo spawn più vicino o viene sincronizzato nella lista.  
**Sync pre-fix:** nuovo tipo visibile → `refreshCombatTargetTypesFromSelection` impostava `combatFocusId = null` e `combatTargetId = null` mentre un combattimento era ancora aperto.

### Ipotesi di causa radice (con evidenza)

**Primaria A — il type sync azzera lo sticky (corrispondenza esatta a “vede un tipo diverso”):**

```4089:4106:tools/story/redgalaxy_story_autopilot.js
  function refreshCombatTargetTypesFromSelection() {
    if (!AUTO.combatActive) return;
    AUTO.combatTargetTypes = new Set(AUTO.selectedNpcTypes);
    // New NPC types appearing (raid sync / preset merge) must NOT abandon a living sticky
    // mid-kill — that looked like type-priority retarget when a different type spawned.
    const stickyId =
      AUTO.combatFocusId || AUTO.combatTargetId || AUTO.taskTargetId || null;
    if (
      stickyId &&
      (isNpcStillFightable(stickyId) ||
        getNpcSprite(stickyId)?.alive ||
        !isCombatTargetConfirmedGone(stickyId))
    ) {
      return;
    }
    AUTO.combatFocusId = null;
    AUTO.combatTargetId = null;
  }
```

**(Il corpo pre-fix era solo: copia del set + `combatFocusId/combatTargetId = null` incondizionato.)**  
Caller quando un nuovo tipo appare sulla mappa raid:

```4139:4163:tools/story/redgalaxy_story_autopilot.js
  function syncRaidNpcSelectionFromMap() {
    ...
    AUTO.selectedNpcTypes = types;
    ...
    refreshCombatTargetTypesFromSelection();
```

Invocato anche dal loop UI (`ensureUiLoop` ~6980) e dagli hook net map (~3828, ~3851, ~3870).

**Primaria B — retarget raid a ogni tick (anche con focus ancora impostato):**

```6752:6771:tools/story/redgalaxy_story_autopilot.js
    npc = resolveRaidCombatTarget(npc?.id || AUTO.taskTargetId);
    ...
    AUTO.taskTargetId = npc.id;
    AUTO.combatTargetId = npc.id;
    AUTO.combatFocusId = npc.id;
```

**(Pre-fix) `resolveRaidCombatTarget` restava sullo sticky solo per preferito low-HP; altrimenti restituiva `localThreat` / nearest** — id/tipo diversi a metà combattimento.

**Non trovato:** priorità bounty-tier / lessicografica sul nome nel hot path. `nearestNpcOfTypes` è pura distanza. Il residuo `scoreRaidThreatTarget` usa distanza + attacco + HP danneggiati — non ranghi di famiglia aliena.

**Percorsi secondari di flicker (già mitigati, non il bug confermato):**

- `handleEntityKill` prematuro → kill conteggiato → `isCombatTargetConfirmedGone` true → clear (protetto da check fightable/alive a 3432–3435).
- `combatActive` false brevemente: `stopCombat` / sospensione flee — modalità diverse visibili all’utente.
- `markForeignNpc` azzera lo sticky sul grey lock honor — intenzionale.

### Correzione chirurgica consigliata — **APPLICATA**

1. **`refreshCombatTargetTypesFromSelection`:** aggiorna il set di tipi, ma **non azzerare lo sticky** mentre è vivente / non confirmed gone.
2. **`resolveRaidCombatTarget`:** se il preferito è ancora fightable / alive / non confirmed gone → **restituisci il preferito**; acquisizione nearest/local solo senza sticky.
3. **`getFocusedCombatNpc`:** mantieni il focus vivente anche se `combatTargetTypes` manca momentaneamente del suo tipo (divergenza di sync).

### Compatibilità dopo la correzione

**FALLITO → CORRETTO (OK per il contratto sticky).**  
Il raid acquisisce ancora il nearest quando lo sticky è sparito. Honor straniero / flee / scoop cargo possono ancora azzerare lo sticky in modo intenzionale.

---

## 1. Acquisizione bersaglio / sticky lock / retarget / filtri tipo / priorità

### Funzioni + intervalli di riga

`listNpcs` 5989–6014 · `listNpcsByType` 4000–4025 · `nearestNpcOfTypes` 4027–4036 · `resolveCombatTarget` 6429–6431 · `getFocusedCombatNpc` 6426–6475 · `resolveRaidCombatTarget` 6201–6254 · `engageNpc` 6306–6352 · `setLockedTarget` / `clearLockedTarget` 3899–3928 · `startCombatTask` 6574–6592 · `pickNewTask` 6616–6644 · `toggleNpcTypeSelection` 4038–4050 · `selectAllNpcTypes` 4058–4068 · `refreshCombatTargetTypesFromSelection` 4089–4106 · `syncRaidNpcSelectionFromMap` 4139–4164 · `handleNetLockOrShootFailed` 3935–3970 · `isNpcAllowedForCombat` 797–805 · `isOwnLockOnNpc` 749–761

### Comportamento previsto

I tipi NPC selezionati dall’utente filtrano la **nuova** acquisizione. Una volta impegnati, completare quell’NPC. Honor: non rubare grey lock stranieri; il proprio red lock vince sugli helper.

### Sintesi della logica attuale

- Standard: `pickNewTask` → sticky `getFocusedCombatNpc` → `driveCombatEngage` non ripesca un altro id mentre il task è aperto.
- Raid: `driveRaidCombatEngage` richiama `resolveRaidCombatTarget` a ogni tick (**ora sticky-first**).
- Il sync della lista tipi espande i tipi selezionabili sulle mappe raid; non deve resettare lo sticky.

### Interazioni / dipendenze

Dipende da `combatActive`, `combatTargetTypes`, `modeAttack`, filtri honor, timer confirmed-gone (`COMBAT_TARGET_GONE_CONFIRM_MS` 650, `FULL_REMOVE` 600).

### Compatibilità

**OK** (dopo la correzione sticky).  

### Modalità di fallimento note / teoriche

- `toggleNpcTypeSelection` **non** aggiorna `combatTargetTypes` a metà combattimento — la deselezione può non fermare lo sticky corrente fino al prossimo `refresh*` (RISCHIO altrove).
- Scorer residui inutilizzati (`pickRaidThreat*`) potrebbero confondere futuri caller se ricollegati sul hot path.

### Correzione consigliata

Nessuna ulteriore per lo sticky. Opzionale in seguito: `toggleNpcTypeSelection` dovrebbe aggiornare `combatTargetTypes` **senza** azzerare lo sticky (stesso pattern del refresh).

---

## 2. Orbit combat / stand-off / chase / Approach A / soft-move

### Funzioni + intervalli di riga

`getOrbitRadii` 5152–5175 · `getOrbitApproachPoint` 5323–5355+ · `shouldChaseCombatTarget` 5024–5030 · `shouldHoldOrbitDistance` 4232+ · `updateCombatOrbitEngagement` 4221–4240 · `applyCombatOrbit` 5634–5826 · `setMoveTargetDirect` 5460–5476 · `shouldKeepExistingMoveTarget` 5482–5522 · `moveViaMinimap` 5524–5570 · `clearCombatMoveTarget` 5032–5037 · `noteStdOrbitRadialSign` / `shouldSuppressStdInwardAfterHit` / `softenStdOrbitPointAfterHit` 5367–5412 · `driveStandardOrbitBreakout` 4415–4442 · `recoverRaidOrbitTangential` 5590–5615 · `isRaidOrbitMoveTooRadial` 5571–5588 · `biasRaidOrbitAwayFromForwardPack` 5170–5198

### Comportamento previsto

- **Approach A (raid):** movimento minimappa continuo dal primo engage (`driveRaidCombatEngage` ramo approach ~6788–6805).
- **Orbit ON:** kite π/2 centrato sull’NPC entro la banda laser.
- **Orbit OFF:** chase solo fuori del fire range; hold / clear move dentro.
- **Soft-move (standard):** limita lo spam di click minimappa + mantiene la heading esistente se quasi uguale.

### Sintesi della logica attuale

L’approach raid usa `getOrbitApproachPoint` + `moveViaMinimap` a ogni tick quando `dist > approachLimit`. Lo standard usa lo stesso helper di approach + gate soft-move. Il softener post-colpo allarga brevemente lo stand-off sulle mappe standard.

### Interazioni / dipendenze

`modeOrbit`, `isInRaidMap()`, divertitori heal/breakout (`isRaidHealActive`, `needsRaidWaveBreakout`, `needsStandardOrbitBreakout`), id bersaglio sticky (l’orbit segue chi è locked).

### Compatibilità

**RISCHIO**

### Modalità di fallimento note / teoriche

- Il soft-move `shouldKeepExistingMoveTarget` può trattenere brevemente un **vecchio waypoint** orientato a una geometria precedente dopo un retarget sticky (post-kill) — mitigato da reset `orbitNpcId` / softReset.
- Approach A raid è intenzionalmente **non** soft-gated (`moveViaMinimap` soft solo quando `!isInRaidMap`) — può sembrare nervoso ma preserva l’engage Story 3.
- Se lo sticky si rompesse di nuovo, orbit/click inseguirebbero subito il nuovo NPC (il movimento segue il resolve).

### Correzione consigliata

Nessuna chirurgica ora. Opzionale: resettare `AUTO.lastMinimapTarget` quando cambiano `orbitNpcId` / id sticky.

---

## 3. Portal drift + softClamp orbit circolare

### Funzioni + intervalli di riga

`applyPortalDriftBias` 4463–4478 · `softClampStdOrbitCircle` 4485–5544 · collegato dentro `applyCombatOrbit` ~5781–5818 · `toggleOrbitPortalDrift` 5898–5902 · `AUTO.orbitPortalDrift` default false (~255)

### Comportamento previsto

Bias gentile **opt-in** dei waypoint di orbit sulle **mappe standard** verso il portale amico più vicino; freeze vicino al portale così il combat resta circolare; softClamp preserva il raggio vicino ai bordi mappa (evita ovale).

### Sintesi della logica attuale

Drift spento in raid. Blend 12% quando lontano dal portale; freeze ≤560. Con drift attivo usa `clampToPlayArea` (non softClamp) così l’attrazione non viene cancellata; il percorso freeze softClampa per il cerchio.

### Interazioni / dipendenze

Richiede `modeOrbit` + tick orbit combat; conflitto con approach radiale duro se drift + softener inward gareggiano (gestito: driftActive mantiene l’angolo verso il portale).

### Compatibilità

**OK**

### Modalità di fallimento note / teoriche

- Il drift può far camminare lentamente il combattimento sulla mappa mentre lo sticky continua — by design; può sembrare “lasciare” una pocket di spawn restando sull’NPC stesso.
- Hint solo i18n (`ui.orbit_portal_drift_hint`); il toggle non azzera lo sticky.

### Correzione consigliata

Nessuna.

---

## 4. Wander / `shouldSuppressWander`

### Funzioni + intervalli di riga

`shouldSuppressWander` 10976–10999 · `driveWanderTick` 11001–11053 · `scheduleNextWander` 10962–10970 · chiamato da `mainTick` 11109–11113

### Comportamento previsto

Wander solo quando non si combatte / scoopa / fugge / recupera. Un `combatActive` nudo senza bersaglio **non** deve bloccare l’esplorazione mappa.

### Sintesi della logica attuale

Sopprime su post-morte, flee, cargo pending, task combat aperto, finestra confirmed-gone, `isCombatEngaged()`, o id sticky focus vivente.

### Interazioni / dipendenze

Se lo sticky si azzera erroneamente a metà combattimento, il wander può partire (“Esplorazione”) — era un sintomo del bug di abbandono.

### Compatibilità

**OK**

### Modalità di fallimento note / teoriche

- Gap: `combatActive` true, focus null, `currentTask` null → race wander + `pickNewTask`; previsto per l’acquisizione.

### Correzione consigliata

Nessuna (la correzione sticky rimuove il false wander a metà kill).

---

## 5. Raccolta cargo / grey straniero / pending / hold latch

### Funzioni + intervalli di riga

`notePendingCombatCargo` 2945–2999 · `shouldSupersedePendingCombatCargo` 2919–2933 · `pauseCombatForPostKillCargo` 3228–3240 · `drivePendingCombatCargoTick` 3248–3414 · `tryStartPostKillCargoCollect` 3108+ · `finishCombatCargoCollect` 909+ · `isForeignOwnedLoot` / `isAllowedCombatCargo` 723–960 · `blockCargoUntilHoldFrees` / `refreshCargoSkipGate` / `canCollectCargoNow` 1079–1122 · `markCargoSettledForNpc` 891+ · `clearFalsePendingCargoForLivingTarget` 6095–6101 · `tryOpportunisticCollect` 6665–6697 · scoop stage-clear `maybeDriveRaidStageClearCargo` 10190–10221

### Comportamento previsto

Dopo kill **propria** confermata con cargo abilitato: arma pending una volta, scoop loot visibile/consentito, non soft-chase aria vuota all’infinito, onora cargo straniero, hold-full latch con TTL re-probe.

### Sintesi della logica attuale

Mappe standard: dopo confirmed gone, lo scoop preempta il combat (`pauseCombatForPostKillCargo` azzera focus/task). Raid: a metà combattimento preempta solo se cargo visibile; time-box stage-clear scoopa i resti.

### Interazioni / dipendenze

**Azzera lo sticky di proposito** dopo la kill (`pauseCombatForPostKillCargo`). Lo sticky vivente non deve armare pending fantasma (`clearFalsePendingCargoForLivingTarget`). La raccolta bonus opportunistica tiene l’attacco (`keepAttack: true`) e ri-engage lo stesso npc.

### Compatibilità

**RISCHIO**

### Modalità di fallimento note / teoriche

- `pauseCombatForPostKillCargo` azzera il focus — corretto post-kill; se armato mentre l’NPC è ancora vivo (false kill), esistono percorsi di reclaim sticky ma è possibile un hop breve.
- Supersede pending su kill più recente può abbandonare uno scoop in corso per una kill più vecchia (intenzionale documentato per farm dense).
- Hold latch `cargoSkipUntilUsedBelow` + `CARGO_SKIP_REPROBE_MS` — false latch eventualmente si recupera.

### Correzione consigliata

**Non** modificare a metà combattimento sticky. Opzionale: non chiamare mai `pauseCombatForPostKillCargo` salvo `isCombatTargetConfirmedGone(npcId)`.

---

## 6. Morte / riparazione / recover post-morte / resume

### Funzioni + intervalli di riga

`registerPlayerDeath` 8431+ · `tryAutoRepairAfterDeath` 8626+ · `beginPostDeathRecover` / `finishPostDeathRecoverAndResume` 8756–8781 · `drivePostDeathRecoverTick` 8790+ · `holdStillAtBase` 8709+ · `beginPreObjectiveHeal` 8734+ · `maybeResumeObjectiveAfterDeath` 8872+ · `checkPlayerDeathState` 8968+ · `resumeCombatAfterFlee` 6391–6416 · `processSecurityGates` 9994+ (possiede il tick recover)

### Comportamento previsto

Alla morte: ripara, resta fermo finché le config Attack+Roam sono completamente healate, poi riprende travel/objective; ri-arma il combat se sospeso per flee.

### Sintesi della logica attuale

`processSecurityGates` short-circuita mainTick nel recover. Il resume richiede full heal + selezione non vuota. Finestra di grace blocca false HP-flee dopo l’arrivo.

### Interazioni / dipendenze

Azzera/sospende il combat durante il percorso morte; sticky intenzionalmente rotto fino al resume. Travel mappa (`NAV`) e attesa portale gate-ano il resume.

### Compatibilità

**OK**

### Modalità di fallimento note / teoriche

- Se il resume avvia il combat prima che gli id sticky siano ripristinati, il primo bersaglio è nearest dei tipi (acquisizione attesa).
- Debounce morte (`DEATH_SIGNAL_DEBOUNCE_MS` 900) — una false death può comunque interrompere brevemente lo sticky.

### Correzione consigliata

Nessuna per la coesistenza sticky.

---

## 7. Raid gate / flee skirt / raid orbit

### Funzioni + intervalli di riga

`isInRaidMap` 8261–8268 · `driveRaidAutomation` 10146–10184 · `driveRaidCombatEngage` 6732–6834 · `applyCombatOrbit` (ramo raid) 5634+ · `softClampToRaidSupportZone` / `clampToRaidSupportZone` 9420–9460 · `maintainRaidSupportDuringCombat` 9462+ · `driveRaidHealTick` 9591+ · `getRaidBreakoutPoint` / `driveRaidWaveBreakout` 4740+ / 4952+ · `startRaidStageContinue` 9560+ · `getRaidAttackConfig` / `getRaidFleeConfig` 6720–6729 · `syncRaidNpcSelectionFromMap` 4139–4164 · `enableRaidCombatPreset` 4108–4115

### Comportamento previsto

Raid: preset attack+orbit, soft tether supporto torre, wave breakout, HP% heal-flee di lato poi ritorno, stage clear → finestra cargo → prossimo portale / stop all’ultimo stage.

### Sintesi della logica attuale

Heal possiede il movimento sull’orbit. Combat engage ri-risolve sticky-first. Type sync espande la selezione senza azzerare lo sticky (post-fix).

### Interazioni / dipendenze

**Massimo accoppiamento con lo sticky** (resolve a ogni tick + type sync). L’helper di attacco heal `sustainRaidHealAttack` chiama anche `resolveRaidCombatTarget` e scrive gli id focus (~8202–8227).

### Compatibilità

**RISCHIO**

### Modalità di fallimento note / teoriche

- Durante heal evade, sticky-first tiene ancora il preferito se vivente — può continuare a sparare a uno sticky lontano mentre kite; più sicuro per finish-kill, leggermente peggiore per nearest-threat durante la fuga.
- `RAID_GATE_NPC_TYPES` è array vuoti (81–86) — la selezione si affida a `selectAll` + merge visibili.
- Il movimento wave breakout usa l’npc corrente; la correzione sticky mantiene l’npc stabile.

### Correzione consigliata

Opzionale in seguito: durante `isRaidHealActive()`, consentire shoot-nearest temporaneo **senza** sovrascrivere lo sticky `combatFocusId` (separare “shoot id” vs “sticky id”). Non applicato — cambierebbe la semantica heal.

---

## 8. Fuga PvP / SAP

### Funzioni + intervalli di riga

`shouldFleeFromEnemyPlayers` 9756+ · `startEnemyPlayerFlee` 9764+ · `tryCloakForPvpFlee` 9790+ · `trySapShieldDuringPvpFlee` 9859+ · `updatePvpFleeHitTracker` / `isHostilePlayerFiringAtLocal` 9811–9851 · `toggleFleeEnemyPlayers` / `toggleFleeUseCloak` / `toggleFleeUseSap` 10353–10369 · `startMapFlee` 9484–9558 · `suspendCombatForFlee` 6418–6421

### Comportamento previsto

Fuga opt-in verso portale alleato da giocatori ostili; cloak opzionale; SAP opzionale solo sotto fuoco; **mai** reindirizzare il movimento di fuga per SAP.

### Sintesi della logica attuale

SAP preserva `moveTarget` / percorso NAV; solo ammo+lock. Flee azzera il task combat via `suspendCombatForFlee`.

### Interazioni / dipendenze

Abbandona intenzionalmente lo sticky per sopravvivenza. Toggle impostazioni nel pannello Security; solo chiavi di stato i18n.

### Compatibilità

**OK**

### Modalità di fallimento note / teoriche

- Lock SAP sul player poi resume combat non deve lasciare il lock player bloccato — il codice pulisce quando non sotto fuoco.
- Flee da nemici a metà kill è override sticky richiesto dall’utente.

### Correzione consigliata

Nessuna.

---

## 9. Red-lock proprio NPC vs helper

### Funzioni + intervalli di riga

`isOwnLockOnNpc` 749–761 · `isNpcEngagedByOtherPlayer` 763–795 · `isNpcAllowedForCombat` 797–805 · `markForeignNpc` 807–825 · `abandonForeignLockedTarget` 827–843 · `engageNpc` check straniero 6319–6338 · `clearTaskIfDone` ramo honor 6505–6514

### Comportamento previsto

Il proprio cerchio rosso vince; helper che sparano allo stesso NPC non devono forzare l’abbandono; grey lock straniero → mark foreign e retarget.

### Sintesi della logica attuale

Helper sugli id combat **correnti** restituiscono false da engaged-by-other. Nuove scelte di NPC già attaccati da altri sono bloccate. `markForeignNpc` azzera sticky e task.

### Interazioni / dipendenze

Può azzerare lo sticky a metà combattimento se il lock passa a foreign-owned (verità server). Reclaim sticky via `getStickyCombatNpcEntry` se ancora fightable e il proprio lock torna.

### Compatibilità

**OK** (contratto honor). **RISCHIO** residuo se `lockTargetOwnedByOther` flicker false-positive.

### Modalità di fallimento note / teoriche

- False foreign mark → `markForeignNpc` azzera sticky → al prossimo pick tipo diverso — può sembrare priorità di tipo; mitigato da own-lock win + eccezione helper.
- `abandonForeignLockedTarget` in cima agli engage driver ritorna early dopo clear — il tick successivo acquisisce nuovo bersaglio.

### Correzione consigliata

Solo se osservati foreign lock false-positive: debounce `lockTargetOwnedByOther` prima di `markForeignNpc` mentre `isNpcStillFightable`.

---

## 10. Toggle impostazioni che gate-ano movimento / combat

### Funzioni + intervalli di riga

`togglePlayMode` 5850–5865 · `toggleCollectOption` 5867–5873 · `toggleOrbitMode` 5887–5896 · `toggleOrbitPortalDrift` 5898–5902 · `toggleFlee*` / chiavi booty 10353–10371 · toggle ammo `toggleCombatAmmoType` 1294+ · toggle refinery 1684+ · UI: `updateModeButtons` 5892–5927 · label i18n in `tools/story/i18n.js` (nessuna logica)

### Comportamento previsto

Attack/collect/orbit/portal-drift/flee/SAP/cloak/ammo gate-ano i rispettivi sottosistemi senza riscrivere silenziosamente lo sticky, salvo quando Attack viene spento.

### Sintesi della logica attuale

Attack off → `clearNpcTypeSelection`. Il toggle orbit resetta lo stato orbit (direzione/fase) ma non gli id sticky. Portal drift è opt-in. I toggle flee impostano solo flag.

### Interazioni / dipendenze

`refreshCombatTargetTypesFromSelection` usato dai preset raid — preserva sticky dopo la fix. Checkbox NPC manuale non sincronizza `combatTargetTypes` fino a refresh/start.

### Compatibilità

**RISCHIO**

### Modalità di fallimento note / teoriche

- Spegnere Attack a metà combattimento azzera la selezione tipi; il combat può zoppicare fino a `stopCombat` / clear task.
- Toggle orbit `resetOrbitState` può far scattare il movimento mentre lo sticky continua (cosmetico).

### Correzione consigliata

Opzionale: al toggle attack off, chiamare esplicitamente `stopCombat()` per teardown sticky pulito.

---

## 11. Ramificazione modalità mappa che potrebbe cancellare lo sticky

### Funzioni + intervalli di riga

`isInRaidMap` 8261–8268 · ramo `runCurrentTask` 7391–7395 · `pickNewTask` raid vs std 6627–6635 · `clearTaskIfDone` retarget raid 6547–6550 · `pauseCombatForPostKillCargo` 3228–3240 · `driveRaidAutomation` 10146+ · `processSecurityMovement` 10126–10130 · ordine `mainTick` 11055–11113

### Comportamento previsto

Raid vs standard usano engage driver diversi; le regole sticky devono concordare. Cambio mappa / hop stage raid possono azzerare i task via navigazione.

### Sintesi della logica attuale

```
clearTaskIfDone → drivePendingCargo → runCurrentTask → pickNewTask → wander
```

Il raid dopo kill confermata può immediatamente `startCombatTask(next)` (6547–6550) — acquisizione **post-kill**, non mid-kill. Travel/NAV può azzerare i task all’avvio nav mappa/raid (~2128+).

### Interazioni / dipendenze

`isInRaidMap()` true via `K.inRaid`, map id `RAID_*`, o mappa di lavoro `raidGateId` — falsi positivi potrebbero abilitare il percorso resolve raid fuori raid (ora comunque sticky-first).

### Compatibilità

**RISCHIO**

### Modalità di fallimento note / teoriche

- Mappa raid mal rilevata → `resolveRaidCombatTarget` a ogni tick (sticky-first) vs engage standard — il comportamento differisce solo per approach/orbit.
- Retarget istantaneo raid post-kill è corretto; non deve girare mentre `isNpcStillFightable` (protetto in `clearTaskIfDone`).

### Correzione consigliata

Nessuna per lo sticky. Opzionale harden: `isInRaidMap()` richieda solo `K.inRaid || mapId.startsWith("RAID_")` (ignorare fallback gate-id fuori istanza raid).

---

## Bug sticky: traccia completa del percorso (pre-fix → post-fix)

### Sequenza pre-fix corrispondente al report utente

1. Nave combatte NPC tipo A (`currentTask=combat`, `taskTargetId=A`, `combatFocusId=A`).
2. Tipo B appare sulla mappa → loop UI / hook net → `syncRaidNpcSelectionFromMap` rileva cambio set.
3. `refreshCombatTargetTypesFromSelection` **azzera focus/target ids** (task id può restare).
4. Prossimo tick `driveRaidCombatEngage`: `resolveRaidCombatTarget(A)` — se A non è “low HP”, restituisce B più vicino (o local threat B).
5. Sovrascrive `taskTargetId/focus/target` a B; `setLockedTarget(B)`; `moveViaMinimap` / orbit intorno a B.
6. L’utente osserva: abbandono di A a metà attacco quando appare un tipo diverso ≈ “priorità di tipo.”

### Sequenza post-fix

1–2 uguali.  
3. refresh aggiorna il set tipi ma **mantiene lo sticky** mentre A è vivente.  
4. `resolveRaidCombatTarget(A)` restituisce A finché fightable.  
5. Continua lock/orbit/click su A fino a confirmed gone / foreign / flee / stop.

---

## Conteggio OK / RISCHIO / FALLITO

| # | Area | Stato |
|---|---|---|
| C | Sticky / abbandono priorità di tipo | **FALLITO → CORRETTO** (conta come FALLITO nel titolo; a runtime ora OK) |
| 1 | Acquisizione bersaglio / sticky / filtri | **OK** |
| 2 | Orbit / stand-off / chase / Approach A / soft-move | **RISCHIO** |
| 3 | Portal drift + softClamp | **OK** |
| 4 | Wander / shouldSuppressWander | **OK** |
| 5 | Cargo / foreign / pending / hold | **RISCHIO** |
| 6 | Morte / riparazione / recover / resume | **OK** |
| 7 | Raid gate / flee skirt / raid orbit | **RISCHIO** |
| 8 | Fuga PvP / SAP | **OK** |
| 9 | Red-lock vs helper | **OK** |
| 10 | Toggle impostazioni | **RISCHIO** |
| 11 | Ramificazione modalità mappa | **RISCHIO** |

**Conteggi per sintesi parent:** **OK 6 · RISCHIO 5 · FALLITO 1** (il FALLITO è il bug sticky confermato, corretto chirurgicamente in questo passaggio).

---

## Top 5 candidati di correzione chirurgica (priorità)

1. **FATTO — Abbandono sticky a metà kill (type sync + resolve raid).**  
   File/righe: `refreshCombatTargetTypesFromSelection`, `resolveRaidCombatTarget`, `getFocusedCombatNpc`.

2. **FATTO — Debounce false foreign lock → `markForeignNpc`.**  
   `FOREIGN_LOCK_CONFIRM_MS` (450) + `shouldCommitForeignLock` / `isLivingStickyCombatId`; lockInfo e `abandonForeignLockedTarget` non azzerano sticky su flicker.

3. **FATTO — Separare heal “shoot id” dal focus sticky in `sustainRaidHealAttack`.**  
   Spara al nearest se sticky fuori range, senza sovrascrivere `combatFocusId` / `taskTargetId` vivi.

4. **FATTO — Reset memoria soft-move minimappa al cambio sticky.**  
   `syncMinimapSoftMoveSticky` azzera `lastMinimapTarget` quando cambia l’id sticky (raid + standard engage).

5. **FATTO — `toggleNpcTypeSelection` sincronizza `combatTargetTypes` senza azzerare sticky.**  
   Anche `selectAllNpcTypes` / `clearNpcTypeSelection` → `refreshCombatTargetTypesFromSelection`.

**Extra applicati (raccomandazioni audit):**
- `pauseCombatForPostKillCargo(npcId)` solo se il bersaglio è confirmed-gone (niente disarm mid-fight).
- Spegnere Attacco → `stopCombat()` pulito.

---

## Change log (questo audit)

| Modifica | Applicata? |
|---|---|
| Preserve sticky in `refreshCombatTargetTypesFromSelection` | **Sì** |
| `resolveRaidCombatTarget` sticky-first | **Sì** |
| Keep living-focus in `getFocusedCombatNpc` | **Sì** |
| Debounce foreign lock mid-sticky | **Sì** |
| Heal shoot-id separato dallo sticky | **Sì** |
| Reset soft-move su cambio sticky | **Sì** |
| Sync tipi UI senza clear sticky | **Sì** |
| Guard cargo post-kill + stopCombat su Attacco off | **Sì** |
| Sync App Support `…/web/story/autopilot.js` | **Sì** (dopo correzioni mirate) |
| Version bump / commit / push | **No** (in attesa di test utente) |

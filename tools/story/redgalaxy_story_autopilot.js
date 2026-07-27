/**
 * RedGalaxy Bastion Autopilot
 * - orbita via minimappa (anti-radiazione ai bordi mappa)
 * - attacco/raccolta bonus via gameplay normale
 * - keep-alive in background
 *
 * RAID COMBAT (Story 3 restore — source of truth):
 *   dist/RedGalaxy Story 3.app/.../story/autopilot.js
 *   Ported hot path (names + Story 3 line refs):
 *     applyCombatOrbit (~2307) NPC-centered π/2 kite + support clamp
 *     getOrbitRadii (~2186) / getOrbitApproachPoint (~2204)
 *     driveRaidCombatEngage (~2828) approach→orbit+shoot every tick
 *     resolveRaidCombatTarget (~2540) / sustainRaidAttack (~2560)
 *     clampToRaidSupportZone (~3802) turret×0.78 (softened: delta E)
 *   Minimal Bastion deltas only: A continuous move, B lock CW/CCW,
 *   C Story 3 laser-band radii, D nearest-threat wave discipline, E soft support,
 *   F raid radial ping-pong recovery (tangential when move is too radial vs turret).
 *   Also restored (non-FSM): HP% heal-flee lateral evade; encircle/wave breakout
 *   via getRaidBreakoutPoint → then hand back to applyCombatOrbit.
 *   Danger FSM / timed orbit flips / task-clearing wave arm: OFF hot path.
 */
(function () {
  "use strict";

  const PANEL_ID = "rg-story-panel";
  const MARKER_ID = "rg-mm-marker";
  const DEFAULT_SCRIPT = "/story/scripts/demo-patrol.json";
  const LICENSE_PRODUCT = "redgalaxy-story";
  const LICENSE_PREFIX = "RG1";
  const LICENSE_STORAGE_KEY = "rg_story_license_v1";
  const LOCALE_STORAGE_KEY = "rg_story_locale_v1";
  const DEVICE_ID_STORAGE_KEY = "rg_story_device_id_v1";
  const UI_ZOOM_STORAGE_KEY = "rg_story_ui_zoom_v1";
  const DISCORD_WEBHOOK_STORAGE_KEY = "rg_story_discord_webhook_v1";
  /** Effectively unlimited: any hostile the client can see. */
  const FLEE_ENEMY_DETECT_RADIUS = Number.POSITIVE_INFINITY;
  const LICENSE_HMAC_SECRET = "2c7c804951626a3a47eb5a1cdf4b871a9d7ef755e658b301";
  const LICENSE_VALIDATE_URL = "";
  /** Keep in sync with tools/bastion_version.txt, Mac Info.plist, Windows package.json. */
  const BASTION_APP_VERSION = "1.0.6-mac46";

  const NPC_TYPES = {
    ALIEN10: "-={{Kryll}}=-",
    ALIEN11: "-={{Elite Kryll}}=-",
    ALIEN20: "-={{Lorvax}}=-",
    ALIEN21: "-={{Elite Lorvax}}=-",
    ALIEN30: "-={{Tarkon}}=-",
    ALIEN31: "-={{Elite Tarkon}}=-",
    ALIEN40: "-={{Zyron}}=-",
    ALIEN41: "-={{Elite Zyron}}=-",
    ALIEN50: "-={{Brakon}}=-",
    ALIEN51: "-={{Elite Brakon}}=-",
    VOXION: "-={{Voxion}}=-",
    VOXION1: "-={{Elite Voxion}}=-",
    TALON: "-={{Talon}}=-",
    TALON1: "-={{Elite Talon}}=-",
    FROSTON: "-={{Froston}}=-",
    FROSTON1: "-={{Elite Froston}}=-",
    RAIDON: "-={{Raidon}}=-",
    RAIDON1: "-={{Elite Raidon}}=-",
    IMPERON: "-={{Imperon}}=-",
    IMPERON1: "-={{Elite Imperon}}=-",
    EXECUTIONER: "-={{Executioner}}=-",
    EXECUTIONER1: "-={{Elite Executioner}}=-",
    NOXON: "-={{Noxon}}=-",
    NOXON1: "-={{Elite Noxon}}=-",
    ALIEN12: "-={{Commander Kryll}}=-",
    ALIEN22: "-={{Commander Lorvax}}=-",
    ALIEN32: "-={{Commander Tarkon}}=-",
    ALIEN42: "-={{Commander Zyron}}=-",
    ALIEN52: "-={{Commander Brakon}}=-",
    VOXION2: "-={{Commander Voxion}}=-",
    TALON2: "-={{Commander Talon}}=-",
    FROSTON2: "-={{Commander Froston}}=-",
    RAIDON2: "-={{Commander Raidon}}=-",
    NOXON2: "-={{Commander Noxon}}=-",
    DREAD_SENTINEL: "-={{Dread Sentinel}}=-",
    SECTOR_REAPER: "-={{Sector Reaper}}=-",
    DREADFORGE_TITAN: "-={{Dreadforge Titan}}=-",
  };

  const RAID_GATE_NPC_TYPES = {
    void: [],
    rift: [],
    nebula: [],
    inferno: [],
  };

  const COMBAT_PRIMARY_AMMO_TYPES = [
    { key: "LAP1", label: "1 · LAP-1" },
    { key: "LAP2", label: "2 · LAP-2" },
    { key: "LAP3", label: "3 · LAP-3" },
    { key: "LAP4", label: "4 · LAP-4" },
  ];
  const COMBAT_SPECIAL_AMMO_TYPES = [
    { key: "SAP", label: "SAP scudo" },
    { key: "RSAP", label: "RSAP x6" },
  ];
  const COMBAT_AMMO_TYPES = [...COMBAT_PRIMARY_AMMO_TYPES, ...COMBAT_SPECIAL_AMMO_TYPES];
  const COMBAT_SPECIAL_AMMO = new Set(["SAP", "RSAP"]);
  const COMBAT_RSAP_COOLDOWN_MS = 3000;
  const COMBAT_RSAP_BURST_MS = 700;

  const COMBAT_AMMO_BUY_QTY_OPTIONS = [0, 1, 5, 10, 50, 100];
  const COMBAT_AMMO_LOW_THRESHOLD = 100;
  const COMBAT_AMMO_BUY_COOLDOWN_MS = 2500;

  const AUTO = {
    active: false,
    paused: false,
    modeCollect: false,
    collectBonus: false,
    collectCargo: false,
    collectBooty: false,
    bootyKeysBlocked: false,
    cargoCollected: 0,
    bootyCollected: 0,
    modeAttack: false,
    modeOrbit: false,
    orbitDirection: 1,
    orbitNpcId: null,
    /** Absolute tower-centered orbit angle (raid); advanced by small δθ each waypoint. */
    orbitPhaseAngle: null,
    playerLaserRange: 650,
    npcAttackRange: 650,
    playerLaserFireInset: 15,
    orbitOuterInset: 12,
    orbitInnerInset: 58,
    orbitPreferredInset: 18,
    /** Raid kite: wide tower-centered circle, laser-edge distance from pack. */
    raidOrbitOuterInset: 4,
    raidOrbitInnerInset: 32,
    raidOrbitPreferredInset: 5,
    /** Max angular step per raid waypoint (NOT a π/2 lead — that made square chords). */
    raidOrbitArcRadians: 0.2,
    /** Preferred arc length along the tower ring; δθ ≈ arcLen / R. */
    raidOrbitArcLength: 125,
    raidOrbitMoveMinIntervalMs: 260,
    raidOrbitRecenterSlack: 48,
    orbitNpcSafetyMargin: 36,
    orbitArcRadians: 0.1,
    orbitFlipAt: 0,
    orbitFlipIntervalMs: 14000,
    orbitBoundaryBuffer: 220,
    orbitCornerEscapeMs: 1400,
    orbitStuckMinMove: 10,
    orbitLastPos: null,
    orbitStuckSince: 0,
    lastRaidOrbitMoveAt: 0,
    timerId: null,
    keepAliveId: null,
    readyCheckId: null,
    lastWanderAt: 0,
    nextWanderDelay: 3000,
    chasingBonusId: null,
    pendingCollectId: null,
    bonusCollected: 0,
    npcKillsByType: {},
    countedNpcKillIds: new Set(),
    watchedNpcIds: new Set(),
    trackedNpcTypes: new Map(),
    lastBonusCountAt: 0,
    lastCollectSendAt: 0,
    lastMapDims: null,
    mapSafeMargin: 100,
    minimapMoveMinIntervalMs: 90,
    minimapMoveMinDelta: 28,
    lastMinimapMoveAt: 0,
    lastMinimapTarget: null,
    /** Sticky combat id that lastMinimapTarget / soft-move memory belongs to. */
    lastMinimapStickyId: null,
    tickMs: 300,
    uiRefreshMs: 1000,
    bonusRadius: 2500,
    collectApproachOffset: 95,
    collectTriggerDistance: 18,
    collectArriveAt: 0,
    cargoCollectInFlightId: null,
    cargoCollectDoneIds: new Map(),
    /** npcId → expiry: kill already collected/abandoned — never re-arm pending for it. */
    cargoSettledNpcIds: new Map(),
    lastCargoCollectAttempt: null,
    /** When set, skip cargo until hold used drops below this (capacity reject / nearly full). */
    cargoSkipUntilUsedBelow: null,
    /** When cargoSkipUntilUsedBelow was latched — enables TTL re-probe so a false latch cannot stick forever. */
    cargoSkipLatchedAt: 0,
    /**
     * Recent confirmed kill drop sites (npcId, x, y, at). Survives pending expiry so a late
     * lootAdd can still scoop without soft-chasing empty death spots.
     */
    recentCargoKillSites: [],
    arriveDistance: 50,
    wanderMinMs: 1800,
    wanderMaxMs: 4200,
    selectedNpcTypes: new Set(),
    combatTargetTypes: null,
    combatTargetId: null,
    combatFocusId: null,
    /** When current combat target first looked gone — confirm before retarget. */
    combatTargetGoneAt: 0,
    combatActive: false,
    combatOrbitEngagedIds: new Set(),
    /** Sticky id we started engaging (for first-hit / portal-drift gate). */
    combatEngageNpcId: null,
    /** Timestamp when combatEngageNpcId was first engaged this fight. */
    combatEngageStartedAt: 0,
    selectedCombatAmmoTypes: new Set(),
    combatAmmoBuyQty: 0,
    combatAmmoBuyPending: false,
    combatAmmoBuyPendingAt: 0,
    combatAmmoLastBuyAt: 0,
    combatRsapNextAt: 0,
    combatRsapBurstUntil: 0,
    combatPrimaryAmmoType: null,
    currentTask: null,
    taskTargetId: null,
    combatBonusCollectMax: 220,
    gameHooksInstalled: false,
    countedBonusIds: new Set(),
    pendingBonusIds: new Set(),
    attackRange: 635,
    npcScanRadius: 0,
    uiLoopId: null,
    workingMapId: "",
    /**
     * Map id when cold Play started. Used so Stop→Play stays in place unless the
     * user changed workingMapId while stopped (intentional objective change).
     */
    coldPlayStayMapId: "",
    raidGateId: "",
    pendingRaidGate: null,
    /** Raid progress tracked from raidInfo / raidWave / raidStageClear (game state does not persist these). */
    raidCurrentStage: 0,
    raidTotalStages: 0,
    raidCurrentWave: 0,
    attackConfig: 1,
    roamConfig: 2,
    runConfig: 2,
    executionerConfig: 2,
    /** Latched true for the rest of the raid once last/Executioner round is detected. */
    raidExecutionerLatched: false,
    pendingConfigIndex: null,
    lastConfigSwitchAt: 0,
    activeTab: "general",
    sessionStatsBaseline: null,
    panelMinimized: false,
    orbDragMoved: false,
    portalWaitSec: 3,
    baseWaitSec: 5,
    /** Last rolled portal/base wait duration (sec) for status display. */
    lastRolledWaitSec: 0,
    deathLimit: 0,
    fleeHpPercent: 30,
    /** Soft band ±% around fleeHpPercent (finish kill / early heal). Fixed 5 for now. */
    fleeHpTolerance: 5,
    fleeEnemyPlayers: false,
    /**
     * Opt-in: if an admin/staff ship appears in AOI (same list as enemy detect),
     * go to nearest portal and hold still for coffee-break duration.
     */
    pauseOnAdmin: false,
    /** Opt-in: sendUseCloak while fleeing hostile players. */
    fleeUseCloak: false,
    /** Opt-in: fire SAP shield ammo at chasing PvP enemy while fleeing (movement unchanged). */
    fleeUseSap: false,
    lastCloakAt: 0,
    lastFleeSapAt: 0,
    /** PvP flee: last local HP+shield sum for incoming-fire detection. */
    pvpFleeLastCombatEffective: null,
    /** Timestamp of last local HP/shield drop while in PvP flee. */
    pvpFleeHitAt: 0,
    /** Throttle status notices for nearby cloaked hostiles. */
    lastCloakHostileNoticeAt: 0,
    /** Login username captured at Play (for coffee-pause re-login). Memory only. */
    playSessionUsername: "",
    /** Short-lived coffee re-login poll (until / deadline). */
    coffeeReloginUntil: 0,
    coffeeReloginAttemptedAt: 0,
    /** Opt-in: buy one booty key in safe zone when keys==0. */
    autoBuyBootyKeys: false,
    /** Opt-in: migrate combat toward nearest friendly portal (independent from Orbit). */
    orbitPortalDrift: false,
    /** Hysteresis: true once ship is inside allied portal safe/center (not the old ~560m ring). */
    portalDriftArrived: false,
    /** Portal-drift human wobble: irregular amp/side stretch (not periodic L/R). */
    portalDriftWobbleAmp: 0,
    portalDriftWobbleSide: 1,
    portalDriftWobbleUntil: 0,
    /** Long-path human wobble (map/flee mid/coffee mid) — irregular stretches. */
    pathHumanAmp: 0,
    pathHumanSide: 1,
    pathHumanUntil: 0,
    /** Combat orbit: next allowed retarget time (irregular hold, not every tick). */
    orbitHumanHoldUntil: 0,
    /** Post-heal safe-zone micro-fidget (only while HP/shield already full). */
    safeFidgetNextAt: 0,
    safeFidgetHoldUntil: 0,
    safeFidgetTarget: null,
    /** Standard-map combat: last local HP+shield sum for incoming-damage detection. */
    stdCombatLastEffective: null,
    /** Timestamp of last local HP/shield drop while fighting on standard maps. */
    stdCombatHitAt: 0,
    /** Last standard-orbit radial step: 1=outward/retreat, -1=inward/approach, 0=unknown. */
    stdOrbitLastRadialSign: 0,
    /** Bastion panel UI zoom only (75–125). Does not scale the game canvas. */
    uiZoomPercent: 100,
    /** Discord webhook: opt-in status + session stats to a channel. */
    discordWebhookEnabled: false,
    discordWebhookUrl: "",
    /** Minutes between stats embeds while Play is active (0 = stats only on Test/manual). */
    discordWebhookIntervalMin: 5,
    /** Also push notable status line changes (throttled). */
    discordNotifyStatus: true,
    discordLastStatusText: "",
    discordLastStatusSentAt: 0,
    discordLastStatsSentAt: 0,
    /** Throttle for portal-hold (admin/coffee) Discord remaining-time refreshes. */
    discordLastHoldSentAt: 0,
    discordWebhookBusy: false,
    bootyKeyBuyPending: false,
    lastBootyKeyBuyAt: 0,
    bootyKeyBuysThisSession: 0,
    deathCount: 0,
    wasDead: false,
    /** True after one auto-repair attempt for the current death. */
    repairSentThisDeath: false,
    /** When repairSentThisDeath was set — allow retry if still dead after timeout. */
    repairSentAt: 0,
    baseWaitUntil: 0,
    /** After base wait post-death, travel back to working map / raid gate. */
    resumeTravelAfterBaseWait: false,
    /**
     * Pre-objective heal hold (Play start and post-death): stay still until
     * Attack+Roam configs are full HP/shield (and baseWaitUntil if armed).
     * Heal must complete in a safe zone (travel there first when needed).
     */
    postDeathRecover: false,
    /**
     * "cold" = Play button (verify Attack config only — do not hub-travel just to
     * check Roam). "death" = post-death / flee recover (Attack+Roam, may travel to hub).
     */
    preObjectiveHealKind: null,
    /** Config nums (1/2) already verified full during postDeathRecover. */
    postDeathRecoverVerified: null,
    postDeathRecoverSince: 0,
    postDeathRecoverSwitchAt: 0,
    /** True while navigating/walking to a faction safe zone before heal hold. */
    healSafeTravel: false,
    /** Sustained-death debounce: first tick we saw a dead signal (0 = none). */
    deathSignalSince: 0,
    /** Sticky: server sent deathInfo — definitive death until respawn/repair clears it. */
    deathInfoReceived: false,
    /**
     * Until this timestamp: ignore flaky death / HP-flee after map arrival or
     * post-death resume (prevents objective↔base teleport loops).
     */
    postArrivalSecurityGraceUntil: 0,
    portalWaitUntil: 0,
    sessionLimitMin: 0,
    sessionStartedAt: 0,
    coffeeBreakIntervalMin: 0,
    coffeeBreakDurationMin: 5,
    /** ± minutes jitter for coffee/admin hold duration (and interval when >0). Default 2. */
    coffeeBreakToleranceMin: 2,
    coffeeBreakActive: false,
    coffeeBreakUntil: 0,
    nextCoffeeBreakAt: 0,
    /** Last rolled hold duration (minutes, fractional) shown in status. */
    coffeeHoldRolledMin: 0,
    /** "coffee" | "admin" — shared portal-hold path (NAV.kind coffee + coffeeBreakUntil). */
    portalHoldReason: null,
    /** Latched while admin pause nav/hold runs — prevents per-tick re-trigger. */
    adminPauseLatched: false,
    /** Short backoff after a failed admin→portal start (no portal, busy, …). */
    adminPauseCooldownUntil: 0,
    /** Nickname of admin that triggered the current pause (status only). */
    adminPauseName: "",
    /** Sector Z (JAIL): objectives frozen — hold/safe mode. */
    sectorZHoldActive: false,
    /** Throttle map for Discord admin alerts: `${type}:${identity}` → lastSentAt. */
    adminAlertLastAt: Object.create(null),
    /** Nicknames of admins seen this session (alerts / kill attribution). */
    adminKnownNames: new Set(),
    /** Group-invite accept in flight / last inviter nick. */
    groupInviteAcceptBusy: false,
    lastGroupInviteNick: "",
    /** Social chat WebSocket hook installed. */
    socialChatHookInstalled: false,
    fleeActive: false,
    fleeMode: null,
    combatSuspendedForFlee: false,
    raidHealMode: false,
    raidFleeTarget: null,
    raidFleeTargetAt: 0,
    raidHealSide: -1,
    raidHealPhase: null,
    /** Until this timestamp: prefer edge targets + breakout kite after wave spawn. */
    raidWaveRepositionUntil: 0,
    raidWaveEscapeDir: 0,
    /** Soft outward expand of turret tether when pressed against the orbit ring. */
    raidOrbitExpandUntil: 0,
    /** Deadline for scooping post-kill cargo before next-stage portal (0 = inactive). */
    raidStageClearCargoUntil: 0,
    /** When the current stage-clear cargo window started (soft-extend / hard-cap). */
    raidStageClearCargoStartedAt: 0,
    /**
     * Raid-Gate cargo clear→scoop FSM (null when idle).
     * { cargoId, x, y, phase: "BREAKOUT"|"CLEARING"|"APPROACH"|"SCOOP",
     *   startedAt, clearingEnteredAt, cargoClearSince, scoopCooldownUntil,
     *   approachR, angle, dir, holdUntil }
     */
    raidCargoClear: null,
    /** Raid danger FSM: cruise | cautious | breakout (gate combat only). */
    raidDangerMode: "cruise",
    raidDangerModeSince: 0,
    raidDangerLastEffectiveHp: null,
    raidDangerHitAt: 0,
    raidDangerSafeSince: 0,
    raidDangerBreakoutClearSince: 0,
    licenseKey: "",
    licenseValid: false,
    licenseExpiresAt: 0,
    licenseMessage: "Licenza richiesta",
    licenseChecking: false,
    locale: "en",
    deviceId: "",
    lastStatusKey: null,
    refinerySellMinerals: false,
    refinerySendAntimatter: false,
    refineryAutoRefine: false,
    refineryAutoEnhance: false,
    refineryOres: {
      LASER: new Set(),
      ROCKET: new Set(),
      SHIELD: new Set(),
      SPEED: new Set(),
    },
    refineryPending: false,
    lastRefineryAt: 0,
    refineryScheduledAt: 0,
    refineryLastPremiumOre: null,
    /** Planned human enrich sends: [{ ore, category, amount }, ...] — depletes to 0 stock. */
    refineryEnhanceQueue: [],
    pendingCombatCargo: null,
    /**
     * mac41: mandatory post-kill cargo phase. Entered on confirmed own kill when
     * collectCargo ON. Survives pending phantom-clears / sprite.alive flicker.
     * Heal (portal-drift cold) cannot arm until scoop done OR WAIT_MS expired
     * with no visible allowed cargo near the kill site.
     * Shape: { npcId, x, y, at } | null
     */
    mandatoryPostKillCargo: null,
    /** npcId → first tick fightable+alive again (debounce false-kill recovery). */
    npcRecoverySince: new Map(),
    foreignNpcIds: new Set(),
    /** Debounce false-positive foreign lock before clearing sticky mid-kill. */
    foreignLockSuspectId: null,
    foreignLockSuspectSince: 0,
    /** lootId → owner_id from lootAdd (null = unowned). Game discards owner_id from K.loots. */
    lootOwnerById: new Map(),
    securityEditing: null,
    npcLastPositions: new Map(),
  };

  const ORE_KEEP = new Set(["PLUTONIUM", "TRITIUM", "ANTIMATTER"]);
  const ORE_SELL = ["IRON", "COPPER", "SILVER", "GOLD", "TITANIUM", "URANIUM"];
  const REFINE_RECIPES = [
    { output: "TITANIUM", inputs: [{ ore: "IRON", amount: 10 }, { ore: "COPPER", amount: 10 }] },
    { output: "URANIUM", inputs: [{ ore: "SILVER", amount: 10 }, { ore: "GOLD", amount: 10 }] },
    { output: "PLUTONIUM", inputs: [{ ore: "TITANIUM", amount: 10 }, { ore: "URANIUM", amount: 10 }] },
    { output: "TRITIUM", inputs: [{ ore: "TITANIUM", amount: 10 }, { ore: "URANIUM", amount: 10 }] },
  ];
  const ENHANCE_ORES = {
    LASER: ["ANTIMATTER", "PLUTONIUM", "TITANIUM"],
    ROCKET: ["ANTIMATTER", "PLUTONIUM", "TITANIUM"],
    SHIELD: ["ANTIMATTER", "TRITIUM", "URANIUM"],
    SPEED: ["ANTIMATTER", "TRITIUM", "URANIUM"],
  };
  const ENHANCE_CATEGORIES = ["LASER", "ROCKET", "SHIELD", "SPEED"];
  /** Game: 1 ore → 10 laser/rocket shots (dE). */
  const ENRICH_SHOTS_PER_ORE = 10;
  /** Game: 1 ore → 1 shield/speed minute (uE). UI "all" allows full stock per call. */
  const ENRICH_MINUTES_PER_ORE = 1;
  /**
   * Hard cap: abandon post-kill cargo wait and resume combat.
   * Soft-extended while visible allowed cargo remains near the kill site
   * (golden rule: never abandon own drop just because the clock ran out).
   */
  const POST_KILL_CARGO_WAIT_MS = 6500;
  /** Sustained fightable+alive before clearing a counted kill cargo phase (HP flicker). */
  const POST_KILL_FALSE_RECOVERY_MS = 900;
  /** Max time to keep blocking on a visible but uncollectable post-kill cargo. */
  const POST_KILL_CARGO_STUCK_MS = 4200;
  /**
   * Legacy appear-grace label (kept for docs). Pending now stays open until
   * WAIT_MS so late lootAdd cannot lose to bonus / next-NPC mid-window.
   * Late scoop after settle still uses recentCargoKillSites (not soft-chase).
   */
  const POST_KILL_CARGO_APPEAR_MS = 2200;
  /**
   * Legacy site-grace (kept for any residual at-site wait). Soft-approach to empty
   * death spots is disabled — do not chase cargo that is not visible/allowed.
   */
  const POST_KILL_CARGO_SITE_GRACE_MS = 900;
  const POST_KILL_CARGO_RADIUS = 900;
  /** How long a confirmed kill site stays eligible for late lootAdd scoop. */
  const RECENT_CARGO_KILL_SITE_TTL_MS = 6500;
  /** Re-probe cargo after a capacity latch so long sessions cannot permanently forget scoop. */
  const CARGO_SKIP_REPROBE_MS = 20000;
  const CLOAK_COOLDOWN_MS = 30000;
  const BOOTY_KEY_BUY_COOLDOWN_MS = 8000;
  const BOOTY_KEY_BUY_SESSION_MAX = 20;
  /** After stage clear: scoop leftover cargo before portal (soft-extend while cargo remains). */
  const RAID_STAGE_CLEAR_CARGO_MS = 12000;
  /** Soft-extend stage-clear scoop while visible allowed cargo still remains. */
  const RAID_STAGE_CLEAR_CARGO_EXTEND_MS = 8000;
  /** Hard cap so a permanently stuck loot cannot block the gate forever. */
  const RAID_STAGE_CLEAR_CARGO_MAX_MS = 90000;
  /** Raid Gate: NPCs this close to cargo make a direct scoop unsafe. */
  const RAID_CARGO_DANGER_R = 420;
  /** Raid Gate: NPCs near the ship→cargo midpoint also block a linear dive. */
  const RAID_CARGO_PATH_R = 260;
  /** Raid Gate: NPCs this close to the ship while scooping force breakout first. */
  const RAID_CARGO_SHIP_DANGER_R = 520;
  /** Raid Gate: this many close NPCs (or encircle) abort scoop → breakout. */
  const RAID_CARGO_SHIP_DANGER_MIN = 2;
  /** Raid Gate: escape step away from pack centroid before clear-orbit. */
  const RAID_CARGO_BREAKOUT_STEP = 1450;
  /** Raid Gate: wide orbit radius while flanking cargo (outside damage packs). */
  const RAID_CARGO_CLEAR_ORBIT_R = 1380;
  /**
   * mac33: CLEARING waypoint must keep this floor vs any living NPC
   * (laser outer stand-off — never circle through the loot pile at melee).
   * Derived at runtime from getOrbitRadii().preferred when available.
   */
  const RAID_CARGO_CLEAR_NPC_FLOOR = 620;
  /** Reject clear chords that pass this close to the NPC pack centroid. */
  const RAID_CARGO_CLEAR_CHORD_R = 520;
  /** Sustained cargo-local clear before APPROACH/SCOOP is allowed (not a single tick). */
  const RAID_CARGO_CLEAR_STABLE_MS = 2000;
  /** Minimum CLEARING dwell after enter / blocked scoop before any scoop attempt. */
  const RAID_CARGO_CLEAR_MIN_DWELL_MS = 2500;
  /** After failed/blocked scoop: forbid re-scoop this long (no half-second retry loop). */
  const RAID_CARGO_SCOOP_COOLDOWN_MS = 2200;
  /** Raid Gate: angular step per clear/approach tick (smaller = smoother wide arc). */
  const RAID_CARGO_CLEAR_ARC = 0.22;
  /** Hold the same clear waypoint this long before a new minimap click. */
  const RAID_CARGO_CLEAR_HOLD_MS = 580;
  /** Spiral-in step while APPROACH orbits toward cargo. */
  const RAID_CARGO_APPROACH_SPIRAL = 110;
  /** Enter native SCOOP once this close on the approach arc. */
  const RAID_CARGO_APPROACH_SCOOP_R = 240;
  /**
   * While CLEARING/BREAKOUT/APPROACH a blocked cargo: divert to scoop a FREE cargo
   * we pass within this range (patient latch on blocked target stays).
   * Well beyond CLEAR_ORBIT_R so wide clear prefers free drops over continuing orbit.
   */
  const RAID_CARGO_OPP_SCOOP_R = 2100;
  /** Hold an in-progress free-cargo divert this long before CLEARING may retarget. */
  const RAID_CARGO_OPP_SCOOP_LOCK_MS = 2200;
  /**
   * Ship-to-cargo entity distance treated as "sitting on loot".
   * Instant scoop even during CLEARING/BREAKOUT/APPROACH / NPC-blocked patient latch.
   * (Native trigger uses approach-point y-95 + 15m — on-entity is a separate contact band.)
   */
  const RAID_CARGO_CONTACT_R = 160;
  /** Slightly wider contact band for proven-free cargo only (faster arm, not blocked). */
  const RAID_CARGO_FREE_CONTACT_R = 210;
  /** Critical NPC distance that may interrupt heal hold (milder threats do not thrash). */
  /** @deprecated mac34: hold uses RAID_HEAL_HOLD_THREAT (Bastion 19), not this lower floor. */
  const RAID_HEAL_CRITICAL_THREAT = 420;
  /** Keep the same heal-evade / return waypoint at least this long (anti-thrash on return only). */
  const RAID_HEAL_EVADE_HOLD_MS = 750;
  /** Standard maps: wait for first sticky hit before portal-drift retreat (timeout fallback). */
  const PORTAL_DRIFT_FIRST_HIT_TIMEOUT_MS = 2800;
  /** Remember settled kills so late killReward / entityKill / clearTask cannot re-arm. */
  const CARGO_SETTLED_NPC_TTL_MS = 90000;
  /**
   * Stick to the current combat target until it stays gone this long (or a kill is counted).
   * Prevents abandon-near-death when sprite.alive / schema briefly flicker before HP sync.
   * ≥ ~2 mainTicks (tickMs≈300) so a same-tick re-add can restore focus.
   */
  const COMBAT_TARGET_GONE_CONFIRM_MS = 650;
  /** Full schema+sprite remove still needs ≥2 ticks — not a one-frame abandon. */
  const COMBAT_TARGET_GONE_FULL_REMOVE_MS = 600;
  /**
   * Honor lockInfo can flicker isOwnedByOther for a living sticky mid-kill.
   * Require sustained foreign signal this long before markForeignNpc clears sticky.
   */
  const FOREIGN_LOCK_CONFIRM_MS = 450;
  /** Soft cap so long sessions cannot grow countedNpcKillIds unboundedly. */
  const COUNTED_NPC_KILL_IDS_MAX = 4000;
  const RAID_HEAL_ARRIVE_DIST = 140;
  const RAID_HEAL_THREAT_DIST = 1100;
  const RAID_HEAL_SIDE_INSET = 220;
  const RAID_HEAL_HOLD_THREAT = 780;
  const RAID_HEAL_STEP = 420;
  const RAID_SAFE_RETURN_ARRIVE = 120;
  const RAID_SAFE_RETURN_STEP = 380;
  /** After each wave spawn: force breakout/edge kite before diving the pack. */
  const RAID_WAVE_REPOSITION_MS = 5500;
  /** Detect pack surround early enough to escape before the ring closes. */
  const RAID_ENCIRCLE_CLOSE_R = 620;
  const RAID_ENCIRCLE_MIN_NPCS = 2;
  const RAID_SWARM_NEIGHBOR_R = 420;
  /** Decisive lateral escape when encircled (minimap — bypass soft hold). */
  const RAID_BREAKOUT_STEP = 980;
  /** Absolute soft turret tether (hard ceiling / safety only — do not cruise here). */
  const RAID_ORBIT_TURRET_SOFT = 0.98;
  /**
   * Story 3 support-zone fraction of turret range. Primary raid kite ceiling —
   * well inside softMax so we never slam the invisible tether wall each tick.
   */
  const RAID_ORBIT_SUPPORT_FRAC = 0.78;
  /**
   * Preferred cruise as fraction of supportMax (Story 3 lived inside support zone).
   * Riding softMax caused: clamp slam → cornered → expand/breakout chaos.
   * Slightly raised (0.92→0.95) for a bit more stand-off while still under softMax.
   */
  const RAID_ORBIT_CRUISE_FRAC = 0.95;
  /** When cornered against the soft ring, temporarily allow outward expand window. */
  const RAID_ORBIT_EXPAND_MS = 3200;
  /** Adaptive danger response (raid gate combat only). */
  const RAID_DANGER_MODE = {
    CRUISE: "cruise",
    CAUTIOUS: "cautious",
    BREAKOUT: "breakout",
  };
  /** Calm for this long before leaving CAUTIOUS → CRUISE. */
  const RAID_DANGER_SAFE_MS = 4500;
  /** Minimum dwell in CAUTIOUS before downgrade (hysteresis). */
  const RAID_DANGER_CAUTIOUS_MIN_MS = 2200;
  /** Encirclement cleared this long before BREAKOUT → CRUISE. */
  const RAID_DANGER_BREAKOUT_CLEAR_MS = 1800;
  /** Significant hit: % of total max HP lost in one tick. */
  const RAID_DANGER_HP_DROP_PCT = 2.5;
  /** Significant hit: absolute HP+extra lost in one tick. */
  const RAID_DANGER_HP_DROP_ABS = 800;
  /** Close NPC count treated as heavy surround (→ BREAKOUT). */
  const RAID_DANGER_HEAVY_SURROUND = 4;
  /** Recent-hit window for CAUTIOUS while on wide orbit. */
  const RAID_DANGER_HIT_COOLDOWN_MS = 1200;
  /** PvP flee SAP: treat recent HP/shield drop as under fire. */
  const PVP_FLEE_HIT_WINDOW_MS = 3500;
  /** Standard maps: window after local HP/shield drop → stable kite (no approach↔retreat thrash). */
  const STD_COMBAT_HIT_WINDOW_MS = 2800;
  /** Standard maps: outward radius scale while recently damaged (~10%). */
  const STD_HIT_ORBIT_OUTWARD = 0.1;
  /** Standard maps: extra approach stand-off while recently damaged (~10%). */
  const STD_HIT_APPROACH_SOFT = 0.1;
  /** Coffee logout → auto-login poll window. */
  const COFFEE_RELOGIN_WINDOW_MS = 20000;
  const COFFEE_RELOGIN_RETRY_MS = 1500;
  const GAME_SAVED_ACCOUNTS_KEY = "rg_saved_accounts";
  /** Ignore death/HP-flee this long after objective arrival or post-death resume. */
  const POST_ARRIVAL_SECURITY_GRACE_MS = 5500;
  /** Require sustained dead signal before counting a death / auto-repair. */
  const DEATH_SIGNAL_DEBOUNCE_MS = 900;
  /** If sendRepairShip got no success/fail, retry while still dead. */
  const REPAIR_RETRY_MS = 3500;
  /** Portal jump: a few presses OK, then latch — never spam after confirm / portal gone. */
  const JUMP_ATTEMPT_MAX = 5;
  const JUMP_ATTEMPT_BASE_MS = 420;
  const JUMP_ATTEMPT_BACKOFF_MS = 220;

  const NAV = {
    active: false,
    kind: null,
    path: [],
    destinationId: null,
    hopIndex: 0,
    phase: "idle",
    jumpStartedAt: 0,
    lastMapId: null,
    portalRange: 640,
    jumpTimeoutMs: 20000,
    moveTimeoutMs: 90000,
    moveStartedAt: 0,
    timerId: null,
    playAfterArrival: false,
    /** Map travel whose arrival continues pre-objective heal (do not overwrite workingMap). */
    forHeal: false,
    pendingRaidGate: null,
    raidWaitSince: 0,
    /** Recent map ids during flee/heal — used to abort Sector X oscillations. */
    recentMaps: [],
    /** True after jump confirmed (log/net/portal gone/map change) — stop tryJump until next hop. */
    jumpLatched: false,
    jumpAttemptCount: 0,
    jumpLastAttemptAt: 0,
    jumpConfirmReason: null,
    /** Snapshot of portal we intended to jump — detect disappear after press. */
    jumpPortalKey: null,
  };

  /** Fallback safe-zone bases when K.bases is not yet synced (X-1 / X-7 hubs). */
  const FALLBACK_SAFE_BASES = {
    MAP1: { x: 1024, y: 1024, safeZoneRadius: 1024, faction: "HELIOS" },
    MAP2: { x: 14976, y: 1024, safeZoneRadius: 1024, faction: "NOVA" },
    MAP3: { x: 14976, y: 8976, safeZoneRadius: 1024, faction: "ORION" },
    MAP19: { x: 12000, y: 7500, safeZoneRadius: 1024, faction: "HELIOS" },
    MAP20: { x: 12000, y: 7500, safeZoneRadius: 1024, faction: "NOVA" },
    MAP21: { x: 12000, y: 7500, safeZoneRadius: 1024, faction: "ORION" },
  };

  /**
   * Neutral hubs that create O-5↔Sector X oscillations when used for flee/heal.
   * Play travel to working maps may still use them when no other path exists.
   * JAIL = Sector Z (admin map; often no portals).
   */
  const NAV_HUB_MAP_IDS = new Set(["SECTOR_X", "SECTOR_Y", "PYRO", "JAIL"]);
  /** Sector Z admin map id (map_graph name "Sector Z"). */
  const SECTOR_Z_MAP_ID = "JAIL";
  /** Known RedGalaxy HTTP API bases (localStorage rg_selected_server). */
  const GAME_API_BY_SERVER = {
    global: "https://aws-prod-api.redgalaxygame.space",
    aws: "https://aws-api.redgalaxygame.space",
  };

  let MAP_GRAPH = null;

  const state = {
    running: false,
    paused: false,
    abortController: null,
  };

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      if (!signal) return;
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new Error("aborted"));
        return;
      }
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      }, { once: true });
    });
  }

  function getCanvas() {
    return document.querySelector("#game-container canvas");
  }

  function getGame() {
    if (window.__RG_GAME__ && window.__RG_GAME__.scene) {
      return window.__RG_GAME__;
    }
    const canvas = getCanvas();
    if (!canvas) return null;
    if (canvas.game && canvas.game.scene) return canvas.game;

    const parent = document.getElementById("game-container");
    const keys = Object.getOwnPropertyNames(parent || {});
    for (const key of keys) {
      try {
        const val = parent[key];
        if (val?.scene?.getScene) return val;
      } catch (_) {}
    }
    return null;
  }

  function getGameScene() {
    const game = getGame();
    if (!game?.scene?.getScene) return null;
    const scene = game.scene.getScene("GameScene");
    if (!scene?.sys?.isActive?.()) return null;
    return scene;
  }

  function getInputSystem() {
    return getGameScene()?.inputSystem ?? null;
  }

  /**
   * Play running and not paused. Stop/Pause must never mutate lock/attack/move —
   * net hooks stay installed for UI, but must not steal manual gameplay.
   */
  function isBotLive() {
    return Boolean(AUTO.active && !AUTO.paused);
  }

  function getMinimap() {
    return getGameScene()?.ui?.minimap ?? null;
  }

  function getEntities() {
    return getGameScene()?.entities ?? null;
  }

  function getShipPosition() {
    const input = getInputSystem();
    if (!input) return null;
    return { x: input.localX, y: input.localY };
  }

  function distance(ax, ay, bx, by) {
    const dx = ax - bx;
    const dy = ay - by;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function randBetween(min, max) {
    return min + Math.random() * (max - min);
  }

  function hasAnyCollectMode() {
    return AUTO.collectBonus || AUTO.collectCargo || AUTO.collectBooty;
  }

  function syncCollectMasterFlag() {
    AUTO.modeCollect = hasAnyCollectMode();
  }

  function getBootyKeyCount() {
    const keys = getLocalPlayer()?.booty_keys ?? 0;
    if (keys > 0) AUTO.bootyKeysBlocked = false;
    return keys;
  }

  function canCollectBootyNow() {
    return AUTO.collectBooty && !AUTO.bootyKeysBlocked && getBootyKeyCount() > 0;
  }

  function getLootTypeFromId(id, sprite) {
    if (sprite?.lootType) return sprite.lootType;
    const loot = getGameState()?.loots?.get?.(id);
    return loot?.loot_type || "CARGO";
  }

  function isBootyLoot(sprite, id) {
    return getLootTypeFromId(id, sprite) === "BOOTY_BOX";
  }

  function isCargoLoot(sprite, id) {
    const type = getLootTypeFromId(id, sprite);
    return type === "CARGO";
  }

  function getLootSprite(id) {
    return getEntities()?.lootSprites?.get(id) ?? null;
  }

  function isProtectedCargoSprite(sprite) {
    if (!sprite) return false;
    if (sprite.ownershipTimer) return true;
    const texKey = sprite.spr?.texture?.key;
    return texKey === "cargo1";
  }

  function rememberLootOwners(payload) {
    const loots = payload?.loots;
    if (!Array.isArray(loots)) return;
    for (const u of loots) {
      if (u?.id == null) continue;
      AUTO.lootOwnerById.set(u.id, u.owner_id ?? null);
    }
  }

  function forgetLootOwners(ids) {
    if (!Array.isArray(ids)) return;
    for (const id of ids) AUTO.lootOwnerById.delete(id);
  }

  function getLootOwnerId(id) {
    if (id == null || !AUTO.lootOwnerById.has(id)) return undefined;
    return AUTO.lootOwnerById.get(id);
  }

  function isCargoNearPendingKill(sprite, pending = AUTO.pendingCombatCargo) {
    if (!sprite || !pending || sprite.x == null || sprite.y == null) return false;
    return distance(sprite.x, sprite.y, pending.x, pending.y) <= POST_KILL_CARGO_RADIUS;
  }

  function isCargoNearMandatoryPhase(sprite) {
    const phase = AUTO.mandatoryPostKillCargo;
    if (!sprite || !phase || sprite.x == null || sprite.y == null) return false;
    if (phase.x == null || phase.y == null) return false;
    return distance(sprite.x, sprite.y, phase.x, phase.y) <= POST_KILL_CARGO_RADIUS;
  }

  /**
   * mac41 ownership: after own kill with collectCargo ON, enter a mandatory cargo
   * phase that heal/search cannot interrupt until scoop or empty WAIT_MS expiry.
   */
  function enterMandatoryPostKillCargoPhase(npcId, x, y, at = Date.now()) {
    if (!AUTO.collectCargo || !npcId || x == null || y == null) return false;
    const prev = AUTO.mandatoryPostKillCargo;
    // Keep original clock when re-entering the same kill (phantom wipe recovery).
    const startedAt =
      prev?.npcId === npcId && Number.isFinite(prev.at) ? prev.at : at;
    AUTO.mandatoryPostKillCargo = { npcId, x, y, at: startedAt };
    rememberRecentCargoKillSite(npcId, x, y);
    return true;
  }

  function endMandatoryPostKillCargoPhase(npcId = null) {
    if (!AUTO.mandatoryPostKillCargo) return;
    if (npcId && AUTO.mandatoryPostKillCargo.npcId !== npcId) return;
    AUTO.mandatoryPostKillCargo = null;
  }

  /**
   * True while the mandatory post-kill cargo phase still owns the tick.
   * Soft-extends past WAIT_MS while visible allowed cargo remains near the site.
   */
  function isMandatoryPostKillCargoPhaseOpen() {
    if (!AUTO.collectCargo) return false;
    const phase = AUTO.mandatoryPostKillCargo;
    if (!phase || phase.x == null || phase.y == null) return false;
    if (phase.npcId && isGenuineNpcRecovery(phase.npcId)) {
      // Sustained false-kill recovery only — not one-frame HP sync flicker.
      endMandatoryPostKillCargoPhase(phase.npcId);
      return false;
    }
    if (phase.npcId && isNpcStillFightable(phase.npcId)) {
      tickNpcRecoveryDebounce(phase.npcId);
    }
    if (AUTO.pendingCombatCargo) return true;
    if (AUTO.cargoCollectInFlightId) return true;
    if (
      AUTO.currentTask === "collect" &&
      AUTO.taskTargetId &&
      isCargoLoot(getLootSprite(AUTO.taskTargetId), AUTO.taskTargetId)
    ) {
      return true;
    }
    const visible = listCargoNearPoint(phase.x, phase.y, POST_KILL_CARGO_RADIUS);
    if (visible.length) {
      // Soft-extend clock while own drop is still visible (mirror pending WAIT extend).
      if (Date.now() - phase.at > POST_KILL_CARGO_WAIT_MS) {
        phase.at = Date.now() - Math.floor(POST_KILL_CARGO_WAIT_MS * 0.55);
      }
      return true;
    }
    if (Date.now() - phase.at <= POST_KILL_CARGO_WAIT_MS) return true;
    // Empty wait fully expired — release so portal-drift heal may arm.
    endMandatoryPostKillCargoPhase(phase.npcId);
    return false;
  }

  function pruneRecentCargoKillSites() {
    const now = Date.now();
    AUTO.recentCargoKillSites = (AUTO.recentCargoKillSites || []).filter(
      (site) => site && now - site.at <= RECENT_CARGO_KILL_SITE_TTL_MS
    );
  }

  function rememberRecentCargoKillSite(npcId, x, y) {
    if (x == null || y == null) return;
    pruneRecentCargoKillSites();
    const sites = AUTO.recentCargoKillSites || (AUTO.recentCargoKillSites = []);
    // One site per npcId — refresh clock/position on re-arm.
    const idx = sites.findIndex((s) => s.npcId && s.npcId === npcId);
    const entry = { npcId: npcId || null, x, y, at: Date.now() };
    if (idx >= 0) sites[idx] = entry;
    else sites.push(entry);
    // Hard cap so long sessions cannot grow unbounded.
    if (sites.length > 12) sites.splice(0, sites.length - 12);
  }

  function forgetRecentCargoKillSite(npcId) {
    if (!npcId || !AUTO.recentCargoKillSites?.length) return;
    AUTO.recentCargoKillSites = AUTO.recentCargoKillSites.filter((s) => s.npcId !== npcId);
  }

  function isCargoNearRecentKillSite(sprite) {
    if (!sprite || sprite.x == null || sprite.y == null) return false;
    pruneRecentCargoKillSites();
    for (const site of AUTO.recentCargoKillSites || []) {
      if (distance(sprite.x, sprite.y, site.x, site.y) <= POST_KILL_CARGO_RADIUS) return true;
    }
    return false;
  }

  /** Find a recent kill site near this cargo (for re-arming pending on late lootAdd). */
  function findRecentCargoKillSiteNear(x, y) {
    if (x == null || y == null) return null;
    pruneRecentCargoKillSites();
    let best = null;
    let bestDist = Infinity;
    for (const site of AUTO.recentCargoKillSites || []) {
      const d = distance(x, y, site.x, site.y);
      if (d <= POST_KILL_CARGO_RADIUS && d < bestDist) {
        best = site;
        bestDist = d;
      }
    }
    return best;
  }

  /**
   * Foreign / grey (honor) cargo.
   * Game client: owner_id !== me && ownership_ms > 0 → texture "cargo1" + ownershipTimer.
   * Own kill loot uses texture "cargo" (never cargo1). Scooping cargo1 costs honor.
   */
  function isForeignOwnedLoot(id, sprite) {
    const myId = getGameState()?.mySessionId;
    const owner = getLootOwnerId(id);
    if (myId && owner && owner !== myId) return true;

    const spr = sprite || getLootSprite(id);
    if (!spr) return false;
    // cargo1 / ownershipTimer = foreign protected (grey). Never treat as own, even near kill.
    if (isProtectedCargoSprite(spr)) return true;
    return false;
  }

  /** Prefer cargo whose lootAdd owner_id is us; else unowned / unknown non-foreign. */
  function cargoOwnKillScore(id) {
    const myId = getGameState()?.mySessionId;
    const owner = getLootOwnerId(id);
    if (myId && owner === myId) return 0;
    if (owner == null || owner === undefined) return 1;
    if (myId && owner !== myId) return 99;
    return 2;
  }

  /**
   * True when the red lock circle on this NPC is ours (not a foreign grey lock).
   * Helpers may also shoot — that must not revoke ownership.
   */
  function isOwnLockOnNpc(npcId) {
    const K = getGameState();
    if (!npcId || !K || K.lockedTargetId !== npcId) return false;
    if (K.lockTargetOwnedByOther) {
      if (K.lockOwnerExpiresAt > 0 && Date.now() >= K.lockOwnerExpiresAt) {
        K.lockTargetOwnedByOther = false;
        K.lockOwnerExpiresAt = 0;
      } else {
        return false;
      }
    }
    return true;
  }

  function isNpcEngagedByOtherPlayer(npcId) {
    if (!npcId) return false;
    // Own red lock wins — other players helping must not force abandon.
    if (isOwnLockOnNpc(npcId)) return false;
    const K = getGameState();
    if (!K?.players || !K?.mySessionId) return false;
    if (AUTO.foreignNpcIds.has(npcId)) {
      // Stale foreign mark after we re-acquired our own lock.
      if (isOwnLockOnNpc(npcId)) {
        AUTO.foreignNpcIds.delete(npcId);
        return false;
      }
      return true;
    }

    for (const [sessionId, player] of K.players) {
      if (sessionId === K.mySessionId) continue;
      if (player?.alive === false) continue;
      if (player.is_attacking && player.attack_target_id === npcId) {
        // Helpers on our current fight are fine; only block brand-new picks.
        if (
          AUTO.combatActive &&
          (AUTO.combatFocusId === npcId ||
            AUTO.taskTargetId === npcId ||
            AUTO.combatTargetId === npcId)
        ) {
          return false;
        }
        return true;
      }
    }
    return false;
  }

  function isNpcAllowedForCombat(npcId) {
    if (!npcId) return false;
    // My red circle always wins over foreign / helper heuristics.
    if (isOwnLockOnNpc(npcId)) return true;
    if (isNpcEngagedByOtherPlayer(npcId)) return false;
    const K = getGameState();
    if (K?.lockedTargetId === npcId && K?.lockTargetOwnedByOther) return false;
    return true;
  }

  function isLivingStickyCombatId(npcId) {
    if (!npcId) return false;
    const sticky =
      AUTO.combatFocusId === npcId ||
      AUTO.combatTargetId === npcId ||
      (AUTO.currentTask === "combat" && AUTO.taskTargetId === npcId);
    if (!sticky) return false;
    return (
      isNpcStillFightable(npcId) ||
      Boolean(getNpcSprite(npcId)?.alive) ||
      !isCombatTargetConfirmedGone(npcId)
    );
  }

  function clearForeignLockSuspect() {
    AUTO.foreignLockSuspectId = null;
    AUTO.foreignLockSuspectSince = 0;
  }

  /**
   * Returns true when markForeignNpc should proceed.
   * Living sticky mid-kill requires sustained foreign lock signal (debounce flicker).
   */
  function shouldCommitForeignLock(npcId) {
    if (!npcId) return false;
    if (!isLivingStickyCombatId(npcId)) {
      clearForeignLockSuspect();
      return true;
    }
    const now = Date.now();
    if (AUTO.foreignLockSuspectId !== npcId) {
      AUTO.foreignLockSuspectId = npcId;
      AUTO.foreignLockSuspectSince = now;
      return false;
    }
    if (now - AUTO.foreignLockSuspectSince < FOREIGN_LOCK_CONFIRM_MS) return false;
    clearForeignLockSuspect();
    return true;
  }

  function markForeignNpc(npcId) {
    if (!npcId) return;
    if (!shouldCommitForeignLock(npcId)) return;
    AUTO.foreignNpcIds.add(npcId);
    AUTO.watchedNpcIds.delete(npcId);
    const wasCombatTarget =
      AUTO.combatFocusId === npcId ||
      AUTO.combatTargetId === npcId ||
      (AUTO.currentTask === "combat" && AUTO.taskTargetId === npcId);
    if (AUTO.combatFocusId === npcId) AUTO.combatFocusId = null;
    if (AUTO.combatTargetId === npcId) AUTO.combatTargetId = null;
    // Always drop stuck combat so pickNewTask can retarget next tick.
    if (wasCombatTarget || AUTO.taskTargetId === npcId) {
      if (AUTO.currentTask === "combat") clearCurrentTask();
      else if (AUTO.taskTargetId === npcId) AUTO.taskTargetId = null;
    }
    AUTO.combatTargetGoneAt = 0;
    // mac45: never unlock the player's target while Stop/Pause.
    if (!isBotLive()) return;
    const K = getGameState();
    if (K?.lockedTargetId === npcId) clearLockedTarget();
  }

  function abandonForeignLockedTarget() {
    if (!isBotLive()) return false;
    const K = getGameState();
    if (!K?.lockedTargetId) return false;
    // Never abandon our own red lock — helpers may also be shooting.
    if (isOwnLockOnNpc(K.lockedTargetId)) return false;
    if (!K.lockTargetOwnedByOther) return false;
    const id = K.lockedTargetId;
    markForeignNpc(id);
    // Still debouncing a living sticky — keep fighting until foreign signal holds.
    if (!AUTO.foreignNpcIds.has(id)) return false;
    clearLockedTarget();
    const input = getInputSystem();
    if (input) {
      input.attackMode = false;
      input.pendingAttackOnLock = null;
    }
    setStatus("status.honor_foreign");
    return true;
  }

  function pruneForeignNpcIds() {
    const entities = getEntities();
    if (!entities?.npcSprites) return;
    for (const id of [...AUTO.foreignNpcIds]) {
      if (!entities.npcSprites.has(id)) AUTO.foreignNpcIds.delete(id);
    }
  }

  function isCollectibleWanted(id, sprite) {
    if (isForeignOwnedLoot(id, sprite)) return false;
    if (isBonusLoot(sprite)) return AUTO.collectBonus;
    if (isBootyLoot(sprite, id)) return canCollectBootyNow();
    if (isCargoLoot(sprite, id)) return false;
    return false;
  }

  function isCargoCollectAlreadyDone(id) {
    if (!id) return false;
    const exp = AUTO.cargoCollectDoneIds.get(id);
    if (!exp) return false;
    if (Date.now() > exp) {
      AUTO.cargoCollectDoneIds.delete(id);
      return false;
    }
    return true;
  }

  function pruneCargoSettledNpcIds() {
    const now = Date.now();
    for (const [id, exp] of AUTO.cargoSettledNpcIds) {
      if (now > exp) AUTO.cargoSettledNpcIds.delete(id);
    }
  }

  function isCargoSettledForNpc(npcId) {
    if (!npcId) return false;
    pruneCargoSettledNpcIds();
    const exp = AUTO.cargoSettledNpcIds.get(npcId);
    if (!exp) return false;
    if (Date.now() > exp) {
      AUTO.cargoSettledNpcIds.delete(npcId);
      return false;
    }
    return true;
  }

  function markCargoSettledForNpc(npcId) {
    if (!npcId) return;
    AUTO.cargoSettledNpcIds.set(npcId, Date.now() + CARGO_SETTLED_NPC_TTL_MS);
  }

  function clearCollectMovement(lootId = null) {
    const K = getGameState();
    const input = getInputSystem();
    if (K) {
      if (!lootId || K.cargoTargetId === lootId) K.cargoTargetId = null;
    }
    if (input?.moveTarget) input.moveTarget = null;
  }

  /**
   * End the post-kill cargo lifecycle. Marks the NPC as settled so late kill
   * hooks cannot re-open "Attendo cargo NPC..." after loot was already taken.
   */
  function finishCombatCargoCollect(lootId, opts = {}) {
    const pending = AUTO.pendingCombatCargo;
    const phase = AUTO.mandatoryPostKillCargo;
    const settledNpcId = pending?.npcId ?? phase?.npcId ?? null;
    const alreadyDone = lootId ? isCargoCollectAlreadyDone(lootId) : false;
    if (lootId) {
      AUTO.cargoCollectDoneIds.set(lootId, Date.now() + 12000);
      AUTO.pendingBonusIds.delete(lootId);
    }
    // Always clear in-flight when settling the post-kill lifecycle — a mismatched
    // lootId used to leave cargoCollectInFlightId stuck and block later scoops.
    AUTO.cargoCollectInFlightId = null;
    // Successful scoop: drop the kill site. Miss/abandon: keep site briefly for late lootAdd.
    if (opts.count && settledNpcId) {
      forgetRecentCargoKillSite(settledNpcId);
    } else if (pending && pending.x != null && pending.y != null) {
      rememberRecentCargoKillSite(settledNpcId, pending.x, pending.y);
    } else if (phase && phase.x != null && phase.y != null) {
      rememberRecentCargoKillSite(settledNpcId, phase.x, phase.y);
    }
    AUTO.pendingCombatCargo = null;
    // mac41: only end mandatory phase when finishing lifecycle (scoop or empty wait).
    endMandatoryPostKillCargoPhase(settledNpcId);
    AUTO.collectArriveAt = 0;
    AUTO.lastCargoCollectAttempt = null;
    clearCollectMovement(lootId);
    if (
      AUTO.currentTask === "collect" &&
      (!lootId || AUTO.taskTargetId === lootId || AUTO.pendingCollectId === lootId)
    ) {
      clearCurrentTask();
    }
    if (AUTO.pendingCollectId === lootId) AUTO.pendingCollectId = null;
    if (AUTO.chasingBonusId === lootId) AUTO.chasingBonusId = null;
    if (settledNpcId) markCargoSettledForNpc(settledNpcId);
    if (
      AUTO.raidCargoClear &&
      (!lootId || AUTO.raidCargoClear.cargoId === lootId)
    ) {
      clearRaidCargoClearState();
    }
    if (opts.count && lootId && !alreadyDone) {
      AUTO.cargoCollected += 1;
      updateStatisticsPanel();
      scheduleRefineryProcess();
    }
  }

  function isAllowedCombatCargo(id, sprite) {
    if (!canCollectCargoNow()) return false;
    if (!isCargoLoot(sprite, id)) return false;
    if (isCargoCollectAlreadyDone(id)) return false;
    if (isForeignOwnedLoot(id, sprite)) return false;
    // Raid Gate: scoop every visible non-foreign cargo (not only post-kill sticky).
    if (isInRaidMap()) return true;
    // Own kill drop near death spot (texture "cargo", never cargo1)
    if (isCargoNearPendingKill(sprite)) return true;
    // mac41: mandatory phase site survives pending phantom-clear
    if (isCargoNearMandatoryPhase(sprite)) return true;
    // Late lootAdd after pending expire — still own-kill, never soft-chase empty air
    if (isCargoNearRecentKillSite(sprite)) return true;
    // Fine stage: scoop leftover non-foreign cargo before portal (time-boxed window)
    if (isRaidStageClearCargoWindow()) return true;
    return false;
  }

  function isRaidStageClearCargoWindow() {
    return (
      Boolean(getGameState()?.raidStageClear) &&
      AUTO.raidStageClearCargoUntil > 0 &&
      Date.now() <= AUTO.raidStageClearCargoUntil
    );
  }

  function buildCollectibleEntry(id, sprite, ship) {
    if (!sprite || sprite.x == null || sprite.y == null) return null;
    const type = getLootTypeFromId(id, sprite);
    return {
      id,
      x: sprite.x,
      y: sprite.y,
      dist: ship ? distance(ship.x, ship.y, sprite.x, sprite.y) : 0,
      type,
      kind: type === "BOOTY_BOX" ? "booty" : type === "BONUS_BOX" ? "bonus" : "cargo",
    };
  }

  function getCollectibleById(id) {
    if (!id) return null;
    const sprite = getLootSprite(id);
    if (!sprite) return null;
    const ship = getShipPosition();

    if (isCargoLoot(sprite, id)) {
      if (isForeignOwnedLoot(id, sprite)) return null;
      if (
        !isAllowedCombatCargo(id, sprite) &&
        !(AUTO.currentTask === "collect" && AUTO.taskTargetId === id && AUTO.pendingCombatCargo)
      ) {
        return null;
      }
      return buildCollectibleEntry(id, sprite, ship);
    }

    if (isForeignOwnedLoot(id, sprite)) return null;
    return listCollectibles(0).find((item) => item.id === id) ?? null;
  }

  function listCollectibles(maxRadius) {
    const entities = getEntities();
    const ship = getShipPosition();
    if (!entities?.lootSprites || !ship || !hasAnyCollectMode()) return [];

    const items = [];
    for (const [id, sprite] of entities.lootSprites) {
      if (!isCollectibleWanted(id, sprite)) continue;
      const x = sprite.x;
      const y = sprite.y;
      if (x == null || y == null) continue;
      const dist = distance(ship.x, ship.y, x, y);
      if (maxRadius && dist > maxRadius) continue;
      const type = getLootTypeFromId(id, sprite);
      items.push({ id, x, y, dist, type, kind: type === "BOOTY_BOX" ? "booty" : type === "BONUS_BOX" ? "bonus" : "cargo" });
    }
    items.sort((a, b) => a.dist - b.dist);
    return items;
  }

  function noteCollectRemoved(id) {
    if (!id) return;
    const wasCargoTarget =
      AUTO.taskTargetId === id ||
      AUTO.pendingCollectId === id ||
      AUTO.chasingBonusId === id ||
      AUTO.cargoCollectInFlightId === id ||
      AUTO.pendingBonusIds.has(id);

    const sprite = getEntities()?.lootSprites?.get(id);
    const type = getLootTypeFromId(id, sprite);
    if (type === "BONUS_BOX") {
      noteBonusCollected(id);
      return;
    }
    if (type === "BOOTY_BOX") {
      AUTO.bootyCollected += 1;
      updateStatisticsPanel();
      if (AUTO.cargoCollectInFlightId === id) AUTO.cargoCollectInFlightId = null;
      clearCollectMovement(id);
      if (
        AUTO.currentTask === "collect" &&
        (AUTO.taskTargetId === id || AUTO.pendingCollectId === id || AUTO.chasingBonusId === id)
      ) {
        clearCurrentTask();
      }
      if (AUTO.pendingCollectId === id) AUTO.pendingCollectId = null;
      if (AUTO.chasingBonusId === id) AUTO.chasingBonusId = null;
      return;
    }
    if (type === "CARGO" || (wasCargoTarget && AUTO.pendingCombatCargo)) {
      finishCombatCargoCollect(id, { count: type === "CARGO" });
    }
  }

  function isPlayerPremium() {
    const player = getLocalPlayer();
    return Boolean(player?.premium_until && player.premium_until > Date.now());
  }

  function getCargoUsed() {
    const ores = getLocalPlayer()?.ores || {};
    let used = 0;
    for (const amount of Object.values(ores)) used += Number(amount) || 0;
    return used;
  }

  function getCargoCapacity() {
    return Number(getLocalPlayer()?.cargo_capacity) || 0;
  }

  function isCargoHoldFull() {
    const cap = getCargoCapacity();
    if (cap <= 0) return false;
    return getCargoUsed() >= cap;
  }

  function refreshCargoSkipGate() {
    if (AUTO.cargoSkipUntilUsedBelow == null) return;
    if (getCargoUsed() < AUTO.cargoSkipUntilUsedBelow) {
      AUTO.cargoSkipUntilUsedBelow = null;
      AUTO.cargoSkipLatchedAt = 0;
      return;
    }
    // Long-session safety: a false/early capacity latch must not disable scoop forever.
    // After TTL, re-probe — if the hold is not actually full, clear the latch.
    const latchedAt = AUTO.cargoSkipLatchedAt || 0;
    if (latchedAt && Date.now() - latchedAt >= CARGO_SKIP_REPROBE_MS) {
      if (!isCargoHoldFull()) {
        AUTO.cargoSkipUntilUsedBelow = null;
        AUTO.cargoSkipLatchedAt = 0;
      } else {
        AUTO.cargoSkipUntilUsedBelow = getCargoUsed();
        AUTO.cargoSkipLatchedAt = Date.now();
      }
    }
  }

  /** Mark hold as unable to accept more NPC cargo until space frees up. */
  function blockCargoUntilHoldFrees(reasonStatus = "status.cargo_hold_full") {
    AUTO.cargoSkipUntilUsedBelow = getCargoUsed();
    AUTO.cargoSkipLatchedAt = Date.now();
    const id =
      AUTO.cargoCollectInFlightId ||
      AUTO.taskTargetId ||
      AUTO.pendingCollectId ||
      AUTO.lastCargoCollectAttempt?.id;
    finishCombatCargoCollect(id, { count: false });
    // Belts-and-suspenders: never leave a move toward the last drop
    clearCollectMovement(id);
    setStatus(reasonStatus);
  }

  function canCollectCargoNow() {
    // mac45: cargo scoop must never run while Stop/Pause (manual play).
    if (!isBotLive()) return false;
    if (!AUTO.collectCargo) return false;
    refreshCargoSkipGate();
    if (isCargoHoldFull()) return false;
    if (AUTO.cargoSkipUntilUsedBelow != null) return false;
    return true;
  }

  /** Stiva piena / bloccata: abbandona cargo in corso e non ritornare sul punto. */
  function abortCargoCollectIfHoldFull() {
    refreshCargoSkipGate();
    const blocked =
      isCargoHoldFull() || AUTO.cargoSkipUntilUsedBelow != null;
    if (!blocked) return false;

    const targetId = AUTO.taskTargetId || AUTO.pendingCollectId || AUTO.cargoCollectInFlightId;
    const targetIsCargo =
      Boolean(AUTO.cargoCollectInFlightId) ||
      Boolean(AUTO.pendingCombatCargo) ||
      (AUTO.currentTask === "collect" && isCargoLoot(getLootSprite(targetId), targetId));

    if (!targetIsCargo && !AUTO.pendingCombatCargo) return false;

    const id = AUTO.cargoCollectInFlightId || targetId || AUTO.lastCargoCollectAttempt?.id;
    if (isCargoHoldFull() && AUTO.cargoSkipUntilUsedBelow == null) {
      AUTO.cargoSkipUntilUsedBelow = getCargoUsed();
      AUTO.cargoSkipLatchedAt = Date.now();
    }
    finishCombatCargoCollect(id, { count: false });
    clearCollectMovement(id);
    setStatus("status.cargo_hold_full");
    return true;
  }

  function getPlayerAmmoCount(ammoType) {
    const player = getLocalPlayer();
    return Number(player?.ammo?.[ammoType]) || 0;
  }

  function getActiveAmmoType() {
    return getLocalPlayer()?.active_ammo || null;
  }

  function listSelectedCombatAmmoTypes() {
    return COMBAT_AMMO_TYPES.map((entry) => entry.key).filter((key) => AUTO.selectedCombatAmmoTypes.has(key));
  }

  function listSelectedPrimaryAmmoTypes() {
    return COMBAT_PRIMARY_AMMO_TYPES.map((entry) => entry.key).filter((key) => AUTO.selectedCombatAmmoTypes.has(key));
  }

  function hasSelectedSpecialAmmo() {
    return COMBAT_SPECIAL_AMMO_TYPES.some((entry) => AUTO.selectedCombatAmmoTypes.has(entry.key));
  }

  function getCombatCooldowns() {
    return getGameScene()?.ui?.actionBar?.cooldowns ?? null;
  }

  function isRsapOnCooldown() {
    const cd = getCombatCooldowns();
    if (cd?.isRsapOnCooldown?.()) return true;
    return Date.now() < AUTO.combatRsapNextAt;
  }

  function getNpcShieldState(npcId) {
    const state = getGameState()?.npcs?.get(npcId);
    const max = Number(state?.max_shield ?? state?.maxShield) || 0;
    const current = Number(state?.current_shield ?? state?.shield ?? state?.currentShield) || 0;
    return {
      hasShield: max > 0.5 && current > 0.5,
      current,
      max,
    };
  }

  function pickBestCombatAmmoType(excludeType) {
    for (const type of listSelectedPrimaryAmmoTypes()) {
      if (type === excludeType) continue;
      if (getPlayerAmmoCount(type) > 0) return type;
    }
    return null;
  }

  /**
   * Strongest selected primary with stock (LAP4 > LAP3 > LAP2 > LAP1).
   * COMBAT_PRIMARY_AMMO_TYPES is ordered weak→strong; reverse for boss tiers.
   */
  function pickStrongestCombatAmmoType(excludeType) {
    const selected = listSelectedPrimaryAmmoTypes();
    for (let i = selected.length - 1; i >= 0; i--) {
      const type = selected[i];
      if (type === excludeType) continue;
      if (getPlayerAmmoCount(type) > 0) return type;
    }
    return null;
  }

  function pickPrimaryCombatAmmo(excludeType) {
    return pickBestCombatAmmoType(excludeType) || listSelectedPrimaryAmmoTypes()[0] || null;
  }

  /** True when ammo should prefer strongest selected primary (Executioner / last wave). */
  function shouldPreferStrongestCombatAmmo(npcId) {
    if (isRaidExecutionerRound()) return true;
    const npc = npcId ? getNpcEntry(npcId) || getStickyCombatNpcEntry(npcId) : null;
    const type = npc?.type;
    return type === "EXECUTIONER" || type === "EXECUTIONER1";
  }

  function shouldUseSapForNpc(npcId) {
    if (!AUTO.selectedCombatAmmoTypes.has("SAP")) return false;
    if (!listSelectedPrimaryAmmoTypes().length) return false;
    if (getPlayerAmmoCount("SAP") <= 0) return false;
    return getNpcShieldState(npcId).hasShield;
  }

  function shouldFireRsapBurst() {
    if (!AUTO.selectedCombatAmmoTypes.has("RSAP")) return false;
    if (!listSelectedPrimaryAmmoTypes().length) return false;
    if (getPlayerAmmoCount("RSAP") <= 0) return false;
    if (isRsapOnCooldown()) return false;
    return true;
  }

  function applySmartCombatAmmo(npcId) {
    if (!npcId || !AUTO.modeAttack) return false;
    const primary = listSelectedPrimaryAmmoTypes();
    if (!primary.length) return false;

    const active = getActiveAmmoType();
    const now = Date.now();
    const preferStrong = shouldPreferStrongestCombatAmmo(npcId);
    const pickPrimary = (excludeType) =>
      preferStrong
        ? pickStrongestCombatAmmoType(excludeType) || pickPrimaryCombatAmmo(excludeType)
        : pickPrimaryCombatAmmo(excludeType);

    if (shouldUseSapForNpc(npcId)) {
      if (active !== "SAP") {
        AUTO.combatPrimaryAmmoType = primary.includes(active) ? active : pickPrimary();
        switchCombatAmmo("SAP");
        return true;
      }
      return false;
    }

    if (active === "SAP") {
      const next = AUTO.combatPrimaryAmmoType || pickPrimary("SAP");
      if (next) switchCombatAmmo(next);
      return true;
    }

    if (active === "RSAP") {
      if (now >= AUTO.combatRsapBurstUntil) {
        const next = AUTO.combatPrimaryAmmoType || pickPrimary("RSAP");
        if (next) switchCombatAmmo(next);
        AUTO.combatRsapNextAt = now + COMBAT_RSAP_COOLDOWN_MS;
        return true;
      }
      return false;
    }

    if (shouldFireRsapBurst()) {
      AUTO.combatPrimaryAmmoType = primary.includes(active) ? active : pickPrimary();
      switchCombatAmmo("RSAP");
      AUTO.combatRsapBurstUntil = now + COMBAT_RSAP_BURST_MS;
      return true;
    }

    if (!primary.includes(active)) {
      const next = pickPrimary();
      if (next && next !== active) switchCombatAmmo(next);
      return Boolean(next && next !== active);
    }

    // Executioner / last wave: among selected primaries, always use the strongest in stock.
    if (preferStrong) {
      const best = pickStrongestCombatAmmoType();
      if (best && best !== active) {
        AUTO.combatPrimaryAmmoType = best;
        switchCombatAmmo(best);
        return true;
      }
    }

    return false;
  }

  function canAutoBuyCombatAmmoNow() {
    if (AUTO.combatAmmoBuyQty <= 0) return false;
    if (AUTO.combatAmmoBuyPending) return false;
    if (Date.now() - AUTO.combatAmmoLastBuyAt < COMBAT_AMMO_BUY_COOLDOWN_MS) return false;
    return Boolean(window.__RG_NET__?.sendBuyAmmo);
  }

  function switchCombatAmmo(ammoType) {
    const net = window.__RG_NET__;
    const player = getLocalPlayer();
    if (!net?.sendSwitchAmmo || !ammoType) return false;
    if (player?.active_ammo === ammoType) return true;
    net.sendSwitchAmmo(ammoType);
    if (player) player.active_ammo = ammoType;
    return true;
  }

  function buyCombatAmmo(ammoType, packQty) {
    const net = window.__RG_NET__;
    if (!net?.sendBuyAmmo || !ammoType || packQty <= 0) return false;
    net.sendBuyAmmo(ammoType, packQty);
    AUTO.combatAmmoBuyPending = true;
    AUTO.combatAmmoBuyPendingAt = Date.now();
    AUTO.combatAmmoLastBuyAt = Date.now();
    return true;
  }

  function toggleCombatAmmoType(typeKey) {
    const isSpecial = COMBAT_SPECIAL_AMMO.has(typeKey);
    if (AUTO.selectedCombatAmmoTypes.has(typeKey)) {
      AUTO.selectedCombatAmmoTypes.delete(typeKey);
    } else {
      if (isSpecial && !listSelectedPrimaryAmmoTypes().length) {
        setStatus("SAP/RSAP richiedono almeno una munizione LAP1-4");
        updateAttackAmmoButtons();
        return;
      }
      AUTO.selectedCombatAmmoTypes.add(typeKey);
    }
    if (!listSelectedPrimaryAmmoTypes().length) {
      AUTO.selectedCombatAmmoTypes.delete("SAP");
      AUTO.selectedCombatAmmoTypes.delete("RSAP");
    }
    updateAttackAmmoButtons();
  }

  function setCombatAmmoBuyQty(qty) {
    AUTO.combatAmmoBuyQty = COMBAT_AMMO_BUY_QTY_OPTIONS.includes(qty) ? qty : 0;
    updateAttackAmmoButtons();
  }

  function updateAttackAmmoButtons() {
    document.querySelectorAll("[data-combat-ammo]").forEach((btn) => {
      btn.classList.toggle("selected", AUTO.selectedCombatAmmoTypes.has(btn.dataset.combatAmmo));
    });
    document.querySelectorAll("[data-combat-ammo-buy]").forEach((btn) => {
      const qty = Number(btn.dataset.combatAmmoBuy) || 0;
      btn.classList.toggle("selected", qty === AUTO.combatAmmoBuyQty);
    });

    const statusEl = document.getElementById("rg-combat-ammo-status");
    if (!statusEl) return;

    const selected = listSelectedPrimaryAmmoTypes();
    if (!selected.length) {
      statusEl.textContent = hasSelectedSpecialAmmo()
        ? "munizioni: seleziona LAP1-4 per SAP/RSAP"
        : "munizioni: manuale";
      return;
    }

    const active = getActiveAmmoType();
    const activeEntry = COMBAT_AMMO_TYPES.find((entry) => entry.key === active);
    const activeLabel = activeEntry?.label || active || "—";
    const activeCount = active ? getPlayerAmmoCount(active) : 0;
    const special = [];
    if (AUTO.selectedCombatAmmoTypes.has("SAP")) special.push("SAP");
    if (AUTO.selectedCombatAmmoTypes.has("RSAP")) special.push("RSAP");
    const specialPart = special.length ? ` · extra: ${special.join("+")}` : "";
    const buyPart =
      AUTO.combatAmmoBuyQty > 0 ? ` · auto-buy x${AUTO.combatAmmoBuyQty} sotto ${COMBAT_AMMO_LOW_THRESHOLD}` : "";
    statusEl.textContent = `attiva: ${activeLabel} (${activeCount})${specialPart}${buyPart}`;
  }

  function processCombatAmmoTick() {
    if (!listSelectedPrimaryAmmoTypes().length) return false;

    // Already fighting: never stall engage for shop round-trip / low-ammo top-up.
    const inCombat =
      AUTO.currentTask === "combat" ||
      isCombatEngaged() ||
      (AUTO.combatActive && Boolean(AUTO.combatFocusId || AUTO.taskTargetId));

    const now = Date.now();
    if (AUTO.combatAmmoBuyPending && now - AUTO.combatAmmoBuyPendingAt < 6000) {
      return !inCombat;
    }
    if (AUTO.combatAmmoBuyPending && now - AUTO.combatAmmoBuyPendingAt >= 6000) {
      AUTO.combatAmmoBuyPending = false;
    }

    const selected = listSelectedPrimaryAmmoTypes();
    if (!selected.length) return false;

    let active = getActiveAmmoType();
    let activeCount = active ? getPlayerAmmoCount(active) : 0;

    if (COMBAT_SPECIAL_AMMO.has(active)) {
      const replacement = pickPrimaryCombatAmmo(active);
      if (replacement) {
        switchCombatAmmo(replacement);
        active = replacement;
        activeCount = getPlayerAmmoCount(replacement);
      }
    } else if (!selected.includes(active)) {
      const replacement = pickBestCombatAmmoType() || selected[0];
      if (replacement && replacement !== active) {
        switchCombatAmmo(replacement);
        active = replacement;
        activeCount = getPlayerAmmoCount(replacement);
      }
    }

    if (activeCount <= 0) {
      const alt = pickBestCombatAmmoType(active);
      if (alt) {
        switchCombatAmmo(alt);
        return false;
      }
      if (AUTO.combatAmmoBuyQty > 0 && canAutoBuyCombatAmmoNow()) {
        buyCombatAmmo(active || selected[0], AUTO.combatAmmoBuyQty);
        setStatus(`Acquisto munizioni ${active || selected[0]} x${AUTO.combatAmmoBuyQty}...`);
        // Empty magazine: still block engage until buy lands (unless already mid-fight).
        return !inCombat;
      }
      return false;
    }

    if (activeCount < COMBAT_AMMO_LOW_THRESHOLD && AUTO.combatAmmoBuyQty > 0 && canAutoBuyCombatAmmoNow()) {
      buyCombatAmmo(active, AUTO.combatAmmoBuyQty);
      setStatus(`Rifornimento munizioni ${active} x${AUTO.combatAmmoBuyQty} (${activeCount} rimaste)`);
      // Top-up while already fighting must not pause orbit/lock.
      return !inCombat;
    }

    return false;
  }

  function canUseRefineryNow() {
    const player = getLocalPlayer();
    return Boolean(player && !getGameState()?.isDead);
  }

  function hasRefineryActive() {
    return (
      AUTO.refineryAutoRefine ||
      (AUTO.refinerySellMinerals && isPlayerPremium()) ||
      (AUTO.refinerySendAntimatter && isPlayerPremium()) ||
      hasRefineryEnhanceWork()
    );
  }

  function requestPlayerSlowSync() {
    window.__RG_NET__?.requestSlowSync?.();
  }

  function applyCollectContentsToOres(contents) {
    const player = getLocalPlayer();
    if (!player || !contents) return false;
    if (!player.ores) player.ores = {};

    let changed = false;
    for (const [ore, amount] of Object.entries(contents)) {
      const qty = Number(amount) || 0;
      if (qty <= 0) continue;
      player.ores[ore] = (player.ores[ore] ?? 0) + qty;
      changed = true;
    }
    return changed;
  }

  function applyRefineResultLocal(recipe, amount) {
    const player = getLocalPlayer();
    if (!player) return;
    if (!player.ores) player.ores = {};

    for (const input of recipe.inputs) {
      player.ores[input.ore] = Math.max(0, (player.ores[input.ore] ?? 0) - input.amount * amount);
    }
    player.ores[recipe.output] = (player.ores[recipe.output] ?? 0) + amount;
  }

  function scheduleRefineryProcess(delayMs = 350) {
    AUTO.refineryPending = true;
    AUTO.refineryScheduledAt = Date.now() + delayMs;
  }

  function canRunScheduledRefinery() {
    return !AUTO.refineryScheduledAt || Date.now() >= AUTO.refineryScheduledAt;
  }

  function getPlayerOres() {
    return { ...(getLocalPlayer()?.ores || {}) };
  }

  function calcMaxRefineBatch(recipe, ores) {
    let max = Infinity;
    for (const input of recipe.inputs) {
      const have = ores[input.ore] ?? 0;
      max = Math.min(max, Math.floor(have / input.amount));
    }
    return max === Infinity ? 0 : max;
  }

  function sellMineralsExceptPremium() {
    const net = window.__RG_NET__;
    if (!net?.sendSellOre || !isPlayerPremium()) return false;

    const ores = getPlayerOres();
    let sold = false;
    for (const ore of ORE_SELL) {
      const amount = ores[ore] ?? 0;
      if (amount <= 0) continue;
      net.sendSellOre(ore, amount);
      sold = true;
    }
    return sold;
  }

  function transferAntimatterToStorage() {
    const net = window.__RG_NET__;
    if (!net?.sendTransferAntimatter || !isPlayerPremium()) return false;
    const player = getLocalPlayer();
    const amount = Number(player?.ores?.ANTIMATTER) || 0;
    if (amount <= 0) return false;
    net.sendTransferAntimatter("toStorage", amount);
    if (player?.ores) player.ores.ANTIMATTER = 0;
    return true;
  }

  function refineOneEfficientStep() {
    const net = window.__RG_NET__;
    if (!net?.sendRefineOre) return false;

    const ores = getPlayerOres();
    for (const recipe of REFINE_RECIPES) {
      if (recipe.output === "PLUTONIUM" || recipe.output === "TRITIUM") continue;
      const amount = calcMaxRefineBatch(recipe, ores);
      if (amount > 0) {
        net.sendRefineOre(recipe.output, amount);
        applyRefineResultLocal(recipe, amount);
        return true;
      }
    }

    const puRecipe = REFINE_RECIPES.find((recipe) => recipe.output === "PLUTONIUM");
    const trRecipe = REFINE_RECIPES.find((recipe) => recipe.output === "TRITIUM");
    const puMax = calcMaxRefineBatch(puRecipe, ores);
    const trMax = calcMaxRefineBatch(trRecipe, ores);
    if (puMax <= 0 && trMax <= 0) return false;

    const player = getLocalPlayer();
    const puHave = player?.ores?.PLUTONIUM ?? 0;
    const trHave = player?.ores?.TRITIUM ?? 0;
    let pickPu;
    if (puMax <= 0) pickPu = false;
    else if (trMax <= 0) pickPu = true;
    else if (puHave < trHave) pickPu = true;
    else if (trHave < puHave) pickPu = false;
    else pickPu = AUTO.refineryLastPremiumOre !== "PLUTONIUM";

    const recipe = pickPu ? puRecipe : trRecipe;
    const amount = pickPu ? puMax : trMax;
    AUTO.refineryLastPremiumOre = recipe.output;
    net.sendRefineOre(recipe.output, amount);
    applyRefineResultLocal(recipe, amount);
    return true;
  }

  function enrichRandInt(min, max) {
    const lo = Math.ceil(min);
    const hi = Math.floor(max);
    if (hi <= lo) return lo;
    return lo + Math.floor(Math.random() * (hi - lo + 1));
  }

  function enrichShuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  /**
   * Comparable boost leftover in "ore-units":
   * SHIELD/SPEED → remaining minutes; LASER/ROCKET → shots / 10.
   */
  function getEnrichRemainingScore(category) {
    const enrich = getLocalPlayer()?.enrich || {};
    const now = Date.now();
    if (category === "LASER") {
      return Math.max(0, Number(enrich.laserShots) || 0) / ENRICH_SHOTS_PER_ORE;
    }
    if (category === "ROCKET") {
      return Math.max(0, Number(enrich.rocketShots) || 0) / ENRICH_SHOTS_PER_ORE;
    }
    if (category === "SHIELD") {
      const exp = Number(enrich.shieldExpiresAt) || 0;
      return exp > now ? (exp - now) / 6e4 : 0;
    }
    if (category === "SPEED") {
      const exp = Number(enrich.speedExpiresAt) || 0;
      return exp > now ? (exp - now) / 6e4 : 0;
    }
    return 0;
  }

  function applyLocalEnrichOptimistic(category, amount) {
    const player = getLocalPlayer();
    if (!player || amount <= 0) return;
    if (!player.enrich) player.enrich = {};
    const e = player.enrich;
    const qty = Math.floor(amount);
    if (category === "LASER") {
      e.laserShots = (Number(e.laserShots) || 0) + qty * ENRICH_SHOTS_PER_ORE;
    } else if (category === "ROCKET") {
      e.rocketShots = (Number(e.rocketShots) || 0) + qty * ENRICH_SHOTS_PER_ORE;
    } else if (category === "SHIELD") {
      const now = Date.now();
      const base = Math.max(now, Number(e.shieldExpiresAt) || 0);
      e.shieldExpiresAt = base + qty * ENRICH_MINUTES_PER_ORE * 6e4;
    } else if (category === "SPEED") {
      const now = Date.now();
      const base = Math.max(now, Number(e.speedExpiresAt) || 0);
      e.speedExpiresAt = base + qty * ENRICH_MINUTES_PER_ORE * 6e4;
    }
  }

  function applyEnrichPayloadLocal(payload) {
    const player = getLocalPlayer();
    if (!player || !payload) return;
    if (payload.enrich && typeof payload.enrich === "object") {
      player.enrich = { ...(player.enrich || {}), ...payload.enrich };
    }
  }

  function clearRefineryEnhanceQueue() {
    AUTO.refineryEnhanceQueue = [];
  }

  function categoriesAssignedForOre(ore) {
    return ENHANCE_CATEGORIES.filter((cat) => AUTO.refineryOres[cat]?.has(ore));
  }

  /**
   * Split full stock across assigned systems with human-like randomness,
   * weighted toward the least-boosted (biggest remaining deficit).
   * Always sums exactly to stock (zero leftover).
   */
  function planHumanOreAllocation(stock, categories) {
    if (stock <= 0 || !categories.length) return [];
    if (categories.length === 1) return [{ category: categories[0], amount: stock }];

    const scored = categories.map((category) => ({
      category,
      remaining: getEnrichRemainingScore(category),
    }));
    scored.sort((a, b) => a.remaining - b.remaining || Math.random() - 0.5);

    const maxRem = Math.max(...scored.map((s) => s.remaining));
    const minRem = Math.min(...scored.map((s) => s.remaining));
    const gap = maxRem - minRem;
    const dumpBias = gap > 200 ? 0.58 : gap > 50 ? 0.42 : 0.28;

    const alloc = Object.fromEntries(categories.map((c) => [c, 0]));
    const roll = Math.random();

    if (roll < dumpBias) {
      // Dump most/all on the weakest system.
      const primary = scored[0].category;
      if (Math.random() < 0.62 || stock < 15) {
        alloc[primary] = stock;
      } else {
        let crumb = Math.max(1, Math.floor(stock * (0.05 + Math.random() * 0.25)));
        crumb = Math.min(crumb, stock - 1);
        const others = scored.slice(1);
        if (others.length === 1 || Math.random() < 0.55) {
          alloc[others[0].category] = crumb;
        } else {
          let left = crumb;
          for (let i = 0; i < others.length; i++) {
            if (i === others.length - 1) {
              alloc[others[i].category] = left;
            } else {
              const take = enrichRandInt(0, left);
              alloc[others[i].category] = take;
              left -= take;
            }
          }
        }
        alloc[primary] = stock - crumb;
      }
    } else if (roll < dumpBias + 0.38) {
      // Deficit-weighted rough split (noisy proportions).
      const weights = scored.map((s) => {
        const deficit = Math.max(1, maxRem - s.remaining + Math.max(20, gap * 0.15));
        return {
          category: s.category,
          weight: deficit * (0.75 + Math.random() * 0.55),
        };
      });
      const totalW = weights.reduce((sum, w) => sum + w.weight, 0) || 1;
      let assigned = 0;
      for (let i = 0; i < weights.length - 1; i++) {
        const ideal = (stock * weights[i].weight) / totalW;
        const slotsLeft = weights.length - 1 - i;
        const amt = Math.max(
          0,
          Math.min(stock - assigned - slotsLeft, Math.round(ideal))
        );
        alloc[weights[i].category] = amt;
        assigned += amt;
      }
      alloc[weights[weights.length - 1].category] = stock - assigned;
    } else {
      // Near-equal human split (e.g. 117 → 58+59), with light jitter.
      const n = categories.length;
      const base = Math.floor(stock / n);
      let rem = stock - base * n;
      const order = enrichShuffle([...categories]);
      for (const c of order) alloc[c] = base;
      for (let i = 0; i < rem; i++) alloc[order[i % n]] += 1;
      if (stock >= 20 && n >= 2 && Math.random() < 0.45) {
        const move = enrichRandInt(1, Math.max(1, Math.floor(stock * 0.08)));
        const a = order[0];
        const b = order[1];
        if (alloc[a] > move) {
          alloc[a] -= move;
          alloc[b] += move;
        }
      }
    }

    const parts = Object.entries(alloc)
      .filter(([, amount]) => amount > 0)
      .map(([category, amount]) => ({ category, amount }));
    const sum = parts.reduce((s, p) => s + p.amount, 0);
    if (sum !== stock && parts.length) {
      parts[0].amount += stock - sum;
    }
    return parts.filter((p) => p.amount > 0);
  }

  /** Turn per-category totals into a few large API sends (not 10-at-a-time). */
  function chunkHumanEnrichSends(ore, parts) {
    const ordered = [...parts].sort(
      (a, b) =>
        getEnrichRemainingScore(a.category) - getEnrichRemainingScore(b.category) ||
        Math.random() - 0.5
    );
    const queue = [];
    for (const part of ordered) {
      let left = part.amount;
      if (left <= 0) continue;
      const split =
        left >= 40 && Math.random() < 0.35
          ? 2
          : left >= 90 && Math.random() < 0.2
            ? 3
            : 1;
      if (split === 1) {
        queue.push({ ore, category: part.category, amount: left });
        continue;
      }
      for (let i = 0; i < split; i++) {
        if (left <= 0) break;
        if (i === split - 1) {
          queue.push({ ore, category: part.category, amount: left });
          left = 0;
        } else {
          const share = Math.max(
            1,
            Math.floor(left * (0.45 + Math.random() * 0.3))
          );
          const take = Math.min(left - 1, share);
          queue.push({ ore, category: part.category, amount: take });
          left -= take;
        }
      }
    }
    return queue;
  }

  function listOresWithEnhanceStock() {
    const ores = getPlayerOres();
    const found = new Set();
    for (const cat of ENHANCE_CATEGORIES) {
      const selected = AUTO.refineryOres[cat];
      if (!selected?.size) continue;
      for (const ore of selected) {
        if ((ores[ore] ?? 0) > 0) found.add(ore);
      }
    }
    return [...found];
  }

  function ensureEnhanceQueue() {
    if (!Array.isArray(AUTO.refineryEnhanceQueue)) AUTO.refineryEnhanceQueue = [];
    if (AUTO.refineryEnhanceQueue.length) return true;

    const ores = getPlayerOres();
    const oreList = listOresWithEnhanceStock();
    if (!oreList.length) return false;

    // Prefer ores assigned to multiple systems (balance matters), then largest stock.
    oreList.sort((a, b) => {
      const ca = categoriesAssignedForOre(a).length;
      const cb = categoriesAssignedForOre(b).length;
      if (cb !== ca) return cb - ca;
      return (ores[b] ?? 0) - (ores[a] ?? 0);
    });

    const ore = oreList[0];
    const stock = Math.floor(ores[ore] ?? 0);
    const categories = categoriesAssignedForOre(ore);
    if (stock <= 0 || !categories.length) return false;

    const parts = planHumanOreAllocation(stock, categories);
    AUTO.refineryEnhanceQueue = chunkHumanEnrichSends(ore, parts);
    return AUTO.refineryEnhanceQueue.length > 0;
  }

  function enrichOneStep() {
    const net = window.__RG_NET__;
    if (!net?.sendEnrichOre) return false;
    if (!ensureEnhanceQueue()) return false;

    while (AUTO.refineryEnhanceQueue.length) {
      const pick = AUTO.refineryEnhanceQueue.shift();
      if (!pick) continue;
      const have = Math.floor(getPlayerOres()[pick.ore] ?? 0);
      const amount = Math.min(Math.floor(pick.amount) || 0, have);
      if (amount <= 0) {
        // Drop leftover planned sends for this ore if stock vanished.
        AUTO.refineryEnhanceQueue = AUTO.refineryEnhanceQueue.filter((q) => q.ore !== pick.ore);
        continue;
      }

      net.sendEnrichOre(pick.ore, pick.category, amount);

      const player = getLocalPlayer();
      if (player?.ores) {
        player.ores[pick.ore] = Math.max(0, (Number(player.ores[pick.ore]) || 0) - amount);
      }
      applyLocalEnrichOptimistic(pick.category, amount);
      return true;
    }
    return false;
  }

  function hasRefineryEnhanceWork() {
    if (!AUTO.refineryAutoEnhance) return false;
    return Object.values(AUTO.refineryOres).some((set) => set.size > 0);
  }

  function hasRefineryWorkPending() {
    return (
      AUTO.refineryPending ||
      (AUTO.refinerySellMinerals && isPlayerPremium()) ||
      (AUTO.refinerySendAntimatter && isPlayerPremium()) ||
      AUTO.refineryAutoRefine ||
      hasRefineryEnhanceWork()
    );
  }

  function processRefineryTick() {
    if (!hasRefineryActive()) return false;
    if (!canUseRefineryNow()) return false;
    if (!canRunScheduledRefinery()) return false;

    const now = Date.now();
    if (now - AUTO.lastRefineryAt < 650) return false;

    const shouldRun =
      AUTO.refineryPending ||
      AUTO.refineryAutoRefine ||
      (AUTO.refinerySellMinerals && isPlayerPremium()) ||
      (AUTO.refinerySendAntimatter && isPlayerPremium()) ||
      hasRefineryEnhanceWork();
    if (!shouldRun) return false;

    if (AUTO.refinerySellMinerals && isPlayerPremium()) {
      if (sellMineralsExceptPremium()) {
        AUTO.lastRefineryAt = now;
        AUTO.refineryPending = false;
        AUTO.refineryScheduledAt = 0;
        requestPlayerSlowSync();
        setStatus("Raffineria: vendo minerali (premium)");
        return true;
      }
      if (!isPlayerPremium()) {
        AUTO.refinerySellMinerals = false;
        updateModeButtons();
      }
    }

    if (AUTO.refinerySendAntimatter && isPlayerPremium()) {
      if (transferAntimatterToStorage()) {
        AUTO.lastRefineryAt = now;
        AUTO.refineryPending = false;
        AUTO.refineryScheduledAt = 0;
        requestPlayerSlowSync();
        setStatus("status.antimatter_sent");
        return true;
      }
    }

    if (AUTO.refineryAutoRefine && refineOneEfficientStep()) {
      AUTO.lastRefineryAt = now;
      AUTO.refineryPending = true;
      AUTO.refineryScheduledAt = now + 500;
      requestPlayerSlowSync();
      setStatus("Raffineria: raffinamento efficiente");
      return true;
    }

    if (AUTO.refineryAutoEnhance && hasRefineryEnhanceWork() && enrichOneStep()) {
      AUTO.lastRefineryAt = now;
      AUTO.refineryPending = true;
      AUTO.refineryScheduledAt = now + 500;
      requestPlayerSlowSync();
      setStatus("Raffineria: potenziamento");
      return true;
    }

    if (AUTO.refineryAutoRefine || hasRefineryEnhanceWork()) {
      AUTO.refineryPending = false;
      AUTO.refineryScheduledAt = 0;
    }
    return false;
  }

  function toggleRefineryOption(option, extra) {
    if (option === "sell") {
      if (!isPlayerPremium()) {
        setStatus("status.premium_sell");
        return;
      }
      AUTO.refinerySellMinerals = !AUTO.refinerySellMinerals;
    }
    if (option === "antimatter") {
      if (!isPlayerPremium()) {
        setStatus("status.premium_antimatter");
        return;
      }
      AUTO.refinerySendAntimatter = !AUTO.refinerySendAntimatter;
      setStatus(AUTO.refinerySendAntimatter ? "status.antimatter_on" : "status.antimatter_off");
    }
    if (option === "refine") AUTO.refineryAutoRefine = !AUTO.refineryAutoRefine;
    if (option === "enhance") {
      AUTO.refineryAutoEnhance = !AUTO.refineryAutoEnhance;
      if (!AUTO.refineryAutoEnhance) {
        clearRefineryEnhanceQueue();
        for (const key of ENHANCE_CATEGORIES) {
          AUTO.refineryOres[key]?.clear();
        }
      }
    }
    if (option === "ore" && extra?.category && extra?.ore) {
      if (!AUTO.refineryAutoEnhance) {
        setStatus("status.enhance_first");
        updateModeButtons();
        return;
      }
      const set = AUTO.refineryOres[extra.category];
      if (!set) return;
      if (set.has(extra.ore)) set.delete(extra.ore);
      else set.add(extra.ore);
      clearRefineryEnhanceQueue();
      const label = extra.ore.charAt(0) + extra.ore.slice(1).toLowerCase();
      setStatus(
        set.has(extra.ore)
          ? `Potenziamento ${extra.category}: +${label}`
          : `Potenziamento ${extra.category}: -${label}`
      );
    }
    updateModeButtons();
  }

  function isBonusLoot(sprite) {
    if (!sprite) return false;
    if (sprite.lootType === "BONUS_BOX") return true;
    const key = sprite.spr?.texture?.key || sprite.spr?.frame?.texture?.key;
    return key === "bonusbox";
  }

  function listBonusBoxes(maxRadius) {
    return listCollectibles(maxRadius).filter((item) => item.kind === "bonus");
  }

  function nearestBonusBox(maxRadius) {
    const boxes = listBonusBoxes(maxRadius);
    return boxes.length ? boxes[0] : null;
  }

  function getNpcSprite(id) {
    return getEntities()?.npcSprites?.get(id) ?? null;
  }

  function getNpcPosition(sprite) {
    if (!sprite) return null;
    return {
      x: sprite.interp?.x ?? sprite.x,
      y: sprite.interp?.y ?? sprite.y,
    };
  }

  function getGameState() {
    return window.__RG_STATE__ ?? null;
  }

  async function loadMapGraph() {
    if (MAP_GRAPH) return MAP_GRAPH;
    try {
      const res = await fetch("/story/map_graph.json", { cache: "no-store" });
      if (res.ok) MAP_GRAPH = await res.json();
    } catch (_) {}
    if (!MAP_GRAPH) MAP_GRAPH = { nodes: {}, edges: [], aw: {} };
    return MAP_GRAPH;
  }

  function shortMapLabel(name) {
    if (!name) return "";
    const match = String(name).match(/^([A-Z])[A-Z]+-(\d+)$/i);
    return match ? `${match[1].toUpperCase()}-${match[2]}` : name;
  }

  function resolveMapRef(ref) {
    if (!ref) return null;
    const graph = MAP_GRAPH;
    const raw = String(ref).trim();
    const upper = raw.toUpperCase();

    if (graph?.nodes?.[upper]) return upper;
    if (graph?.aw?.[upper]) return upper;

    for (const [id, node] of Object.entries(graph?.nodes || {})) {
      if (node.short?.toUpperCase() === upper) return id;
      if (node.name?.toUpperCase() === upper) return id;
      if (node.name?.toUpperCase().replace(/\s+/g, "-") === upper) return id;
    }

    for (const [id, name] of Object.entries(graph?.aw || {})) {
      if (name.toUpperCase() === upper) return id;
      if (shortMapLabel(name).toUpperCase() === upper) return id;
    }

    return null;
  }

  function getMapNode(mapId) {
    if (!mapId) return null;
    const graph = MAP_GRAPH;
    const node = graph?.nodes?.[mapId];
    if (node) return node;
    const name = graph?.aw?.[mapId] || mapId;
    return { id: mapId, name, short: shortMapLabel(name), faction: "" };
  }

  function formatMapLabel(mapId) {
    const node = getMapNode(mapId);
    if (!node) return mapId || "—";
    const short = node.short && node.short !== node.name ? node.short : "";
    return short ? `${short} (${node.name})` : node.name;
  }

  function getCurrentMapId() {
    return getGameState()?.mapId || "";
  }

  function getCurrentMapInfo() {
    const mapId = getCurrentMapId();
    return { id: mapId, ...getMapNode(mapId) };
  }

  function listKnownMaps() {
    const graph = MAP_GRAPH;
    if (!graph?.nodes) return [];
    return Object.values(graph.nodes)
      .filter((n) => n.id.startsWith("MAP") || n.id.startsWith("SECTOR"))
      .sort((a, b) => {
        const fa = a.faction.localeCompare(b.faction);
        return fa !== 0 ? fa : a.name.localeCompare(b.name);
      });
  }

  function listRuntimePortals() {
    const K = getGameState();
    const ship = getShipPosition();
    if (!K?.portals) return [];

    return K.portals.map((p) => {
      const targetId = normalizePortalTarget(p.target_map);
      const node = getMapNode(targetId);
      const dist = ship ? distance(ship.x, ship.y, p.x, p.y) : 0;
      return {
        id: p.id,
        x: p.x,
        y: p.y,
        target_map: p.target_map,
        targetId,
        label: node?.short || node?.name || p.target_map,
        fullLabel: formatMapLabel(targetId),
        dist,
        inRange: dist <= NAV.portalRange,
        isRaid: String(p.target_map).startsWith("raid_"),
      };
    }).sort((a, b) => a.dist - b.dist);
  }

  function normalizePortalTarget(target) {
    if (!target) return "";
    if (target === "next_stage" || target === "exit") return target;
    if (String(target).startsWith("raid_")) {
      const gate = String(target).replace("raid_", "").toUpperCase();
      return `RAID_${gate}`;
    }
    return target;
  }

  function resolveRaidGate(ref) {
    const raw = String(ref || "").trim().toLowerCase();
    const aliases = {
      void: "void",
      rift: "rift",
      nebula: "nebula",
      inferno: "inferno",
      raid_void: "void",
      raid_rift: "rift",
      raid_nebula: "nebula",
      raid_inferno: "inferno",
    };
    if (aliases[raw]) return aliases[raw];
    if (raw.startsWith("raid_")) return raw.slice(5);
    return raw;
  }

  function isNavHubMap(mapId) {
    return NAV_HUB_MAP_IDS.has(String(mapId || "").toUpperCase());
  }

  function findMapPath(fromId, toId, options = {}) {
    if (!fromId || !toId || fromId === toId) return [fromId];
    const graph = MAP_GRAPH;
    if (!graph?.edges?.length) return null;

    const avoidHubs = options.avoidHubs === true;
    const blocked = options.blocked instanceof Set ? options.blocked : null;

    const queue = [[fromId]];
    const seen = new Set([fromId]);
    while (queue.length) {
      const path = queue.shift();
      const cur = path[path.length - 1];
      if (cur === toId) return path;
      for (const edge of graph.edges) {
        if (edge.from !== cur || seen.has(edge.to)) continue;
        // Never route flee/heal through Sector X hubs unless the destination is the hub.
        if (avoidHubs && isNavHubMap(edge.to) && edge.to !== toId) continue;
        if (blocked && blocked.has(edge.to) && edge.to !== toId) continue;
        seen.add(edge.to);
        queue.push([...path, edge.to]);
      }
    }
    return null;
  }

  /**
   * Prefer a hub-free path; fall back to any path only when avoidHubsCannotReach.
   * Used by heal travel. Play travel keeps the unrestricted BFS.
   */
  function findMapPathPreferNoHubs(fromId, toId) {
    return (
      findMapPath(fromId, toId, { avoidHubs: true }) ||
      findMapPath(fromId, toId, { avoidHubs: false })
    );
  }

  function noteNavMapVisit(mapId) {
    if (!mapId) return;
    const recent = NAV.recentMaps || (NAV.recentMaps = []);
    if (recent[recent.length - 1] === mapId) return;
    recent.push(mapId);
    if (recent.length > 10) recent.shift();
  }

  /** Detect A-B-A-B (or A-B-C-A-B-C) bounce during flee/heal. */
  function isNavMapOscillating() {
    const r = NAV.recentMaps || [];
    if (r.length >= 4) {
      const a = r[r.length - 4];
      const b = r[r.length - 3];
      const c = r[r.length - 2];
      const d = r[r.length - 1];
      if (a && b && a === c && b === d && a !== b) return true;
    }
    if (r.length >= 6) {
      const x = r.slice(-6);
      if (x[0] === x[3] && x[1] === x[4] && x[2] === x[5] && x[0] !== x[1]) return true;
    }
    // Hub ping-pong: any 2 of last 5 visits are a hub + same faction map repeating.
    if (r.length >= 5) {
      const last5 = r.slice(-5);
      const hubs = last5.filter(isNavHubMap);
      if (hubs.length >= 2) {
        const nonHub = last5.filter((id) => !isNavHubMap(id));
        if (nonHub.length >= 2 && new Set(nonHub).size === 1) return true;
      }
    }
    return false;
  }

  function clearNavMapHistory() {
    NAV.recentMaps = [];
  }

  /**
   * Faction maps that have a known safe base (fallback): prefer X-7 then home.
   * O-5/O-6 have no fallback — routing heal to home via Sector X caused the loop.
   */
  function getFactionSafeHealMapCandidates() {
    const faction = String(getLocalPlayer()?.faction || getMapNode(getCurrentMapId())?.faction || "")
      .toUpperCase();
    if (faction === "HELIOS") return ["MAP19", "MAP1"];
    if (faction === "NOVA") return ["MAP20", "MAP2"];
    if (faction === "ORION") return ["MAP21", "MAP3"];
    const home = getFactionHomeMapId();
    return home ? [home] : [];
  }

  function mapHasKnownSafeBase(mapId) {
    if (!mapId) return false;
    if (FALLBACK_SAFE_BASES[mapId]) return true;
    // Live bases only count for the current map.
    if (mapId === getCurrentMapId() && listFactionSafeBases().length > 0) return true;
    return false;
  }

  /**
   * Pick heal destination: local base if any, else nearest faction safe map
   * reachable without Sector X when possible (e.g. O-6 → O-7, not O-5 → SX → home).
   */
  function pickHealSafeDestination() {
    const current = getCurrentMapId();
    if (current && mapHasKnownSafeBase(current)) return current;
    if (getNearestFactionSafeBase()) return current;

    const candidates = getFactionSafeHealMapCandidates();
    for (const dest of candidates) {
      if (!dest || dest === current) continue;
      if (findMapPath(current, dest, { avoidHubs: true })) return dest;
    }
    for (const dest of candidates) {
      if (!dest || dest === current) continue;
      if (findMapPath(current, dest, { avoidHubs: false })) return dest;
    }
    return getFactionHomeMapId();
  }

  /** True while heal/safe-zone travel owns navigation — HP flee must not interrupt. */
  function isHealSafeTravelActive() {
    return Boolean(
      AUTO.healSafeTravel ||
        AUTO.postDeathRecover ||
        (NAV.active && NAV.forHeal) ||
        (NAV.active && NAV.kind === "map" && NAV.forHeal)
    );
  }

  function findPortalHop(fromMapId, toMapId) {
    const K = getGameState();
    const ship = getShipPosition();
    const runtime = (K?.portals || []).filter((p) => p.target_map === toMapId);
    if (runtime.length) {
      return runtime.sort((a, b) => {
        if (!ship) return 0;
        return distance(ship.x, ship.y, a.x, a.y) - distance(ship.x, ship.y, b.x, b.y);
      })[0];
    }

    const edge = MAP_GRAPH?.edges?.find((e) => e.from === fromMapId && e.to === toMapId);
    if (!edge) return null;
    return {
      id: edge.portalId,
      x: edge.x,
      y: edge.y,
      target_map: toMapId,
    };
  }

  function getFactionHomeMapId() {
    const player = getLocalPlayer();
    const faction = String(player?.faction || "").toUpperCase();
    if (faction === "HELIOS") return "MAP1";
    if (faction === "NOVA") return "MAP2";
    if (faction === "ORION") return "MAP3";
    const current = getMapNode(getCurrentMapId());
    const currentFaction = String(current?.faction || "").toUpperCase();
    if (currentFaction === "HELIOS") return "MAP1";
    if (currentFaction === "NOVA") return "MAP2";
    if (currentFaction === "ORION") return "MAP3";
    return "MAP1";
  }

  /** Player / current-map faction used for raid hub lookups (HELIOS / NOVA / ORION). */
  function getRaidFactionId() {
    const player = getLocalPlayer();
    const faction = String(player?.faction || "").toUpperCase();
    if (faction === "HELIOS" || faction === "NOVA" || faction === "ORION") return faction;
    const current = getMapNode(getCurrentMapId());
    const currentFaction = String(current?.faction || "").toUpperCase();
    if (currentFaction === "HELIOS" || currentFaction === "NOVA" || currentFaction === "ORION") {
      return currentFaction;
    }
    return "";
  }

  /**
   * Raid portals spawn only on faction X-7 (HELIOS-7 / NOVA-7 / ORION-7).
   * Being on own-faction X-7 with the portal missing means the raid is unavailable — do not hop to X-1.
   */
  function isFactionRaidHubMap(mapId) {
    const node = getMapNode(mapId);
    if (!node) return false;
    const name = String(node.name || "");
    const match = name.match(/^([A-Za-z]+)-(\d+)$/);
    if (!match) return false;
    const ring = Number(match[2]);
    if (ring !== 7) return false;
    const mapFaction = String(node.faction || match[1] || "").toUpperCase();
    if (mapFaction !== "HELIOS" && mapFaction !== "NOVA" && mapFaction !== "ORION") return false;
    const raidFaction = getRaidFactionId();
    if (raidFaction && mapFaction !== raidFaction) return false;
    return true;
  }

  /** Ring number from map name (HELIOS-3 → 3), or 0 if unknown. */
  function getFactionMapRing(mapId) {
    const node = getMapNode(mapId);
    const name = String(node?.name || "");
    const match = name.match(/^([A-Za-z]+)-(\d+)$/);
    return match ? Number(match[2]) || 0 : 0;
  }

  /** Faction hub map id for ring 1 or 7 (e.g. HELIOS → MAP1 / MAP19). */
  function getFactionHubMapId(ring) {
    const want = Number(ring) === 7 ? 7 : 1;
    const faction = getRaidFactionId() || String(getLocalPlayer()?.faction || "").toUpperCase();
    const nodes = MAP_GRAPH?.nodes || {};
    for (const node of Object.values(nodes)) {
      if (!node?.id || !String(node.id).startsWith("MAP")) continue;
      const mapFaction = String(node.faction || "").toUpperCase();
      if (faction && mapFaction !== faction) continue;
      const m = String(node.name || "").match(/^([A-Za-z]+)-(\d+)$/);
      if (m && Number(m[2]) === want) return node.id;
    }
    // Fallbacks if graph not loaded yet.
    if (want === 7) {
      if (faction === "HELIOS") return "MAP19";
      if (faction === "NOVA") return "MAP20";
      if (faction === "ORION") return "MAP21";
    }
    return getFactionHomeMapId();
  }

  /**
   * Raid-gate search hub: always own-faction X-7 (from any map, including X-1…X-6).
   * Already on X-7 → callers keep current map (hub === current).
   */
  function pickRaidGateSearchHubMapId(_fromMapId = getCurrentMapId()) {
    return getFactionHubMapId(7);
  }

  function portalRaidGate(portal) {
    const target = String(portal?.target_map || portal?.targetMap || "").toLowerCase();
    if (!target.startsWith("raid_")) return null;
    return resolveRaidGate(target.slice(5));
  }

  function findRaidPortal(gateId) {
    const gate = resolveRaidGate(gateId);
    const portals = getGameState()?.portals || [];
    const ship = getShipPosition();
    const matches = portals.filter((p) => portalRaidGate(p) === gate);
    if (!matches.length) return null;
    return matches.sort((a, b) => {
      if (!ship) return 0;
      return distance(ship.x, ship.y, a.x, a.y) - distance(ship.x, ship.y, b.x, b.y);
    })[0];
  }

  function requestRaidPortalReady(gateId) {
    const gate = resolveRaidGate(gateId);
    const net = window.__RG_NET__;
    if (!net?.sendRaidPrepared) return false;
    net.sendRaidPrepared(gate);
    return true;
  }

  function tryStartRaidNavigation(gateRef, options = {}) {
    const gateId = resolveRaidGate(gateRef);
    if (!gateId) {
      setStatus("status.raid_gate_invalid");
      return false;
    }

    if (isAtRaidWorkMap(gateId)) {
      return true;
    }

    const portal = findRaidPortal(gateId);
    if (!portal) return false;

    if (AUTO.active && !options.fromPlay) {
      stopCombat();
      clearCurrentTask();
    } else if (AUTO.active) {
      clearCurrentTask();
    }

    ensureNavigationLoop();
    NAV.active = true;
    NAV.kind = "raid";
    NAV.path = [portal];
    NAV.destinationId = `raid_${gateId}`;
    NAV.hopIndex = 0;
    NAV.phase = "move";
    NAV.lastMapId = getCurrentMapId();
    NAV.moveStartedAt = Date.now();
    NAV.jumpStartedAt = 0;
    NAV.pendingRaidGate = null;
    NAV.raidWaitSince = 0;
    AUTO.pendingRaidGate = null;
    updatePlayControls();

    setStatus(`Verso gate raid ${gateId.toUpperCase()}...`);
    return true;
  }

  function isRaidGatePortalAvailable(gateRef) {
    const gateId = resolveRaidGate(gateRef);
    if (!gateId) return false;
    if (isAtRaidWorkMap(gateId)) return true;
    return Boolean(findRaidPortal(gateId));
  }

  function failRaidGateUnavailable(gateId) {
    NAV.pendingRaidGate = null;
    AUTO.pendingRaidGate = null;
    NAV.playAfterArrival = false;
    if (NAV.active && (NAV.kind === "raid_wait" || NAV.kind === "raid")) {
      stopNavigation();
    }
    setStatus("status.raid_gate_unavailable", { gate: String(gateId || "").toUpperCase() });
    return false;
  }

  function beginRaidPlayTravel() {
    const gateId = resolveRaidGate(AUTO.raidGateId);
    if (!gateId) {
      setStatus("status.raid_gate_invalid");
      return false;
    }

    if (isAtRaidWorkMap(gateId)) {
      NAV.playAfterArrival = false;
      NAV.pendingRaidGate = null;
      AUTO.pendingRaidGate = null;
      return true;
    }

    if (tryStartRaidNavigation(gateId, { fromPlay: true })) {
      return true;
    }

    const currentId = getCurrentMapId();
    // Already on faction X-7 and portal missing → unavailable (do not hop to X-1).
    if (isFactionRaidHubMap(currentId)) {
      return failRaidGateUnavailable(gateId);
    }

    // From any map (incl. X-1…X-6) → own-faction X-7.
    const hubMap = pickRaidGateSearchHubMapId(currentId);
    if (hubMap && currentId && currentId !== hubMap) {
      NAV.pendingRaidGate = gateId;
      AUTO.pendingRaidGate = gateId;
      setStatus(
        `Verso ${formatMapLabel(hubMap)} per gate ${gateId.toUpperCase()}...`
      );
      return startMapNavigation(hubMap, { fromPlay: true });
    }

    return failRaidGateUnavailable(gateId);
  }

  function continuePendingRaidTravel() {
    const gateId = resolveRaidGate(NAV.pendingRaidGate || AUTO.pendingRaidGate || AUTO.raidGateId);
    if (!gateId || isAtRaidWorkMap(gateId)) {
      NAV.pendingRaidGate = null;
      AUTO.pendingRaidGate = null;
      return isAtRaidWorkMap(gateId);
    }

    if (tryStartRaidNavigation(gateId, { fromPlay: NAV.playAfterArrival })) {
      return true;
    }

    const currentId = getCurrentMapId();
    // On X-7 with portal still missing → stop; never try X-1.
    if (isFactionRaidHubMap(currentId)) {
      failRaidGateUnavailable(gateId);
      if (AUTO.active) stopPlay();
      return false;
    }

    const hubMap = pickRaidGateSearchHubMapId(currentId);
    if (hubMap && currentId !== hubMap) {
      return startMapNavigation(hubMap, { fromPlay: NAV.playAfterArrival });
    }

    failRaidGateUnavailable(gateId);
    if (AUTO.active) stopPlay();
    return false;
  }

  function stopNavigation() {
    NAV.active = false;
    NAV.kind = null;
    NAV.path = [];
    NAV.destinationId = null;
    NAV.hopIndex = 0;
    NAV.phase = "idle";
    NAV.jumpStartedAt = 0;
    NAV.moveStartedAt = 0;
    NAV.playAfterArrival = false;
    NAV.forHeal = false;
    NAV.raidWaitSince = 0;
    clearPortalJumpState();
    if (NAV.timerId) {
      clearInterval(NAV.timerId);
      NAV.timerId = null;
    }
    updatePlayControls();
  }

  function portalJumpKey(portal) {
    if (!portal) return null;
    const id = portal.id ?? portal.portalId ?? portal.portal_id;
    if (id != null && id !== "") return `id:${id}`;
    const tm = String(portal.targetId || portal.target_map || portal.targetMap || "");
    const x = Number.isFinite(portal.x) ? Math.round(portal.x) : "?";
    const y = Number.isFinite(portal.y) ? Math.round(portal.y) : "?";
    return `xy:${x},${y}:${tm}`;
  }

  function clearPortalJumpState() {
    NAV.jumpLatched = false;
    NAV.jumpAttemptCount = 0;
    NAV.jumpLastAttemptAt = 0;
    NAV.jumpConfirmReason = null;
    NAV.jumpPortalKey = null;
  }

  /** Enter jump phase for a portal hop — reset latch so a few presses are allowed again. */
  function beginPortalJumpPhase(portal) {
    NAV.phase = "jump";
    NAV.jumpStartedAt = Date.now();
    clearPortalJumpState();
    NAV.jumpPortalKey = portalJumpKey(portal);
  }

  function latchPortalJump(reason) {
    if (NAV.jumpLatched) return false;
    NAV.jumpLatched = true;
    NAV.jumpConfirmReason = reason || "confirmed";
    return true;
  }

  function findPortalInJumpRange(ship, maxDist) {
    if (!ship) return null;
    const portals = getGameState()?.portals || [];
    const limit = Number.isFinite(maxDist) ? maxDist : NAV.portalRange + 80;
    let best = null;
    let bestDist = Infinity;
    for (const p of portals) {
      if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) continue;
      const d = distance(ship.x, ship.y, p.x, p.y);
      if (d <= limit && d < bestDist) {
        best = p;
        bestDist = d;
      }
    }
    return best;
  }

  /**
   * After at least one jump press: portal gone / out of range means jump started
   * (or stage portal despawned). Calling tryJump then floods "nessun portale vicino".
   */
  function shouldLatchPortalJumpFromWorld() {
    if (NAV.jumpAttemptCount < 1) return false;
    const ship = getShipPosition();
    if (!ship) return false;
    if (NAV.jumpPortalKey) {
      const portals = getGameState()?.portals || [];
      const stillThere = portals.some((p) => portalJumpKey(p) === NAV.jumpPortalKey);
      if (!stillThere) return true;
    }
    if (!findPortalInJumpRange(ship, NAV.portalRange + 120)) return true;
    return false;
  }

  /**
   * Human-like portal jump: a few spaced presses, then stop once confirmed.
   * Never call tryJump after latch — game shows "nessun portale vicino" when portal is gone.
   */
  function requestPortalJump(input) {
    if (NAV.jumpLatched) return false;
    if (shouldLatchPortalJumpFromWorld()) {
      latchPortalJump("portal_gone");
      return false;
    }
    if (NAV.jumpAttemptCount >= JUMP_ATTEMPT_MAX) {
      latchPortalJump("max_attempts");
      return false;
    }
    const now = Date.now();
    const needMs = JUMP_ATTEMPT_BASE_MS + NAV.jumpAttemptCount * JUMP_ATTEMPT_BACKOFF_MS;
    if (NAV.jumpLastAttemptAt && now - NAV.jumpLastAttemptAt < needMs) return false;
    NAV.jumpLastAttemptAt = now;
    NAV.jumpAttemptCount += 1;
    input?.tryJump?.();
    // Immediate re-check: stage portals often despawn on first successful send.
    if (shouldLatchPortalJumpFromWorld()) latchPortalJump("portal_gone");
    return true;
  }

  /** Shared jump-phase wait: latched → idle; else press with backoff. Handles stuck timeout. */
  function drivePortalJumpWait(input, statusText) {
    if (!NAV.jumpLatched && shouldLatchPortalJumpFromWorld()) {
      latchPortalJump("portal_gone");
    }
    if (NAV.jumpLatched) {
      setStatus(statusText);
    } else {
      requestPortalJump(input);
      setStatus(statusText);
    }
    if (Date.now() - NAV.jumpStartedAt > NAV.jumpTimeoutMs) {
      if (NAV.jumpLatched) {
        // Transfer seemed stuck — allow one careful retry cycle.
        clearPortalJumpState();
        NAV.jumpPortalKey = portalJumpKey(NAV.path?.[0]);
        NAV.jumpStartedAt = Date.now();
        setStatus("Salto in attesa, riprovo...");
        return "retry";
      }
      NAV.phase = "move";
      NAV.moveStartedAt = Date.now();
      clearPortalJumpState();
      return "move";
    }
    return "wait";
  }

  function navigationTick() {
    if (!NAV.active) return;
    // Dedicated nav timer must honor portal cooldown (mainTick alone is not enough).
    if (holdForPortalWait()) return;
    driveNavigationTick();
  }

  function ensureNavigationLoop() {
    if (NAV.timerId) return;
    NAV.timerId = window.setInterval(navigationTick, AUTO.tickMs);
  }

  function startMapNavigation(destRef, options = {}) {
    const destId = resolveMapRef(destRef);
    if (!destId) {
      setStatus(`Mappa sconosciuta: ${destRef}`);
      return false;
    }

    const currentId = getCurrentMapId();
    if (!currentId) {
      setStatus("Entra in mappa prima di navigare");
      return false;
    }

    if (currentId === destId) {
      if (options.fromPlay || options.forHeal) finishTravelArrival();
      else setStatus(`Sei già su ${formatMapLabel(destId)}`);
      return true;
    }

    const path = options.forHeal
      ? findMapPathPreferNoHubs(currentId, destId)
      : findMapPath(currentId, destId);
    if (!path || path.length < 2) {
      setStatus(`Percorso non trovato verso ${formatMapLabel(destId)}`);
      return false;
    }

    // If heal still routed through a hub, prefer a hub-free safe map (e.g. O-7) once.
    let finalPath = path;
    let finalDest = destId;
    if (
      options.forHeal &&
      !options._healRerouted &&
      path.some((id) => isNavHubMap(id) && id !== destId)
    ) {
      const safer = pickHealSafeDestination();
      if (safer && safer !== destId) {
        const alt = findMapPath(currentId, safer, { avoidHubs: true });
        if (alt && alt.length >= 2) {
          finalPath = alt;
          finalDest = safer;
        }
      }
    }

    if (options.forHeal) {
      clearCurrentTask();
    } else if (AUTO.active && !options.fromPlay) {
      stopCombat();
      clearCurrentTask();
    } else if (AUTO.active) {
      clearCurrentTask();
    }
    ensureNavigationLoop();
    NAV.active = true;
    NAV.kind = "map";
    NAV.path = finalPath;
    NAV.destinationId = finalDest;
    NAV.hopIndex = Math.max(0, finalPath.indexOf(currentId));
    NAV.phase = "move";
    NAV.lastMapId = currentId;
    NAV.moveStartedAt = Date.now();
    NAV.jumpStartedAt = 0;
    NAV.forHeal = !!options.forHeal;
    if (options.forHeal) noteNavMapVisit(currentId);
    // Heal travel must not steal the configured working map.
    if (!AUTO.raidGateId && !options.forHeal && !options.preserveWorkingMap) {
      AUTO.workingMapId = finalDest;
    }
    updateGeneralPanel();
    updatePlayControls();

    const labels = finalPath.map((id) => getMapNode(id)?.short || id).join(" → ");
    if (options.fromPlay) {
      setStatus(`Play travel startMapNavigation→${formatMapLabel(finalDest)}: ${labels}`);
    } else if (options.forHeal) {
      setStatus(`heal startMapNavigation→${formatMapLabel(finalDest)}: ${labels}`);
    } else {
      setStatus(`Verso ${formatMapLabel(finalDest)}: ${labels}`);
    }
    return true;
  }

  function startRaidNavigation(gateRef, options = {}) {
    AUTO.raidGateId = resolveRaidGate(gateRef);
    applyRaidGateNpcSelection(AUTO.raidGateId, { mergeVisible: false });
    if (options.fromPlay) NAV.playAfterArrival = true;
    return beginRaidPlayTravel();
  }

  function isBotPaused() {
    return AUTO.paused || state.paused;
  }

  function resetPauseState() {
    AUTO.paused = false;
    state.paused = false;
    const pauseBtn = document.getElementById("rg-story-pause");
    if (pauseBtn) pauseBtn.textContent = "Pausa";
    updateOrbVisual();
    updatePlayControls();
  }

  function driveNavigationTick() {
    if (!NAV.active) return false;
    if (isBotPaused()) {
      setStatus("Navigazione in pausa");
      return true;
    }

    // Block hops / jump retries while post-portal wait is active.
    if (holdForPortalWait()) return true;

    const input = getInputSystem();
    const ship = getShipPosition();
    const mapId = getCurrentMapId();
    if (!input || !ship || !mapId) {
      setStatus("Navigazione: attendo mappa...");
      return true;
    }

    if (NAV.kind === "raid_wait") {
      continuePendingRaidTravel();
      return true;
    }

    if (NAV.kind === "coffee") {
      // Prefer live allied portal center (same as heal). NAV.portalRange (~640m) is the
      // combat/drift ring — outside safe regen; NPCs can still hurt there.
      let portal = findNearestFriendlyPortal({ preferSafeBase: false });
      if (!portal || !Number.isFinite(portal.x) || !Number.isFinite(portal.y)) {
        portal = NAV.path[0];
      }
      if (!portal || !Number.isFinite(portal.x) || !Number.isFinite(portal.y)) {
        stopNavigation();
        finishCoffeeBreak();
        return false;
      }
      NAV.path = [portal];

      const dist = distance(ship.x, ship.y, portal.x, portal.y);
      const adminHold = AUTO.portalHoldReason === "admin";
      const atSafe =
        isInSafeZone() || isAtFriendlyPortalHealCenter(ship);

      if (!atSafe) {
        ensureActiveConfig(AUTO.roamConfig);
        softLongMoveToward(input, ship, portal.x, portal.y, {
          midPath: true,
          finalRange: 180,
        });
        if (adminHold) {
          setStatus("status.admin_to_safe", {
            name: AUTO.adminPauseName || "?",
            dist: Math.round(dist),
          });
        } else {
          setStatus("status.coffee_to_safe", { dist: Math.round(dist) });
        }
        return true;
      }

      stopNavigation();
      clearRaidHealMovement(input);
      input.attackMode = false;
      input.pendingAttackOnLock = null;
      clearLockedTarget();
      AUTO.coffeeBreakActive = true;
      const holdMin = rollCoffeeHoldDurationMin();
      AUTO.coffeeHoldRolledMin = holdMin;
      AUTO.coffeeBreakUntil = Date.now() + holdMin * 60000;
      const holdLabel = formatHoldDurationLabel(holdMin);
      if (adminHold) {
        setStatus("status.admin_pause_start", { min: holdLabel }, { skipDiscord: true });
        forceDiscordNotifyStatus(
          t("discord.admin_pause_start", {
            name: AUTO.adminPauseName || "?",
            min: holdLabel,
            time: formatCountdownSec(holdMin * 60),
          })
        );
        sendDiscordAdminAlert(
          "admin_pause",
          t("discord.admin_alert.pause", {
            name: AUTO.adminPauseName || "?",
            min: holdLabel,
          }),
          { name: AUTO.adminPauseName || "" }
        );
      } else {
        setStatus("status.coffee_start", { min: holdLabel }, { skipDiscord: true });
        forceDiscordNotifyStatus(
          t("discord.coffee_pause_start", {
            min: holdLabel,
            time: formatCountdownSec(holdMin * 60),
          })
        );
      }
      return true;
    }

    if (NAV.kind === "flee") {
      let portal = NAV.path[0];
      if (!portal) {
        stopNavigation();
        AUTO.fleeActive = false;
        return false;
      }

      // mac42: map/HP/heal flee sits at portal on the CURRENT map — NEVER tryJump.
      // NAV.forHeal is sticky (survives SAP promoting fleeMode→enemy). Only pure
      // enemy/PvP flee may enter the jump phase toward an adjacent map.
      const localPortalHeal =
        NAV.forHeal === true ||
        AUTO.fleeMode === "map" ||
        AUTO.fleeMode === "heal";

      if (localPortalHeal) {
        // Unintended teleport during portal-heal flee → abort farm, return to working map.
        if (mapId !== NAV.lastMapId && NAV.lastMapId) {
          noteNavMapVisit(mapId);
          clearPortalJumpState();
          stopNavigation();
          AUTO.fleeActive = false;
          AUTO.fleeMode = null;
          if (ensureReturnToWorkingMap("flee_unintended_jump")) {
            return true;
          }
          if (AUTO.active && AUTO.combatSuspendedForFlee) {
            beginPreObjectiveHeal({ armBaseWait: false });
          }
          return true;
        }

        // Prefer live allied portal center (same as coffee / cold heal).
        const live = findNearestFriendlyPortal({ preferSafeBase: false });
        if (live && Number.isFinite(live.x) && Number.isFinite(live.y)) {
          portal = live;
          NAV.path = [portal];
        }

        trySapShieldDuringPvpFlee();
        const dist = distance(ship.x, ship.y, portal.x, portal.y);
        const atSafe =
          isInSafeZone() ||
          isAtFriendlyPortalHealCenter(ship) ||
          dist <= 120;

        if (!atSafe) {
          // Force move phase — never linger in a stale jump phase from a prior hop.
          if (NAV.phase === "jump") {
            NAV.phase = "move";
            clearPortalJumpState();
          }
          ensureActiveConfig(AUTO.runConfig);
          softLongMoveToward(input, ship, portal.x, portal.y, {
            midPath: true,
            finalRange: 200,
          });
          setStatus("status.flee_heal_portal", {
            dist: Math.round(dist),
            map: formatMapLabel(mapId),
          });
          return true;
        }

        // Arrived at portal/safe: hold still and regen — clear any jump intent.
        clearPortalJumpState();
        clearRaidHealMovement(input);
        input.attackMode = false;
        input.pendingAttackOnLock = null;
        clearLockedTarget();
        input.clearMoveTarget?.();
        input.moveTarget = null;
        AUTO.lastMinimapTarget = null;
        stopNavigation();
        AUTO.fleeActive = false;
        AUTO.fleeMode = null;
        if (AUTO.active) {
          beginPreObjectiveHeal({ armBaseWait: false });
        }
        setStatus("status.heal_local_arm");
        return true;
      }

      // Enemy / PvP flee: approach portal then jump (escape to adjacent map).
      const dist = distance(ship.x, ship.y, portal.x, portal.y);
      if (NAV.phase === "move") {
        ensureActiveConfig(AUTO.runConfig);
        if (dist > NAV.portalRange) {
          softLongMoveToward(input, ship, portal.x, portal.y, {
            midPath: true,
            finalRange: NAV.portalRange + 180,
          });
          // SAP shield during PvP flee: ammo/lock only — never redirect movement.
          trySapShieldDuringPvpFlee();
          setStatus(`Fuga (${Math.round(dist)}m) → ${formatMapLabel(portal.targetId || portal.target_map)}`);
          return true;
        }
        beginPortalJumpPhase(portal);
      }

      if (NAV.phase === "jump") {
        // Keep firing SAP while waiting for jump; movement still owned by flee portal.
        trySapShieldDuringPvpFlee();
        if (mapId !== NAV.lastMapId && NAV.lastMapId) {
          latchPortalJump("map_change");
          noteNavMapVisit(mapId);
          AUTO.fleeActive = false;
          AUTO.fleeMode = null;
          finishTravelArrival();
          // After PvP escape jump: if off working map, return once healed.
          if (AUTO.active && AUTO.combatSuspendedForFlee) {
            beginPreObjectiveHeal({ armBaseWait: false });
          }
        } else {
          drivePortalJumpWait(input, "Fuga: teletrasporto...");
        }
        NAV.lastMapId = mapId;
        return true;
      }
      return true;
    }

    if (NAV.kind === "raid_stage") {
      const portal = NAV.path[0] || findRaidStagePortal("next_stage");
      if (!portal) {
        stopNavigation();
        return false;
      }

      if (mustHealBeforeRaidAdvance()) {
        stopNavigation();
        AUTO.raidHealMode = true;
        AUTO.raidFleeTarget = null;
        AUTO.raidHealSide = -1;
        AUTO.raidHealPhase = null;
        setStatus("Raid: attendo HP 100% prima della prossima ondata");
        return true;
      }

      const dist = distance(ship.x, ship.y, portal.x, portal.y);
      if (NAV.phase === "move") {
        ensureActiveConfig(AUTO.roamConfig);
        if (dist > NAV.portalRange) {
          setMoveTargetDirect(input, portal.x, portal.y);
          setStatus(`Raid: verso stage successivo (${Math.round(dist)}m)`);
          return true;
        }
        beginPortalJumpPhase(portal);
      }

      if (NAV.phase === "jump") {
        // tryJump alone sends sendRaidPortal when portal exists — do not also spam net.
        if (!getGameState()?.raidStageClear) {
          latchPortalJump("stage_advanced");
          if (mustHealBeforeRaidAdvance()) {
            stopNavigation();
            AUTO.raidHealMode = true;
            AUTO.raidFleeTarget = null;
            AUTO.raidHealSide = -1;
            AUTO.raidHealPhase = null;
          } else {
            clearRaidFleeStateIfRecovered();
          }
          finishTravelArrival();
        } else {
          drivePortalJumpWait(input, "Raid: salto allo stage successivo...");
        }
        return true;
      }
      return true;
    }

    if (NAV.kind === "map") {
      if (mapId === NAV.destinationId) {
        if (NAV.forHeal) clearNavMapHistory();
        finishTravelArrival();
        updateGeneralPanel();
        return NAV.active;
      }

      if (mapId !== NAV.lastMapId) {
        noteNavMapVisit(mapId);
        if (NAV.forHeal && isNavMapOscillating()) {
          const dest = pickHealSafeDestination();
          clearNavMapHistory();
          stopNavigation();
          if (
            dest &&
            mapId !== dest &&
            findMapPath(mapId, dest, { avoidHubs: true }) &&
            startMapNavigation(dest, { forHeal: true, _healRerouted: true })
          ) {
            AUTO.healSafeTravel = true;
            setStatus("status.heal_safe_travel", { map: formatMapLabel(dest) });
            return true;
          }
          AUTO.healSafeTravel = false;
          if (AUTO.active) beginPreObjectiveHeal({ armBaseWait: false });
          setStatus("status.flee_loop_abort");
          return true;
        }
        NAV.lastMapId = mapId;
        NAV.hopIndex = NAV.path.indexOf(mapId);
        if (NAV.hopIndex < 0) NAV.hopIndex = 0;
        NAV.phase = "move";
        NAV.moveStartedAt = Date.now();
        NAV.jumpStartedAt = 0;
        clearPortalJumpState();
        // Intermediate hop: apply post-portal wait before walking to the next portal.
        armPortalWait();
        if (holdForPortalWait()) return true;
      }

      const nextMapId = NAV.path[NAV.hopIndex + 1];
      if (!nextMapId) {
        finishTravelArrival();
        updateGeneralPanel();
        return NAV.active;
      }

      const portal = findPortalHop(mapId, nextMapId);
      if (!portal) {
        setStatus(`Portale verso ${formatMapLabel(nextMapId)} non trovato`);
        stopNavigation();
        return false;
      }

      const dist = distance(ship.x, ship.y, portal.x, portal.y);
      if (NAV.phase === "move") {
        ensureActiveConfig(AUTO.roamConfig);
        if (dist > NAV.portalRange) {
          // Final approach to portal: straight to center. Mid-path: light human wobble.
          softLongMoveToward(input, ship, portal.x, portal.y, {
            midPath: true,
            finalRange: NAV.portalRange + 220,
          });
          setStatus(`Verso ${formatMapLabel(nextMapId)} (${Math.round(dist)}m)`);
          if (Date.now() - NAV.moveStartedAt > NAV.moveTimeoutMs) {
            setStatus("Timeout movimento verso portale");
            stopNavigation();
          }
          return true;
        }
        beginPortalJumpPhase(portal);
      }

      if (NAV.phase === "jump") {
        if (mapId !== NAV.lastMapId && NAV.lastMapId) {
          latchPortalJump("map_change");
        }
        const jumpWait = drivePortalJumpWait(
          input,
          `Salto verso ${formatMapLabel(nextMapId)}...`
        );
        if (jumpWait === "move") {
          setStatus("Salto fallito, riprovo...");
        }
        return true;
      }
      return true;
    }

    if (NAV.kind === "raid") {
      const portal = NAV.path[0];
      const gateId = resolveRaidGate(NAV.destinationId?.replace("raid_", "") || "void");
      if (!portal) {
        stopNavigation();
        return false;
      }

      const dist = distance(ship.x, ship.y, portal.x, portal.y);
      if (NAV.phase === "move") {
        ensureActiveConfig(AUTO.roamConfig);
        if (dist > NAV.portalRange) {
          softLongMoveToward(input, ship, portal.x, portal.y, {
            midPath: true,
            finalRange: NAV.portalRange + 220,
          });
          setStatus(`Verso gate raid (${Math.round(dist)}m)`);
          if (Date.now() - NAV.moveStartedAt > NAV.moveTimeoutMs) {
            setStatus("Timeout movimento verso gate raid");
            stopNavigation();
          }
          return true;
        }
        beginPortalJumpPhase(portal);
      }

      if (NAV.phase === "jump") {
        // tryJump sends sendRaidJump when portal exists — do not also spam net every tick.
        if (getGameState()?.inRaid || String(mapId || "").startsWith("RAID_")) {
          latchPortalJump("raid_entered");
          finishTravelArrival();
        } else {
          drivePortalJumpWait(input, `Teletrasporto raid ${gateId.toUpperCase()}...`);
        }
        return true;
      }
    }

    return true;
  }

  function getActiveConfigIndex() {
    const K = getGameState();
    const player = K?.players?.get?.(K.mySessionId);
    return player?.active_config ?? 0;
  }

  function ensureActiveConfig(configNum) {
    const targetIndex = clamp(Math.round(Number(configNum) || 1) - 1, 0, 1);
    if (getActiveConfigIndex() === targetIndex) {
      AUTO.pendingConfigIndex = null;
      return true;
    }
    // trySwitchConfig is a TOGGLE with game cooldown. Spamming it every tick
    // double-flips or freezes movement — fatal vs fast Executioners.
    const now = Date.now();
    if (
      AUTO.pendingConfigIndex === targetIndex &&
      now - (AUTO.lastConfigSwitchAt || 0) < 1600
    ) {
      return false;
    }
    AUTO.pendingConfigIndex = targetIndex;
    AUTO.lastConfigSwitchAt = now;
    const input = getInputSystem();
    input?.trySwitchConfig?.();
    return false;
  }

  function getLocalPlayer() {
    const K = getGameState();
    if (!K?.mySessionId) return null;
    return K.players?.get?.(K.mySessionId) ?? null;
  }

  function formatGain(value) {
    const n = Number(value) || 0;
    if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, "")}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}K`;
    return String(Math.round(n));
  }

  function readHudStat(id) {
    const el = document.getElementById(id);
    if (!el) return null;
    const text = el.textContent?.trim();
    if (!text || text === "—") return null;
    return text;
  }

  function captureSessionBaseline() {
    const player = getLocalPlayer();
    AUTO.sessionStatsBaseline = {
      xp: player?.xp ?? 0,
      honor: player?.honor ?? 0,
      credits: player?.credits ?? 0,
      redMatter: player?.red_matter ?? 0,
      bonus: AUTO.bonusCollected,
      cargo: AUTO.cargoCollected,
      booty: AUTO.bootyCollected,
      npcKills: getNpcKillTotal(),
    };
  }

  function getSessionGains() {
    const base = AUTO.sessionStatsBaseline;
    const player = getLocalPlayer();
    if (!base) {
      return {
        bonus: AUTO.bonusCollected,
        cargo: AUTO.cargoCollected,
        booty: AUTO.bootyCollected,
        npcKills: getNpcKillTotal(),
        xp: 0,
        honor: 0,
        credits: 0,
        redMatter: 0,
      };
    }
    return {
      bonus: AUTO.bonusCollected - (base.bonus ?? 0),
      cargo: AUTO.cargoCollected - (base.cargo ?? 0),
      booty: AUTO.bootyCollected - (base.booty ?? 0),
      npcKills: getNpcKillTotal() - (base.npcKills ?? 0),
      xp: Math.max(0, (player?.xp ?? 0) - (base.xp ?? 0)),
      honor: Math.max(0, (player?.honor ?? 0) - (base.honor ?? 0)),
      credits: Math.max(0, (player?.credits ?? 0) - (base.credits ?? 0)),
      redMatter: Math.max(0, (player?.red_matter ?? 0) - (base.redMatter ?? 0)),
    };
  }

  function getSessionStats() {
    const gains = getSessionGains();
    return { ...gains };
  }

  function isAtRaidWorkMap(gateId) {
    if (!gateId) return false;
    const gate = resolveRaidGate(gateId);
    const K = getGameState();
    const mapId = getCurrentMapId();
    if (K?.inRaid && resolveRaidGate(K.raidGateId || "") === gate) return true;
    if (K?.inRaid && String(K.raidGateId || "").toLowerCase() === gate) return true;
    if (mapId === `RAID_${gate.toUpperCase()}`) return true;
    if (String(mapId || "").toLowerCase().includes(`raid_${gate}`)) return true;
    return false;
  }

  function needsTravelBeforeWork() {
    if (AUTO.raidGateId) return !isAtRaidWorkMap(AUTO.raidGateId);
    if (AUTO.workingMapId) return getCurrentMapId() !== AUTO.workingMapId;
    return false;
  }

  function hasPlayObjective() {
    return Boolean(AUTO.raidGateId || AUTO.workingMapId);
  }

  function isSectorZMap(mapId = getCurrentMapId()) {
    const id = String(mapId || "").toUpperCase();
    if (id === SECTOR_Z_MAP_ID || id === "SECTOR_Z" || id === "SECTORZ") return true;
    const label = String(formatMapLabel(mapId) || "").toLowerCase();
    if (label.includes("sector z")) return true;
    const node = MAP_GRAPH?.nodes?.[id];
    if (node && /sector\s*z/i.test(String(node.name || node.short || ""))) return true;
    return false;
  }

  /**
   * Farm/kill NPCs only on the selected working map, or on raid maps when a
   * Raid Gate is selected and the ship is in that raid. Nav/heal/flee/admin OK elsewhere.
   */
  function canEngageFarmCombat() {
    if (!AUTO.active || AUTO.paused) return false;
    if (isSectorZMap()) return false;
    if (AUTO.sectorZHoldActive) return false;
    if (AUTO.raidGateId) {
      return isInRaidMap() && isAtRaidWorkMap(AUTO.raidGateId);
    }
    if (AUTO.workingMapId) {
      return getCurrentMapId() === AUTO.workingMapId;
    }
    return false;
  }

  /**
   * mac42: if somehow off the selected working map (e.g. unintended flee jump),
   * abort farm and travel back. Never farm the wrong map.
   * Skips when raid selected, Sector Z hold, or already navigating to working map.
   */
  function ensureReturnToWorkingMap(reason = "") {
    if (!AUTO.active || AUTO.paused) return false;
    if (AUTO.raidGateId) return false;
    if (isInRaidMap()) return false;
    if (isSectorZMap() || AUTO.sectorZHoldActive) return false;
    const want = AUTO.workingMapId;
    if (!want) return false;
    const current = getCurrentMapId();
    if (!current || current === want) return false;

    // Already traveling to the working map — let nav own the tick.
    if (
      NAV.active &&
      NAV.kind === "map" &&
      (NAV.destinationId === want || NAV.playAfterArrival)
    ) {
      return true;
    }
    // Heal/flee/coffee/admin own movement — don't yank mid-hold unless unintended jump.
    if (
      reason !== "flee_unintended_jump" &&
      reason !== "after_flee" &&
      reason !== "after_heal" &&
      reason !== "farm_gate" &&
      (AUTO.fleeActive ||
        AUTO.postDeathRecover ||
        AUTO.coffeeBreakActive ||
        (NAV.active && (NAV.kind === "flee" || NAV.kind === "coffee")))
    ) {
      return false;
    }

    pauseCombatForFlee();
    AUTO.combatSuspendedForFlee = false;
    clearCurrentTask();
    const ok = beginPlayTravel();
    if (ok && NAV.active) {
      setStatus("status.wrong_map_return", {
        map: formatMapLabel(want) || want,
      });
      return true;
    }
    if (ok && getCurrentMapId() === want) {
      return false;
    }
    setStatus("status.wrong_map_no_farm", {
      map: formatMapLabel(want) || want,
    });
    return false;
  }

  /**
   * Pin working map to where the ship actually is (non-raid).
   * Stop→Play must resume in place: a stale dropdown (often X-1) must not yank
   * the ship after cold heal via beginPlayTravel.
   */
  function syncWorkingMapToCurrentMap(reason = "") {
    if (AUTO.raidGateId) return false;
    if (isInRaidMap()) return false;
    const currentId = getCurrentMapId();
    if (!currentId) return false;
    if (String(currentId).toUpperCase().startsWith("RAID_")) return false;
    // Never pin Sector Z (admin jail) as a farm working map.
    if (isSectorZMap(currentId)) return false;
    const changed = AUTO.workingMapId !== currentId;
    AUTO.workingMapId = currentId;
    const sel = document.getElementById("rg-working-map");
    if (sel && sel.value !== currentId) {
      try {
        sel.value = currentId;
      } catch (_) {
        /* ignore missing option */
      }
    }
    if (changed && reason) {
      /* reason kept for call-site diagnostics; status set by callers when useful */
    }
    return changed;
  }

  function finishTravelArrival() {
    const wasPlayTravel = NAV.playAfterArrival;
    const wasHealTravel = NAV.forHeal || AUTO.healSafeTravel;
    const pendingRaid = NAV.pendingRaidGate || AUTO.pendingRaidGate;
    const arrivedMapId = getCurrentMapId();
    stopNavigation();
    armPortalWait();

    if (wasHealTravel) {
      AUTO.healSafeTravel = false;
      clearNavMapHistory();
      if (AUTO.active && !AUTO.postDeathRecover) {
        beginPreObjectiveHeal({ armBaseWait: false });
      }
      setStatus("status.base_heal_wait");
      return;
    }

    if (pendingRaid && AUTO.active && !isAtRaidWorkMap(pendingRaid)) {
      // Stale pending without a selected raid gate must not force hub travel.
      if (!AUTO.raidGateId) {
        NAV.pendingRaidGate = null;
        AUTO.pendingRaidGate = null;
      } else {
        NAV.playAfterArrival = wasPlayTravel;
        NAV.pendingRaidGate = pendingRaid;
        AUTO.pendingRaidGate = pendingRaid;
        if (continuePendingRaidTravel()) return;
      }
    }

    if (wasPlayTravel && AUTO.active) {
      NAV.pendingRaidGate = null;
      AUTO.pendingRaidGate = null;
      // Arrived at objective: clear flee/recover leftovers and block false death/HP-flee.
      clearObjectiveArrivalTransientState();
      if (isInRaidMap()) {
        AUTO.portalWaitUntil = 0;
    AUTO.pendingCombatCargo = null;
    AUTO.mandatoryPostKillCargo = null;
    AUTO.cargoCollectInFlightId = null;
    AUTO.lastCargoCollectAttempt = null;
    AUTO.cargoCollectDoneIds.clear();
    AUTO.cargoSettledNpcIds.clear();
    AUTO.recentCargoKillSites = [];
    AUTO.lootOwnerById.clear();
    clearCurrentTask();
        if (AUTO.modeAttack && AUTO.combatActive) {
          startRaidCombatTask();
        }
      }
      mainTick();
      const parts = [];
      if (hasAnyCollectMode()) parts.push("Raccolta");
      if (AUTO.modeAttack) parts.push("Attacco");
      setStatus(`Arrivato — ${parts.join(" + ") || "attivo"}`);
    } else if (!wasPlayTravel) {
      setStatus(`Arrivato su ${formatMapLabel(arrivedMapId)}`);
    }
  }

  function beginPlayTravel() {
    NAV.playAfterArrival = true;
    ensureNavigationLoop();
    // Only raid-selected Play may start raid-hub travel. Stale pending without a
    // selected gate must not yank the ship to X-1 during normal attack Play.
    if (!AUTO.raidGateId) {
      NAV.pendingRaidGate = null;
      AUTO.pendingRaidGate = null;
    }
    if (AUTO.raidGateId) {
      setStatus(
        `Play travel beginRaidPlayTravel gate→${getRaidGateDisplayName(AUTO.raidGateId) || AUTO.raidGateId}`
      );
      return beginRaidPlayTravel();
    }
    if (!AUTO.workingMapId || getCurrentMapId() === AUTO.workingMapId) {
      NAV.playAfterArrival = false;
      return true;
    }
    const dest = AUTO.workingMapId;
    setStatus(`Play travel beginPlayTravel workingMapId→${formatMapLabel(dest)}`);
    return startMapNavigation(dest, { fromPlay: true });
  }

  function getNpcTypeLabel(typeKey) {
    return NPC_TYPES[typeKey] || typeKey;
  }

  /** Strip game markup `-={{Name}}=-` → `Name` for Discord / status text. */
  function getNpcTypeShortLabel(typeKey) {
    const raw = String(getNpcTypeLabel(typeKey) || typeKey || "").trim();
    const m = raw.match(/=\{\{\s*(.+?)\s*\}\}=/);
    return m ? m[1] : raw;
  }

  function getRaidGateDisplayName(gateRef) {
    const gate = resolveRaidGate(gateRef || AUTO.raidGateId || getGameState()?.raidGateId || "");
    if (!gate) return "";
    return gate.charAt(0).toUpperCase() + gate.slice(1);
  }

  function clearRaidProgressTracking() {
    AUTO.raidCurrentStage = 0;
    AUTO.raidTotalStages = 0;
    AUTO.raidCurrentWave = 0;
  }

  function noteRaidProgressFromInfo(payload) {
    if (!payload || typeof payload !== "object") return;
    const stage = Number(payload.currentStage ?? payload.stage ?? payload.wave);
    const total = Number(payload.totalStages ?? payload.totalWaves ?? payload.maxStage);
    if (Number.isFinite(stage) && stage > 0) AUTO.raidCurrentStage = Math.floor(stage);
    if (Number.isFinite(total) && total > 0) AUTO.raidTotalStages = Math.floor(total);
    if (payload.gateId && !AUTO.raidGateId) {
      AUTO.raidGateId = resolveRaidGate(payload.gateId) || AUTO.raidGateId;
    }
  }

  function noteRaidProgressFromWave(payload) {
    if (!payload || typeof payload !== "object") return;
    const wave = Number(payload.wave ?? payload.currentWave ?? payload.stage ?? payload.currentStage);
    if (!Number.isFinite(wave) || wave <= 0) return;
    AUTO.raidCurrentWave = Math.floor(wave);
    // If raidInfo has not arrived yet, use wave as best-effort stage index.
    if (!AUTO.raidCurrentStage) AUTO.raidCurrentStage = AUTO.raidCurrentWave;
  }

  function noteRaidProgressFromStageClear(payload) {
    if (!payload || typeof payload !== "object") return;
    const stage = Number(payload.stage ?? payload.currentStage ?? payload.wave);
    if (payload.isLastStage && AUTO.raidTotalStages > 0) {
      AUTO.raidCurrentStage = AUTO.raidTotalStages;
      return;
    }
    if (Number.isFinite(stage) && stage > 0) {
      // Cleared stage N → now on / about to enter N+1 until next raidInfo.
      AUTO.raidCurrentStage = Math.floor(stage) + 1;
    }
  }

  /** Best-effort focus / gate label for Discord raid line. */
  function resolveRaidDiscordFocusName() {
    const focusId =
      AUTO.combatFocusId || AUTO.taskTargetId || AUTO.orbitNpcId || getGameState()?.lockedTargetId;
    if (focusId) {
      const typeKey = resolveNpcType(focusId);
      if (typeKey) {
        const short = getNpcTypeShortLabel(typeKey);
        if (short) return short;
      }
      const sprite = getNpcSprite(focusId);
      const rawName = String(sprite?.name || sprite?.displayName || "").trim();
      if (rawName) {
        const m = rawName.match(/=\{\{\s*(.+?)\s*\}\}=/);
        return m ? m[1] : rawName.replace(/^-\s*=\{\{|\}\}=-\s*$/g, "").trim() || rawName;
      }
    }
    // Parse live status: "Raid: attacco Froston (123m)" / "In combattimento: Elite Brakon"
    const statusEl = document.getElementById("rg-story-status");
    const status = statusEl?.textContent || "";
    const fromStatus = status.match(
      /(?:attacco|inseguo|combattimento|attack|combat|orbita|orbit)\s+([^:(]+?)(?:\s*\(|\s*$)/i
    );
    if (fromStatus?.[1]) {
      const cleaned = fromStatus[1].replace(/\s+/g, " ").trim();
      if (cleaned && !/^NPC$/i.test(cleaned)) return cleaned;
    }
    return getRaidGateDisplayName() || "Raid";
  }

  /**
   * Compact raid progress for Discord: "Ondata 10/11 · Froston · 20 kill"
   * Prefers sticky NPC name; falls back to gate name (Void/Rift/…).
   */
  function formatRaidWaveProgressText(options = {}) {
    const inRaid = isInRaidMap();
    const hasProgress =
      AUTO.raidCurrentStage > 0 || AUTO.raidCurrentWave > 0 || AUTO.raidTotalStages > 0;
    if (!inRaid && !hasProgress && !options.force) return "";
    const current = AUTO.raidCurrentStage || AUTO.raidCurrentWave || 0;
    const total = AUTO.raidTotalStages || 0;
    const name = resolveRaidDiscordFocusName();
    const kills = Number.isFinite(options.kills)
      ? Math.max(0, Math.floor(options.kills))
      : Math.max(0, getSessionGains()?.npcKills ?? getNpcKillTotal() ?? 0);
    const progress =
      current > 0 && total > 0
        ? `${current}/${total}`
        : current > 0
          ? String(current)
          : total > 0
            ? `?/${total}`
            : "—";
    return t("discord.raid_progress", { progress, name, kills });
  }

  function getSpriteNpcType(sprite) {
    return sprite?.npcType || sprite?.getNpcType?.() || null;
  }

  function noteBonusCollected(lootId) {
    if (lootId) {
      if (AUTO.countedBonusIds.has(lootId)) return;
      AUTO.countedBonusIds.add(lootId);
      AUTO.pendingBonusIds.delete(lootId);
      if (AUTO.cargoCollectInFlightId === lootId) AUTO.cargoCollectInFlightId = null;
      clearCollectMovement(lootId);
      if (
        AUTO.currentTask === "collect" &&
        (AUTO.taskTargetId === lootId || AUTO.pendingCollectId === lootId || AUTO.chasingBonusId === lootId)
      ) {
        clearCurrentTask();
      }
      if (AUTO.pendingCollectId === lootId) AUTO.pendingCollectId = null;
      if (AUTO.chasingBonusId === lootId) AUTO.chasingBonusId = null;
    } else {
      const now = Date.now();
      if (now - AUTO.lastBonusCountAt < 350) return;
      AUTO.lastBonusCountAt = now;
    }
    AUTO.bonusCollected += 1;
    updateBonusCounter();
  }

  function resolveNpcType(npcId) {
    const K = getGameState();
    const stateType = K?.npcs?.get?.(npcId)?.npc_type;
    if (stateType) return stateType;
    const sprite = getNpcSprite(npcId);
    const spriteType = getSpriteNpcType(sprite);
    if (spriteType) return spriteType;
    return AUTO.trackedNpcTypes.get(npcId) || null;
  }

  function trackNpcType(npcId, typeKey) {
    if (npcId && typeKey) AUTO.trackedNpcTypes.set(npcId, typeKey);
  }

  function isNpcEntity(id) {
    const K = getGameState();
    if (!id) return false;
    if (K?.players?.has?.(id) || K?.players?.get?.(id)) return false;
    if (K?.npcs?.has?.(id) || K?.npcs?.get?.(id)) return true;
    return Boolean(getNpcSprite(id) || AUTO.trackedNpcTypes.has(id));
  }

  function isOurCombatTarget(id) {
    const K = getGameState();
    return (
      AUTO.combatTargetId === id ||
      AUTO.taskTargetId === id ||
      AUTO.combatFocusId === id ||
      K?.lockedTargetId === id ||
      AUTO.watchedNpcIds.has(id)
    );
  }

  /**
   * Best-effort death/drop position for post-kill cargo.
   * NPC sprite/cache may already be gone when kill hooks race — fall back to ship.
   */
  function resolvePostKillCargoPosition(npcId) {
    const cached = getNpcLastPosition(npcId);
    if (cached) return cached;
    const ship = getShipPosition();
    if (ship) return { x: ship.x, y: ship.y };
    return null;
  }

  /**
   * True when an existing pending should yield to a newer confirmed kill.
   * Keep only an active in-progress scoop; otherwise stale pending blocked later arms
   * for the rest of a dense farm session ("forgets" scoop).
   */
  function shouldSupersedePendingCombatCargo(newNpcId) {
    const pending = AUTO.pendingCombatCargo;
    if (!pending) return true;
    if (pending.npcId === newNpcId) return false;
    // Actively scooping visible cargo for the older kill — do not interrupt.
    if (
      AUTO.currentTask === "collect" &&
      AUTO.cargoCollectInFlightId &&
      (getGameState()?.loots?.has?.(AUTO.cargoCollectInFlightId) ||
        Boolean(getLootSprite(AUTO.cargoCollectInFlightId)))
    ) {
      return false;
    }
    return true;
  }

  /**
   * Single writer for post-kill cargo expectation.
   * Idempotent per npcId: never refreshes `at`, never re-arms after settle/collect,
   * never arms when the hold cannot accept cargo.
   * Shared by raid + standard maps.
   *
   * Invariant: after a confirmed own kill with collect cargo enabled, arm once
   * (or settle immediately if hold blocked). Stale pending for another NPC is
   * superseded so later kills still scoop.
   */
  function notePendingCombatCargo(npcId, positionHint = null) {
    // mac45: never arm post-kill cargo while Stop/Pause — wasActivelyAttackingNpc
    // is true for manual locks and lootAdd then cleared attackMode / lock.
    if (!isBotLive()) return false;
    if (!npcId || !AUTO.collectCargo) return false;
    if (!AUTO.combatActive && !wasActivelyAttackingNpc(npcId)) return false;
    if (isCargoSettledForNpc(npcId)) return false;
    // Never arm cargo while this NPC is still fightable — false kill flicker froze combat
    // on "Attendo cargo NPC..." mid-attack.
    if (isNpcStillFightable(npcId) || getNpcSprite(npcId)?.alive) return false;

    // Same kill already pending — keep original clock / position (unless hold blocked)
    if (AUTO.pendingCombatCargo?.npcId === npcId) {
      if (!canCollectCargoNow()) {
        finishCombatCargoCollect(
          AUTO.cargoCollectInFlightId || AUTO.taskTargetId || AUTO.pendingCollectId,
          { count: false }
        );
        markCargoSettledForNpc(npcId);
        return false;
      }
      enterMandatoryPostKillCargoPhase(
        npcId,
        AUTO.pendingCombatCargo.x,
        AUTO.pendingCombatCargo.y,
        AUTO.pendingCombatCargo.at
      );
      return true;
    }

    // Hold full / blocked: settle immediately so late hooks cannot freeze near the drop
    if (!canCollectCargoNow()) {
      markCargoSettledForNpc(npcId);
      const blockedPos =
        (positionHint && positionHint.x != null && positionHint.y != null
          ? { x: positionHint.x, y: positionHint.y }
          : null) || resolvePostKillCargoPosition(npcId);
      if (blockedPos) rememberRecentCargoKillSite(npcId, blockedPos.x, blockedPos.y);
      return false;
    }

    // Another kill's cargo lifecycle is open — supersede unless mid-scoop.
    if (AUTO.pendingCombatCargo) {
      if (!shouldSupersedePendingCombatCargo(npcId)) return false;
      finishCombatCargoCollect(
        AUTO.cargoCollectInFlightId || AUTO.taskTargetId || AUTO.pendingCollectId,
        { count: false }
      );
    }

    const pos =
      (positionHint && positionHint.x != null && positionHint.y != null
        ? { x: positionHint.x, y: positionHint.y }
        : null) || resolvePostKillCargoPosition(npcId);
    if (!pos) return false;
    AUTO.pendingCombatCargo = {
      x: pos.x,
      y: pos.y,
      npcId,
      at: Date.now(),
      failCount: 0,
    };
    rememberRecentCargoKillSite(npcId, pos.x, pos.y);
    // mac41: mandatory phase — portal-drift heal cannot arm until scoop/empty wait.
    enterMandatoryPostKillCargoPhase(npcId, pos.x, pos.y, AUTO.pendingCombatCargo.at);
    // Arm expectation only — do NOT soft-chase the death spot until real
    // (visible, allowed) cargo appears. lootAdd / tryStartPostKillCargoCollect scoop.
    return true;
  }

  function wasActivelyAttackingNpc(npcId) {
    if (!npcId) return false;
    const K = getGameState();
    const input = getInputSystem();
    return (
      (AUTO.currentTask === "combat" && AUTO.taskTargetId === npcId) ||
      AUTO.combatTargetId === npcId ||
      AUTO.combatFocusId === npcId ||
      K?.lockedTargetId === npcId ||
      (input?.attackMode && isOurCombatTarget(npcId))
    );
  }

  function noteNpcKill(npcId, typeKey, options = {}) {
    if (!npcId || !typeKey) return;

    // Snapshot position before cache delete so post-kill cargo can still arm.
    const killPos = getNpcLastPosition(npcId);
    if (options.trackCargo === true) {
      notePendingCombatCargo(npcId, killPos);
    }

    if (AUTO.countedNpcKillIds.has(npcId)) return;

    AUTO.countedNpcKillIds.add(npcId);
    if (AUTO.countedNpcKillIds.size > COUNTED_NPC_KILL_IDS_MAX) {
      const drop = AUTO.countedNpcKillIds.size - COUNTED_NPC_KILL_IDS_MAX;
      let i = 0;
      for (const id of AUTO.countedNpcKillIds) {
        if (i++ >= drop) break;
        AUTO.countedNpcKillIds.delete(id);
      }
    }
    AUTO.combatOrbitEngagedIds.delete(npcId);
    if (AUTO.combatEngageNpcId === npcId) {
      AUTO.combatEngageNpcId = null;
      AUTO.combatEngageStartedAt = 0;
    }
    AUTO.npcKillsByType[typeKey] = (AUTO.npcKillsByType[typeKey] || 0) + 1;
    AUTO.trackedNpcTypes.delete(npcId);
    AUTO.watchedNpcIds.delete(npcId);
    AUTO.npcLastPositions.delete(npcId);
    updateNpcKillCounter();
    // Every counted own kill must arm cargo (entityRemove may skip trackCargo).
    if (AUTO.collectCargo && !isCargoSettledForNpc(npcId)) {
      notePendingCombatCargo(npcId, killPos);
    }
  }

  function trackNpcPosition(npcOrId) {
    const npc =
      typeof npcOrId === "string"
        ? getNpcEntry(npcOrId) || getStickyCombatNpcEntry(npcOrId)
        : npcOrId;
    if (!npc?.id || npc.x == null || npc.y == null) return;
    const prev = AUTO.npcLastPositions.get(npc.id);
    AUTO.npcLastPositions.set(npc.id, {
      x: npc.x,
      y: npc.y,
      prevX: prev?.x ?? npc.x,
      prevY: prev?.y ?? npc.y,
      at: Date.now(),
    });
  }

  function getNpcLastPosition(npcId) {
    const cached = AUTO.npcLastPositions.get(npcId);
    if (cached) return { x: cached.x, y: cached.y };
    const sprite = getEntities()?.npcSprites?.get(npcId);
    if (sprite && sprite.x != null && sprite.y != null) {
      return { x: sprite.x, y: sprite.y };
    }
    const entry = getNpcEntry(npcId);
    if (entry) return { x: entry.x, y: entry.y };
    return null;
  }

  function listCargoNearPoint(x, y, radius) {
    const entities = getEntities();
    if (!entities?.lootSprites) return [];

    const items = [];
    for (const [id, sprite] of entities.lootSprites) {
      if (!isAllowedCombatCargo(id, sprite)) continue;
      const sx = sprite.x;
      const sy = sprite.y;
      if (sx == null || sy == null) continue;
      const distFromPoint = distance(sx, sy, x, y);
      if (distFromPoint > radius) continue;
      items.push({
        id,
        x: sx,
        y: sy,
        distFromPoint,
        type: "CARGO",
        kind: "cargo",
      });
    }
    items.sort((a, b) => a.distFromPoint - b.distFromPoint);
    return items;
  }

  function listNpcsNearPoint(x, y, radius) {
    if (x == null || y == null || !(radius > 0)) return [];
    const out = [];
    for (const npc of listNpcs(0)) {
      if (distance(npc.x, npc.y, x, y) <= radius) out.push(npc);
    }
    out.sort(
      (a, b) => distance(a.x, a.y, x, y) - distance(b.x, b.y, x, y)
    );
    return out;
  }

  /** Raid Gate: every visible non-foreign cargo (sorted nearest to ship). */
  function listRaidVisibleCargo(ship = getShipPosition()) {
    if (!ship || !AUTO.collectCargo || !canCollectCargoNow()) return [];
    if (!isInRaidMap()) return [];
    const entities = getEntities();
    if (!entities?.lootSprites) return [];
    const items = [];
    for (const [id, sprite] of entities.lootSprites) {
      if (!isAllowedCombatCargo(id, sprite)) continue;
      const entry = buildCollectibleEntry(id, sprite, ship);
      if (!entry) continue;
      items.push(entry);
    }
    items.sort((a, b) => a.dist - b.dist);
    return items;
  }

  function findNearestRaidVisibleCargo(ship = getShipPosition()) {
    const items = listRaidVisibleCargo(ship);
    return items[0] || null;
  }

  /**
   * True when ship is in native scoop band OR sitting on/very close to the cargo entity.
   * Contact (on-entity) is independent of approach-point geometry (y-95).
   * `free: true` uses the wider FREE_CONTACT_R band (proven-safe cargo only).
   */
  function isRaidCargoInContactRange(cargo, ship = getShipPosition(), opts = {}) {
    if (!cargo || cargo.x == null || cargo.y == null || !ship) return false;
    const distCargo =
      cargo.dist != null
        ? cargo.dist
        : distance(ship.x, ship.y, cargo.x, cargo.y);
    const contactR = opts.free ? RAID_CARGO_FREE_CONTACT_R : RAID_CARGO_CONTACT_R;
    if (distCargo <= contactR) return true;
    const ap = approachPoint(cargo);
    const distAp = distance(ship.x, ship.y, ap.x, ap.y);
    return distAp <= getCollectTriggerDistance(cargo) + 20;
  }

  /**
   * Nearest allowed raid cargo the ship is already sitting on / in collect range of.
   * Prefers the latched clear target when both are in contact.
   * Free cargos get a slightly wider contact band so we arm sooner while orbiting past.
   */
  function findContactRaidCargo(ship, preferId = null) {
    if (!ship || !AUTO.collectCargo || !canCollectCargoNow()) return null;
    const items = listRaidVisibleCargo(ship);
    let preferred = null;
    let nearest = null;
    for (const cargo of items) {
      if (!cargo?.id) continue;
      if (isCargoCollectAlreadyDone(cargo.id)) continue;
      const free =
        !isRaidShipThreatenedForCargo(ship) &&
        !isRaidCargoApproachUnsafe(cargo, ship);
      if (!isRaidCargoInContactRange(cargo, ship, { free })) continue;
      if (preferId && cargo.id === preferId) preferred = cargo;
      if (!nearest || cargo.dist < nearest.dist) nearest = cargo;
    }
    return preferred || nearest;
  }

  /**
   * HARD RULE: sitting on allowed loot without scooping is a bug.
   * Scoop immediately even during CLEARING/BREAKOUT/APPROACH / pack pressure /
   * NPC-blocked patient latch — ship is already on the entity.
   * Returns true when this tick owns movement/collect.
   *
   * mac32 HARD RULE: while sticky living + attack in raid, NEVER arm/scoop/divert
   * cargo (native cargoTargetId walks to y-95 and collapses combat stand-off).
   * Pending cargo is remembered for after the kill; scoop only when sticky is dead.
   */
  function tryContactRaidCargoScoop(input, ship, state = null, opts = {}) {
    if (!input || !ship || !AUTO.collectCargo || !canCollectCargoNow()) return false;
    if (isRaidHealActive()) return false;
    // Sticky living fight owns kite — no mid-fight cargo arm/walk (opts ignored).
    if (isInRaidMap() && hasLivingStickyCombat()) return false;
    if (opts.keepCombatOrbit) return false;
    if (abortCargoCollectIfHoldFull()) return true;

    const preferId = state?.cargoId || state?.oppScoopId || null;
    const cargo = findContactRaidCargo(ship, preferId);
    if (!cargo) return false;

    // Drop patient blockers — contact overrides latch/cooldown.
    if (state) {
      state.patientLatch = false;
      state.scoopCooldownUntil = 0;
      state.holdUntil = 0;
      state.oppHoldUntil = 0;
      state.oppScoopId = null;
      state.oppScoopUntil = 0;
      state.phase = "SCOOP";
      state.cargoId = cargo.id;
      state.x = cargo.x;
      state.y = cargo.y;
      state.cargoClearSince = Date.now();
    } else {
      AUTO.raidCargoClear = {
        cargoId: cargo.id,
        x: cargo.x,
        y: cargo.y,
        phase: "SCOOP",
        startedAt: Date.now(),
        clearingEnteredAt: 0,
        cargoClearSince: Date.now(),
        scoopCooldownUntil: 0,
        patientLatch: false,
        approachR: null,
        angle: null,
        dir: AUTO.orbitDirection || 1,
        holdUntil: 0,
        oppScoopId: null,
        oppScoopUntil: 0,
      };
    }

    // Prefer native collect task — do not leave cargoTargetId unset under the ship.
    if (AUTO.currentTask === "collect" && AUTO.taskTargetId === cargo.id) {
      armNativeCollect(cargo.id, { keepAttack: true });
      driveCollect(cargo);
      setStatus("status.raid_cargo_sweep", { dist: Math.round(cargo.dist) });
      return true;
    }
    if (!startCollectTask(cargo)) {
      if (!armNativeCollect(cargo.id, { keepAttack: true })) return false;
    }
    driveCollect(cargo);
    setStatus("status.raid_cargo_sweep", { dist: Math.round(cargo.dist) });
    return true;
  }

  /**
   * Free (safe-to-scoop) cargo near the ship while we patient-clear a blocked one.
   * Contact-range cargo is always eligible (even if NPC-guarded — already on it).
   * Farther cargo: never returns NPC-guarded / path-blocked — patient rule stays.
   * listRaidVisibleCargo is nearest-first → always prefer closest free in range.
   */
  function findOpportunisticFreeRaidCargo(ship, excludeId, maxDist = RAID_CARGO_OPP_SCOOP_R) {
    if (!ship || !AUTO.collectCargo || !canCollectCargoNow()) return null;
    const threatened = isRaidShipThreatenedForCargo(ship);
    const items = listRaidVisibleCargo(ship);
    for (const cargo of items) {
      if (!cargo?.id || cargo.id === excludeId) continue;
      if (isCargoCollectAlreadyDone(cargo.id)) continue;
      if (cargo.dist > maxDist) continue;
      // Contact under ship: always scoop (even during breakout pressure).
      // Free cargo gets the wider contact band.
      const freeNear =
        !threatened && !isRaidCargoApproachUnsafe(cargo, ship);
      if (isRaidCargoInContactRange(cargo, ship, { free: freeNear })) return cargo;
      // Pack pressure → do not dive away from breakout for distant free cargo.
      if (threatened) continue;
      if (isRaidCargoApproachUnsafe(cargo, ship)) continue;
      return cargo;
    }
    return null;
  }

  /**
   * During CLEARING/BREAKOUT/APPROACH: immediately divert to scoop FREE cargos we pass.
   * Does NOT abandon the blocked-cargo clear FSM (latch / phase stay on state).
   * No dwell/cooldown/CLEARING-hold for proven-free cargo — CLEARING orbit must yield.
   * Contact-range free cargo scoops even under pack pressure (tryContact handles first).
   */
  function tryDivertRaidClearForFreeCargo(input, ship, state) {
    if (!input || !ship || !state) return false;
    // Sticky living: never divert CLEARING orbit toward free cargo.
    if (hasLivingStickyCombat()) return false;
    if (
      state.phase !== "BREAKOUT" &&
      state.phase !== "CLEARING" &&
      state.phase !== "APPROACH"
    ) {
      return false;
    }

    const now = Date.now();
    let free = null;
    const threatened = isRaidShipThreatenedForCargo(ship);

    // Finish an in-progress free scoop before CLEARING can yank the orbit back.
    if (state.oppScoopId && now < (state.oppScoopUntil || 0)) {
      const spr = getLootSprite(state.oppScoopId);
      const stillThere =
        Boolean(spr) || Boolean(getGameState()?.loots?.has?.(state.oppScoopId));
      if (
        stillThere &&
        !isCargoCollectAlreadyDone(state.oppScoopId) &&
        !isForeignOwnedLoot(state.oppScoopId, spr)
      ) {
        free = buildCollectibleEntry(
          state.oppScoopId,
          spr || { x: state.oppScoopX, y: state.oppScoopY },
          ship
        );
        // Contact under ship: keep scooping even if NPCs still linger.
        if (
          free &&
          !isRaidCargoInContactRange(free, ship, {
            free:
              !threatened && !isRaidCargoApproachUnsafe(free, ship),
          }) &&
          (threatened || isRaidCargoApproachUnsafe(free, ship))
        ) {
          free = null;
        }
      }
      if (!free) {
        state.oppScoopId = null;
        state.oppScoopUntil = 0;
      }
    }

    if (!free) {
      free = findOpportunisticFreeRaidCargo(ship, state.cargoId);
      if (!free) {
        if (threatened) {
          state.oppScoopId = null;
          state.oppScoopUntil = 0;
        }
        return false;
      }
      state.oppScoopId = free.id;
      state.oppScoopX = free.x;
      state.oppScoopY = free.y;
      state.oppScoopUntil = now + RAID_CARGO_OPP_SCOOP_LOCK_MS;
    } else {
      state.oppScoopX = free.x;
      state.oppScoopY = free.y;
    }

    // Free cargo: never wait on CLEARING hold / scoop cooldown / patient latch.
    state.holdUntil = 0;
    state.oppHoldUntil = 0;
    state.scoopCooldownUntil = 0;

    // Contact / native band — start collect immediately (clear FSM → SCOOP).
    if (
      isRaidCargoInContactRange(free, ship, {
        free: !threatened && !isRaidCargoApproachUnsafe(free, ship),
      })
    ) {
      return tryContactRaidCargoScoop(input, ship, state);
    }

    const ap = approachPoint(free);
    const distAp = distance(ship.x, ship.y, ap.x, ap.y);
    const trigger = getCollectTriggerDistance(free);

    // In native scoop band — arm collect while keep-attacking; clear FSM preserved.
    if (distAp <= trigger + 10) {
      if (now - (AUTO.lastCollectSendAt || 0) > 250) {
        armNativeCollect(free.id, { keepAttack: true });
      }
      sustainRaidCargoClearAttack(input);
      setStatus("status.raid_cargo_opp_scoop", { dist: Math.round(free.dist) });
      return true;
    }

    // Immediate divert every tick — CLEARING hold must not keep the orbit waypoint.
    moveViaMinimap(ap.x, ap.y);
    state.oppHoldUntil = 0;
    state.holdUntil = 0;
    sustainRaidCargoClearAttack(input);
    setStatus("status.raid_cargo_opp_scoop", { dist: Math.round(free.dist) });
    return true;
  }

  function clearRaidCargoClearState() {
    AUTO.raidCargoClear = null;
  }

  /**
   * True only while cargo clear/scoop FSM owns movement.
   * collectCargo toggle alone must NOT change combat kite (mac33).
   */
  function isRaidCargoMovementActive() {
    const st = AUTO.raidCargoClear;
    if (!st) return false;
    const phase = st.phase;
    return (
      phase === "CLEARING" ||
      phase === "BREAKOUT" ||
      phase === "APPROACH" ||
      phase === "SCOOP" ||
      Boolean(st.oppScoopId)
    );
  }

  /**
   * True when some cargo FSM / native cargo walk is actually interfering with combat.
   * collectCargo UI toggle alone is NOT enough — zero-loot sticky fight must be
   * identical to toggle OFF (mac33).
   */
  function hasInterferingRaidCargoState() {
    if (AUTO.raidCargoClear) return true;
    if (AUTO.cargoCollectInFlightId) return true;
    if (AUTO.currentTask === "collect") {
      const tid = AUTO.taskTargetId;
      if (tid && isCargoLoot(getLootSprite(tid), tid)) return true;
    }
    const K = getGameState();
    if (K?.cargoTargetId) {
      const ct = K.cargoTargetId;
      if (
        isCargoLoot(getLootSprite(ct), ct) ||
        AUTO.pendingCollectId === ct
      ) {
        return true;
      }
    }
    if (AUTO.pendingCollectId) {
      const p = AUTO.pendingCollectId;
      if (isCargoLoot(getLootSprite(p), p)) return true;
    }
    return false;
  }

  /**
   * Abort cargo clear/scoop / native cargoTargetId so they cannot steal the kite.
   *
   * mac33 ROOT CAUSE FIX: previous mac32 called this every sticky tick whenever
   * collectCargo UI was ON, and it did clearCollectMovement() + lastMinimapTarget=null
   * even with ZERO loot. That null'd input.moveTarget every combat tick → ship
   * stopped orbiting → NPC closed → clamp(dist) locked melee stand-off.
   *
   * Now: only clear cargo-specific state. NEVER touch combat moveTarget /
   * lastMinimapTarget (those are the attack orbit).
   */
  function releaseRaidCargoClearForCombat() {
    const stickyId =
      AUTO.combatFocusId ||
      AUTO.combatTargetId ||
      (AUTO.currentTask === "combat" ? AUTO.taskTargetId : null);
    const lootId =
      AUTO.raidCargoClear?.cargoId ||
      (AUTO.currentTask === "collect" ? AUTO.taskTargetId : null) ||
      AUTO.cargoCollectInFlightId ||
      AUTO.pendingCollectId ||
      null;

    // Clear native cargo walk ONLY — do NOT null input.moveTarget (combat kite).
    const K = getGameState();
    if (K?.cargoTargetId) {
      const ct = K.cargoTargetId;
      if (
        isCargoLoot(getLootSprite(ct), ct) ||
        AUTO.cargoCollectInFlightId === ct ||
        AUTO.pendingCollectId === ct ||
        (lootId && ct === lootId)
      ) {
        K.cargoTargetId = null;
      }
    }
    if (lootId) {
      AUTO.pendingBonusIds.delete(lootId);
      if (AUTO.pendingCollectId === lootId) AUTO.pendingCollectId = null;
      if (AUTO.chasingBonusId === lootId) AUTO.chasingBonusId = null;
      if (AUTO.cargoCollectInFlightId === lootId) AUTO.cargoCollectInFlightId = null;
    }
    // Intentionally NOT: clearCollectMovement() / lastMinimapTarget = null
    clearRaidCargoClearState();

    // Contact scoop / beginRaidCargoScoop may have replaced combat with collect.
    if (AUTO.currentTask === "collect") {
      const tid = AUTO.taskTargetId;
      const spr = tid ? getLootSprite(tid) : null;
      if (!tid || isCargoLoot(spr, tid) || AUTO.cargoCollectInFlightId === tid) {
        clearCurrentTask();
        AUTO.cargoCollectInFlightId = null;
        AUTO.chasingBonusId = null;
        AUTO.pendingCollectId = null;
      }
    }

    // Restore combat task so runCurrentTask drives applyCombatOrbit, not driveCollect.
    if (
      stickyId &&
      (isNpcStillFightable(stickyId) ||
        Boolean(getNpcSprite(stickyId)?.alive) ||
        !isCombatTargetConfirmedGone(stickyId))
    ) {
      AUTO.combatFocusId = stickyId;
      AUTO.combatTargetId = stickyId;
      if (AUTO.currentTask !== "combat" || AUTO.taskTargetId !== stickyId) {
        AUTO.currentTask = "combat";
        AUTO.taskTargetId = stickyId;
      }
    }
  }

  /**
   * Raid Gate: true when the ship is packed / encircled and must break out
   * before any cargo scoop (never sit still collecting inside an NPC swarm).
   */
  function isRaidShipThreatenedForCargo(ship = getShipPosition()) {
    if (!isInRaidMap() || !ship) return false;
    if (isRaidShipEncircled(ship) || isShipEncircledByNpcs(ship)) return true;
    const close = listNpcs(RAID_CARGO_SHIP_DANGER_R);
    if (close.length >= RAID_CARGO_SHIP_DANGER_MIN) return true;
    if (close.length >= 1 && close[0].dist <= 220) return true;
    return false;
  }

  /**
   * Raid Gate: true when scooping would dive through / into NPCs sitting on cargo,
   * cut a blocked path, OR when the ship itself is surrounded (scoop must yield).
   */
  function isRaidCargoApproachUnsafe(cargo, ship = getShipPosition()) {
    if (!isInRaidMap()) return false;
    if (isRaidShipThreatenedForCargo(ship)) return true;
    if (!cargo || cargo.x == null || cargo.y == null) return false;
    if (listNpcsNearPoint(cargo.x, cargo.y, RAID_CARGO_DANGER_R).length > 0) {
      return true;
    }
    if (!ship) return false;
    const mx = (ship.x + cargo.x) * 0.5;
    const my = (ship.y + cargo.y) * 0.5;
    const pathThreats = listNpcsNearPoint(mx, my, RAID_CARGO_PATH_R);
    if (!pathThreats.length) return false;
    // Only block when an NPC sits on the approach chord (between ship and cargo).
    const abx = cargo.x - ship.x;
    const aby = cargo.y - ship.y;
    const abLen = Math.hypot(abx, aby) || 1;
    for (const npc of pathThreats) {
      const t =
        ((npc.x - ship.x) * abx + (npc.y - ship.y) * aby) / (abLen * abLen);
      if (t <= 0.08 || t >= 0.92) continue;
      const px = ship.x + abx * t;
      const py = ship.y + aby * t;
      if (distance(npc.x, npc.y, px, py) <= RAID_CARGO_PATH_R) return true;
    }
    return false;
  }

  /** Return to patient CLEARING after a blocked/failed scoop (cooldown + no immediate re-dive). */
  function returnToRaidCargoClearing(state, { preferBreakout = false, fromBlockedScoop = false } = {}) {
    if (!state) return;
    const now = Date.now();
    if (fromBlockedScoop) {
      state.scoopCooldownUntil = now + RAID_CARGO_SCOOP_COOLDOWN_MS;
      state.patientLatch = true;
    }
    state.cargoClearSince = null;
    state.approachR = null;
    state.holdUntil = 0;
    state.angle = null;
    state.oppScoopId = null;
    state.oppScoopUntil = 0;
    if (preferBreakout) {
      state.phase = "BREAKOUT";
    } else {
      state.phase = "CLEARING";
      state.clearingEnteredAt = now;
    }
  }

  /**
   * True when CLEARING may leave for APPROACH/SCOOP.
   * Contact (already on cargo): immediate.
   * Proven-free cargo (path clear right now): immediate — zero dwell/cooldown.
   * Patient latch delays apply only while cargo is still blocked.
   */
  function canRaidCargoLeaveClearing(state, ship) {
    if (!state || !ship) return false;
    const cargo = { id: state.cargoId, x: state.x, y: state.y };
    // Already sitting on the latched cargo → scoop now (patient latch does not apply).
    if (isRaidCargoInContactRange(cargo, ship)) {
      state.patientLatch = false;
      state.scoopCooldownUntil = 0;
      return true;
    }
    if (isRaidShipThreatenedForCargo(ship)) return false;
    if (isRaidCargoApproachUnsafe(cargo, ship)) return false;

    // Currently free — drop patient gate/cooldown and leave CLEARING immediately.
    state.patientLatch = false;
    state.scoopCooldownUntil = 0;
    return true;
  }

  function armRaidCargoClear(cargo, opts = {}) {
    if (!cargo?.id || cargo.x == null || cargo.y == null) return false;
    const ship = getShipPosition();
    const preferBreakout = isRaidShipThreatenedForCargo(ship);
    const fromBlockedScoop = Boolean(opts.fromBlockedScoop);
    const approachUnsafe = isRaidCargoApproachUnsafe(cargo, ship);
    const onCargo = Boolean(ship && isRaidCargoInContactRange(cargo, ship));
    const existing = AUTO.raidCargoClear;
    const now = Date.now();
    // Already sitting on the cargo — never patient-orbit away; contact scoop owns next tick.
    if (onCargo) {
      if (existing?.cargoId === cargo.id) {
        existing.x = cargo.x;
        existing.y = cargo.y;
        existing.phase = "SCOOP";
        existing.patientLatch = false;
        existing.scoopCooldownUntil = 0;
        existing.holdUntil = 0;
      } else {
        AUTO.raidCargoClear = {
          cargoId: cargo.id,
          x: cargo.x,
          y: cargo.y,
          phase: "SCOOP",
          startedAt: now,
          clearingEnteredAt: 0,
          cargoClearSince: now,
          scoopCooldownUntil: 0,
          patientLatch: false,
          approachR: null,
          angle: null,
          dir: AUTO.orbitDirection || (Math.random() < 0.5 ? 1 : -1),
          holdUntil: 0,
          oppScoopId: null,
          oppScoopUntil: 0,
        };
      }
      return true;
    }
    if (existing?.cargoId === cargo.id) {
      existing.x = cargo.x;
      existing.y = cargo.y;
      if (
        existing.phase === "SCOOP" ||
        existing.phase === "APPROACH" ||
        !existing.phase
      ) {
        // Failed dive / hit near cargo → patient CLEARING, never instant re-scoop.
        returnToRaidCargoClearing(existing, {
          preferBreakout,
          fromBlockedScoop: fromBlockedScoop || true,
        });
      } else if (preferBreakout && existing.phase === "CLEARING") {
        // Surrounded mid-clear → escape first, do not keep tight orbit in the pack.
        existing.phase = "BREAKOUT";
        existing.holdUntil = 0;
        existing.cargoClearSince = null;
        existing.patientLatch = true;
      } else if (fromBlockedScoop && existing.phase === "CLEARING") {
        existing.scoopCooldownUntil = now + RAID_CARGO_SCOOP_COOLDOWN_MS;
        existing.cargoClearSince = null;
        existing.clearingEnteredAt = now;
        existing.holdUntil = 0;
        existing.patientLatch = true;
      }
      clearCollectMovement(cargo.id);
      return true;
    }
    // Proven-free cargo: arm SCOOP directly — no CLEARING orbit / patient latch.
    if (!preferBreakout && !approachUnsafe && !fromBlockedScoop) {
      AUTO.raidCargoClear = {
        cargoId: cargo.id,
        x: cargo.x,
        y: cargo.y,
        phase: "SCOOP",
        startedAt: now,
        clearingEnteredAt: 0,
        cargoClearSince: now,
        scoopCooldownUntil: 0,
        patientLatch: false,
        approachR: null,
        angle: null,
        dir: AUTO.orbitDirection || (Math.random() < 0.5 ? 1 : -1),
        holdUntil: 0,
        oppScoopId: null,
        oppScoopUntil: 0,
      };
      return true;
    }
    AUTO.raidCargoClear = {
      cargoId: cargo.id,
      x: cargo.x,
      y: cargo.y,
      phase: preferBreakout ? "BREAKOUT" : "CLEARING",
      startedAt: now,
      clearingEnteredAt: preferBreakout ? 0 : now,
      cargoClearSince: null,
      scoopCooldownUntil: fromBlockedScoop
        ? now + RAID_CARGO_SCOOP_COOLDOWN_MS
        : 0,
      // Patient latch only when blocked and NOT already on the cargo entity.
      patientLatch: Boolean(fromBlockedScoop || preferBreakout || approachUnsafe),
      approachR: null,
      angle: null,
      dir: AUTO.orbitDirection || (Math.random() < 0.5 ? 1 : -1),
      holdUntil: 0,
      oppScoopId: null,
      oppScoopUntil: 0,
    };
    clearCollectMovement(cargo.id);
    if (AUTO.currentTask === "collect" && AUTO.taskTargetId === cargo.id) {
      clearCurrentTask();
    }
    // Combat reposition for cargo — keep laser armed (not coffee/admin/map flee).
    return true;
  }

  /** True when ship→waypoint chord cuts near the NPC pack centroid. */
  function raidCargoClearChordCutsPack(ship, tx, ty, swarm) {
    if (!ship || !swarm || tx == null || ty == null) return false;
    const abx = tx - ship.x;
    const aby = ty - ship.y;
    const abLen = Math.hypot(abx, aby);
    if (abLen < 40) return false;
    const t = clamp(
      ((swarm.x - ship.x) * abx + (swarm.y - ship.y) * aby) / (abLen * abLen),
      0.08,
      0.92
    );
    const px = ship.x + abx * t;
    const py = ship.y + aby * t;
    return distance(swarm.x, swarm.y, px, py) <= RAID_CARGO_CLEAR_CHORD_R;
  }

  /**
   * Keep shooting sticky / nearest valid raid NPC while cargo-clearing.
   * Lock+fire only — never steals combatFocus (would starve cargo golden rule).
   */
  function sustainRaidCargoClearAttack(input) {
    if (!input || !AUTO.combatActive || isRaidHealActive()) return false;
    const preferredId =
      AUTO.combatFocusId ||
      AUTO.combatTargetId ||
      getGameState()?.lockedTargetId ||
      null;
    const npc = resolveRaidCombatTarget(preferredId);
    if (!npc || !isNpcAllowedForCombat(npc.id)) return false;
    const canFire = input.canFire?.(npc.id);
    if (canFire === "ok") {
      engageNpc(npc.id);
      sustainRaidAttack(input);
      return true;
    }
    // Soft lock while wide-orbiting out of band — resume shots when in range.
    if (getGameState()?.lockedTargetId !== npc.id) {
      setLockedTarget(npc.id);
      input.notifyPlayerLocked?.(npc.id);
    }
    input.attackMode = true;
    input.pendingAttackOnLock = npc.id;
    input.syncAttackSession?.();
    return true;
  }

  /** Escape vector: away from nearby NPC centroid into open space (raid cargo). */
  function getRaidCargoBreakoutPoint(ship) {
    if (!ship) return null;
    const close = listNpcs(RAID_CARGO_SHIP_DANGER_R * 1.35);
    const swarm = getRaidSwarmCentroid(close.length ? close : listNpcs(0));
    let away = Math.atan2(ship.y - swarm.y, ship.x - swarm.x);
    if (!Number.isFinite(away)) {
      const center = getRaidCenter();
      away = Math.atan2(ship.y - center.y, ship.x - center.x) || 0;
    }
    // Prefer the largest angular gap (open sector) when encircled.
    if (close.length >= RAID_ENCIRCLE_MIN_NPCS) {
      const angles = close
        .map((n) => Math.atan2(n.y - ship.y, n.x - ship.x))
        .sort((a, b) => a - b);
      let maxGap = 0;
      let gapMid = away;
      for (let i = 0; i < angles.length; i++) {
        const a = angles[i];
        const b =
          angles[(i + 1) % angles.length] +
          (i + 1 === angles.length ? Math.PI * 2 : 0);
        const gap = b - a;
        if (gap > maxGap) {
          maxGap = gap;
          gapMid = a + gap * 0.5;
        }
      }
      if (maxGap >= 0.55) away = gapMid;
    }
    const candidates = [];
    for (const bias of [0, 0.35, -0.35, 0.7, -0.7, 1.15, -1.15, 1.6, -1.6]) {
      const ang = away + bias;
      const step = RAID_CARGO_BREAKOUT_STEP * (0.9 + Math.abs(bias) * 0.05);
      const raw = {
        x: ship.x + Math.cos(ang) * step,
        y: ship.y + Math.sin(ang) * step,
      };
      const pt = clampToRaidSupportZone(raw.x, raw.y);
      const threat = getNearestNpcDistance(pt.x, pt.y);
      const towardSwarm =
        (pt.x - ship.x) * (swarm.x - ship.x) + (pt.y - ship.y) * (swarm.y - ship.y);
      const midDist = distance(
        (ship.x + pt.x) * 0.5,
        (ship.y + pt.y) * 0.5,
        swarm.x,
        swarm.y
      );
      const chordPenalty = raidCargoClearChordCutsPack(ship, pt.x, pt.y, swarm)
        ? 480
        : 0;
      const score =
        threat +
        midDist * 0.45 -
        (towardSwarm > 0 ? 420 : 0) -
        chordPenalty +
        Math.abs(bias) * 6;
      candidates.push({ x: pt.x, y: pt.y, score });
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0] || clampToRaidSupportZone(
      ship.x + Math.cos(away) * RAID_CARGO_BREAKOUT_STEP,
      ship.y + Math.sin(away) * RAID_CARGO_BREAKOUT_STEP
    );
  }

  /**
   * BREAKOUT → CLEARING (patient wide orbit + fire) → APPROACH (arc) → SCOOP.
   * Scoop is forbidden until sustained cargo-clear latch + min dwell + cooldown.
   * Never timeout-force a dive through the pack. Returns true while owning movement;
   * false only when latch satisfied and ready for native SCOOP.
   */
  function driveRaidCargoClearMovement(input, ship, state) {
    if (!input || !ship || !state) return false;
    // Sticky living owns combat kite — never CLEARING/BREAKOUT/APPROACH divert.
    if (hasLivingStickyCombat()) {
      releaseRaidCargoClearForCombat();
      return false;
    }
    const spr = getLootSprite(state.cargoId);
    if (spr && spr.x != null && spr.y != null) {
      state.x = spr.x;
      state.y = spr.y;
    }
    const stillThere =
      Boolean(spr) || Boolean(getGameState()?.loots?.has?.(state.cargoId));
    if (
      !stillThere ||
      isCargoCollectAlreadyDone(state.cargoId) ||
      isForeignOwnedLoot(state.cargoId, spr)
    ) {
      clearRaidCargoClearState();
      return false;
    }

    // Soft-extend post-kill wait while we flank (do not abandon mid-clear).
    if (AUTO.pendingCombatCargo) {
      AUTO.pendingCombatCargo.at = Date.now();
    }

    // HARD RULE: sitting on allowed loot → scoop now (before breakout/clear orbit).
    // CLEARING used to own the tick without ever calling driveCollect/startCollectTask.
    if (tryContactRaidCargoScoop(input, ship, state)) return true;

    const now = Date.now();
    const shipThreatened = isRaidShipThreatenedForCargo(ship);
    const cargoThreats = listNpcsNearPoint(state.x, state.y, RAID_CARGO_DANGER_R);

    // Sustained clear latch — single-tick gaps do not unlock scoop.
    if (cargoThreats.length) {
      state.cargoClearSince = null;
    } else if (!state.cargoClearSince) {
      state.cargoClearSince = now;
    }

    if (shipThreatened && state.phase !== "BREAKOUT") {
      returnToRaidCargoClearing(state, {
        preferBreakout: true,
        fromBlockedScoop: state.phase === "SCOOP" || state.phase === "APPROACH",
      });
      clearCollectMovement(state.cargoId);
    }

    // Opportunistic: scoop FREE cargos we pass while patient-clearing a blocked one.
    // Does not abandon CLEARING latch / blocked target — divert then resume.
    if (tryDivertRaidClearForFreeCargo(input, ship, state)) return true;

    // BREAKOUT: step outside pack / open gap before any cargo-centered orbit.
    if (state.phase === "BREAKOUT" || shipThreatened) {
      state.phase = "BREAKOUT";
      const encircledNow = isRaidShipEncircled(ship) || shipThreatened;
      // While packed: never hold a short waypoint — recompute escape every tick.
      if (
        !encircledNow &&
        state.holdUntil &&
        now < state.holdUntil &&
        AUTO.lastMinimapTarget &&
        shouldKeepExistingMoveTarget(
          { moveTarget: AUTO.lastMinimapTarget },
          AUTO.lastMinimapTarget.x,
          AUTO.lastMinimapTarget.y
        )
      ) {
        sustainRaidCargoClearAttack(input);
        setStatus("status.raid_cargo_breakout", {
          dist: Math.round(distance(ship.x, ship.y, state.x, state.y)),
        });
        return true;
      }
      const pt = getRaidCargoBreakoutPoint(ship);
      if (pt) {
        moveViaMinimap(pt.x, pt.y);
        // Short hold only after space opens; packed = 0 so next tick can pivot.
        state.holdUntil = encircledNow ? 0 : now + RAID_CARGO_CLEAR_HOLD_MS;
      }
      // Cleared enough space → CLEARING only (never jump straight to SCOOP).
      if (!shipThreatened && !isRaidShipEncircled(ship)) {
        state.phase = "CLEARING";
        state.clearingEnteredAt = now;
        state.angle = null;
        state.approachR = null;
      }
      sustainRaidCargoClearAttack(input);
      setStatus("status.raid_cargo_breakout", {
        dist: Math.round(distance(ship.x, ship.y, state.x, state.y)),
      });
      return true;
    }

    // APPROACH: evasive arc spiral toward cargo — abort to CLEARING if danger returns.
    if (state.phase === "APPROACH") {
      const cargoProbe = { id: state.cargoId, x: state.x, y: state.y };
      if (
        cargoThreats.length ||
        isRaidShipThreatenedForCargo(ship) ||
        isRaidCargoApproachUnsafe(cargoProbe, ship)
      ) {
        returnToRaidCargoClearing(state, { fromBlockedScoop: true });
        // Fall through to CLEARING same tick.
      } else {
        const distCargo = distance(ship.x, ship.y, state.x, state.y);
        if (distCargo <= RAID_CARGO_APPROACH_SCOOP_R) {
          state.phase = "SCOOP";
          return false;
        }
        let angle = state.angle;
        if (angle == null || !Number.isFinite(angle)) {
          angle = Math.atan2(ship.y - state.y, ship.x - state.x);
        }
        let r = state.approachR;
        if (r == null || !Number.isFinite(r)) {
          r = Math.max(distCargo, RAID_CARGO_APPROACH_SCOOP_R + 80);
        }
        if (
          state.holdUntil &&
          now < state.holdUntil &&
          AUTO.lastMinimapTarget &&
          shouldKeepExistingMoveTarget(
            { moveTarget: AUTO.lastMinimapTarget },
            AUTO.lastMinimapTarget.x,
            AUTO.lastMinimapTarget.y
          )
        ) {
          sustainRaidCargoClearAttack(input);
          setStatus("status.raid_cargo_approach", {
            dist: Math.round(distCargo),
          });
          return true;
        }
        const dir = state.dir || 1;
        angle += dir * RAID_CARGO_CLEAR_ARC;
        r = Math.max(r - RAID_CARGO_APPROACH_SPIRAL, RAID_CARGO_APPROACH_SCOOP_R * 0.85);
        const swarm = getRaidSwarmCentroid(listNpcs(0));
        let pt = null;
        let tryAng = angle;
        for (let tries = 0; tries < 8; tries++) {
          const cand = clampToRaidSupportZone(
            state.x + Math.cos(tryAng) * r,
            state.y + Math.sin(tryAng) * r
          );
          if (!raidCargoClearChordCutsPack(ship, cand.x, cand.y, swarm)) {
            pt = cand;
            angle = tryAng;
            break;
          }
          tryAng += dir * RAID_CARGO_CLEAR_ARC;
        }
        if (!pt) {
          pt = clampToRaidSupportZone(
            state.x + Math.cos(angle) * r,
            state.y + Math.sin(angle) * r
          );
        }
        state.angle = angle;
        state.approachR = r;
        moveViaMinimap(pt.x, pt.y);
        state.holdUntil = now + RAID_CARGO_CLEAR_HOLD_MS;
        sustainRaidCargoClearAttack(input);
        setStatus("status.raid_cargo_approach", {
          dist: Math.round(distCargo),
        });
        return true;
      }
    }

    // CLEARING: wide orbit + keep shooting. Scoop forbidden until latch.
    state.phase = "CLEARING";
    if (!state.clearingEnteredAt) state.clearingEnteredAt = now;

    // mac33: if ship is already inside NPC stand-off, BREAKOUT before clear arc.
    const clearFloor = getCargoCombatSafeStandOff();
    const nearNpc = listNpcs(clearFloor);
    if (nearNpc.length && nearNpc[0].dist < clearFloor) {
      returnToRaidCargoClearing(state, { preferBreakout: true });
      const ptBreak = getRaidCargoBreakoutPoint(ship);
      if (ptBreak) {
        const pushedBreak = pushPointOutsideLivingNpcs(ptBreak, clearFloor);
        moveViaMinimap(pushedBreak.x, pushedBreak.y);
      }
      sustainRaidCargoClearAttack(input);
      setStatus("status.raid_cargo_breakout", {
        dist: Math.round(distance(ship.x, ship.y, state.x, state.y)),
      });
      return true;
    }

    if (canRaidCargoLeaveClearing(state, ship)) {
      // Free cargo: dive to SCOOP immediately (skip APPROACH spiral).
      // Patient-blocked recoveries that just became free also scoop now.
      state.phase = "SCOOP";
      state.patientLatch = false;
      state.scoopCooldownUntil = 0;
      state.holdUntil = 0;
      state.approachR = null;
      return false;
    }

    const swarm = getRaidSwarmCentroid(
      cargoThreats.length ? cargoThreats : listNpcs(0)
    );
    // Orbit center well outside the pack — never through centroid toward cargo.
    const awayCargo = Math.atan2(swarm.y - state.y, swarm.x - state.x);
    const cx =
      swarm.x +
      (Number.isFinite(awayCargo) ? Math.cos(awayCargo) * 320 : 0);
    const cy =
      swarm.y +
      (Number.isFinite(awayCargo) ? Math.sin(awayCargo) * 320 : 0);

    let angle = state.angle;
    if (angle == null || !Number.isFinite(angle)) {
      angle = Math.atan2(ship.y - cy, ship.x - cx);
    }
    const dir = state.dir || 1;
    // Hold waypoint: less chaotic retarget spam (still keep laser up).
    // mac33: abort hold if the held point (or ship) is inside NPC stand-off.
    if (
      state.holdUntil &&
      now < state.holdUntil &&
      AUTO.lastMinimapTarget &&
      shouldKeepExistingMoveTarget(
        { moveTarget: AUTO.lastMinimapTarget },
        AUTO.lastMinimapTarget.x,
        AUTO.lastMinimapTarget.y
      )
    ) {
      const holdPt = AUTO.lastMinimapTarget;
      const holdThreat = getNearestNpcDistance(holdPt.x, holdPt.y, clearFloor + 40);
      if (!(holdThreat > 0 && holdThreat < clearFloor) && !(nearNpc.length && nearNpc[0].dist < clearFloor)) {
        sustainRaidCargoClearAttack(input);
        setStatus("status.raid_cargo_clear", {
          dist: Math.round(distance(ship.x, ship.y, state.x, state.y)),
        });
        return true;
      }
      state.holdUntil = 0;
    }
    angle += dir * RAID_CARGO_CLEAR_ARC;

    // Prefer the far arc — never cut toward cargo through the pack.
    const cargoAng = Math.atan2(state.y - cy, state.x - cx);
    let diff = Math.atan2(Math.sin(angle - cargoAng), Math.cos(angle - cargoAng));
    if (Math.abs(diff) < 1.55) {
      angle = cargoAng + Math.PI + dir * 0.85;
    }

    let pt = null;
    for (let tries = 0; tries < 8; tries++) {
      let tx = cx + Math.cos(angle) * RAID_CARGO_CLEAR_ORBIT_R;
      let ty = cy + Math.sin(angle) * RAID_CARGO_CLEAR_ORBIT_R;
      if (Number.isFinite(awayCargo)) {
        tx += Math.cos(awayCargo) * 240;
        ty += Math.sin(awayCargo) * 240;
      }
      const cand = pushPointOutsideLivingNpcs(
        clampToRaidSupportZone(tx, ty),
        clearFloor
      );
      if (
        !raidCargoClearChordCutsPack(ship, cand.x, cand.y, swarm) &&
        getNearestNpcDistance(cand.x, cand.y, clearFloor + 40) >= clearFloor * 0.92
      ) {
        pt = cand;
        break;
      }
      angle += dir * RAID_CARGO_CLEAR_ARC;
    }
    if (!pt) {
      const tx =
        cx +
        Math.cos(angle) * RAID_CARGO_CLEAR_ORBIT_R +
        (Number.isFinite(awayCargo) ? Math.cos(awayCargo) * 240 : 0);
      const ty =
        cy +
        Math.sin(angle) * RAID_CARGO_CLEAR_ORBIT_R +
        (Number.isFinite(awayCargo) ? Math.sin(awayCargo) * 240 : 0);
      pt = pushPointOutsideLivingNpcs(clampToRaidSupportZone(tx, ty), clearFloor);
    }
    state.angle = angle;
    moveViaMinimap(pt.x, pt.y);
    state.holdUntil = now + RAID_CARGO_CLEAR_HOLD_MS;
    sustainRaidCargoClearAttack(input);
    setStatus("status.raid_cargo_clear", {
      dist: Math.round(distance(ship.x, ship.y, state.x, state.y)),
    });
    return true;
  }

  function beginRaidCargoScoop(cargo, ship = getShipPosition()) {
    if (!cargo?.id) return false;
    if (!canCollectCargoNow()) return false;
    // Sticky living fight owns kite — remember pending only; scoop after kill.
    if (hasLivingStickyCombat()) {
      releaseRaidCargoClearForCombat();
      return false;
    }
    const inputEarly = getInputSystem();
    // Already on the cargo entity → scoop immediately (do not re-enter patient CLEARING).
    if (ship && isRaidCargoInContactRange(cargo, ship)) {
      if (inputEarly && tryContactRaidCargoScoop(inputEarly, ship, AUTO.raidCargoClear)) {
        return true;
      }
    }
    // Never arm native scoop while surrounded / latch not ready — clear owns the tick.
    // Exception: contact range already handled above.
    if (isRaidShipThreatenedForCargo(ship) || isRaidCargoApproachUnsafe(cargo, ship)) {
      armRaidCargoClear(cargo, { fromBlockedScoop: true });
      const input = getInputSystem();
      if (ship && input && AUTO.raidCargoClear) {
        return driveRaidCargoClearMovement(input, ship, AUTO.raidCargoClear);
      }
      return Boolean(AUTO.raidCargoClear);
    }
    // Free cargo: zero cooldown / patient gate — scoop now.
    const st = AUTO.raidCargoClear;
    if (st?.cargoId === cargo.id) {
      st.patientLatch = false;
      st.scoopCooldownUntil = 0;
      st.holdUntil = 0;
      if (
        st.phase === "CLEARING" ||
        st.phase === "BREAKOUT" ||
        st.phase === "APPROACH"
      ) {
        const inputClear = getInputSystem();
        if (ship && inputClear) {
          // Release clear FSM this tick — fall through to native scoop.
          st.phase = "SCOOP";
        }
      }
    }
    clearLockedTarget();
    const input = getInputSystem();
    if (input) {
      input.attackMode = false;
      input.pendingAttackOnLock = null;
    }
    if (AUTO.currentTask === "combat") {
      AUTO.combatFocusId = null;
      AUTO.combatTargetId = null;
      clearCurrentTask();
    }
    if (!startCollectTask(cargo)) {
      noteCargoCollectStartFailure();
      armRaidCargoClear(cargo, { fromBlockedScoop: true });
      return false;
    }
    if (AUTO.raidCargoClear?.cargoId === cargo.id) {
      AUTO.raidCargoClear.phase = "SCOOP";
      AUTO.raidCargoClear.x = cargo.x;
      AUTO.raidCargoClear.y = cargo.y;
    } else {
      AUTO.raidCargoClear = {
        cargoId: cargo.id,
        x: cargo.x,
        y: cargo.y,
        phase: "SCOOP",
        startedAt: Date.now(),
        clearingEnteredAt: 0,
        cargoClearSince: Date.now(),
        scoopCooldownUntil: 0,
        approachR: null,
        angle: null,
        dir: AUTO.orbitDirection || 1,
        holdUntil: 0,
      };
    }
    const dist =
      cargo.dist != null
        ? cargo.dist
        : ship
          ? distance(ship.x, ship.y, cargo.x, cargo.y)
          : 0;
    setStatus("status.raid_cargo_sweep", { dist: Math.round(dist) });
    return true;
  }

  /**
   * Raid Gate cargo sweep: BREAKOUT → CLEARING → APPROACH → SCOOP for every visible cargo
   * before resuming normal raid combat search. Never interrupts a living sticky fight.
   * Runs between waves / idle / stage-clear — not only mid-combat after a kill.
   */
  function driveRaidCargoSweepTick(input, ship) {
    if (!isInRaidMap() || !AUTO.collectCargo) {
      clearRaidCargoClearState();
      return false;
    }
    if (!input || !ship) return false;
    if (isRaidHealActive()) return false;
    if (abortCargoCollectIfHoldFull()) return false;
    if (!canCollectCargoNow()) {
      clearRaidCargoClearState();
      return false;
    }

    // Product rule: living sticky fight owns combat kite — zero cargo divert/arm.
    if (hasLivingStickyCombat()) {
      releaseRaidCargoClearForCombat();
      return false;
    }

    // Contact scoop before any CLEARING orbit / patient latch — never sit on loot.
    if (tryContactRaidCargoScoop(input, ship, AUTO.raidCargoClear)) return true;

    let state = AUTO.raidCargoClear;
    if (state) {
      const spr = getLootSprite(state.cargoId);
      const stillThere =
        Boolean(spr) || Boolean(getGameState()?.loots?.has?.(state.cargoId));
      if (
        !stillThere ||
        isCargoCollectAlreadyDone(state.cargoId) ||
        isForeignOwnedLoot(state.cargoId, spr)
      ) {
        clearRaidCargoClearState();
        state = null;
      } else if (
        state.phase === "BREAKOUT" ||
        state.phase === "CLEARING" ||
        state.phase === "APPROACH"
      ) {
        if (driveRaidCargoClearMovement(input, ship, state)) return true;
        // Transitioned to SCOOP (latch satisfied + arc approach complete).
        const cargo = buildCollectibleEntry(
          state.cargoId,
          spr || { x: state.x, y: state.y },
          ship
        );
        if (cargo && beginRaidCargoScoop(cargo, ship)) return true;
        if (AUTO.raidCargoClear) {
          returnToRaidCargoClearing(AUTO.raidCargoClear, {
            fromBlockedScoop: true,
          });
          return driveRaidCargoClearMovement(
            input,
            ship,
            AUTO.raidCargoClear
          );
        }
        return false;
      } else if (state.phase === "SCOOP") {
        // Surrounded while "collecting" far cargo → abort scoop, break out.
        // Contact (already on cargo): keep scooping — do not yank back to BREAKOUT.
        const scoopCargo = buildCollectibleEntry(
          state.cargoId,
          spr || { x: state.x, y: state.y },
          ship
        );
        const onCargo =
          scoopCargo && isRaidCargoInContactRange(scoopCargo, ship);
        if (
          !onCargo &&
          (isRaidShipThreatenedForCargo(ship) ||
            isRaidCargoApproachUnsafe(
              { id: state.cargoId, x: state.x, y: state.y },
              ship
            ))
        ) {
          if (scoopCargo) {
            armRaidCargoClear(scoopCargo, { fromBlockedScoop: true });
            return driveRaidCargoClearMovement(input, ship, AUTO.raidCargoClear);
          }
        }
        if (onCargo && tryContactRaidCargoScoop(input, ship, state)) return true;
        if (AUTO.currentTask === "collect" && AUTO.taskTargetId === state.cargoId) {
          return false; // driveCollect owns the tick
        }
        const cargo = scoopCargo || buildCollectibleEntry(
          state.cargoId,
          spr || { x: state.x, y: state.y },
          ship
        );
        if (cargo && beginRaidCargoScoop(cargo, ship)) return true;
        clearRaidCargoClearState();
      }
    }

    // Active non-cargo task (or combat without living sticky already filtered): yield.
    if (AUTO.currentTask === "collect") {
      const tid = AUTO.taskTargetId;
      if (tid && isCargoLoot(getLootSprite(tid), tid)) {
        // Collecting cargo but surrounded → reclaim tick for breakout.
        if (isRaidShipThreatenedForCargo(ship)) {
          const item = getCollectibleById(tid);
          if (item) {
            armRaidCargoClear(item, { fromBlockedScoop: true });
            return driveRaidCargoClearMovement(input, ship, AUTO.raidCargoClear);
          }
        }
        return false;
      }
    }
    if (AUTO.currentTask && AUTO.currentTask !== "collect") return false;

    // Prefer pending kill drop, else nearest remaining visible cargo.
    let cargo = null;
    if (AUTO.pendingCombatCargo) {
      cargo = findCargoForPendingKill(AUTO.pendingCombatCargo);
    }
    if (!cargo) cargo = findNearestRaidVisibleCargo(ship);
    if (!cargo) {
      clearRaidCargoClearState();
      return false;
    }

    if (isRaidCargoApproachUnsafe(cargo, ship) || isRaidShipThreatenedForCargo(ship)) {
      // Already on it → scoop anyway (do not patient-orbit away from underfoot loot).
      if (isRaidCargoInContactRange(cargo, ship)) {
        return tryContactRaidCargoScoop(input, ship, AUTO.raidCargoClear);
      }
      armRaidCargoClear(cargo);
      return driveRaidCargoClearMovement(input, ship, AUTO.raidCargoClear);
    }

    // Safe path with no active FSM — still prefer a short clear dwell if we just
    // aborted a scoop (cooldown), otherwise scoop directly.
    if (
      AUTO.raidCargoClear?.scoopCooldownUntil &&
      Date.now() < AUTO.raidCargoClear.scoopCooldownUntil &&
      !isRaidCargoInContactRange(cargo, ship)
    ) {
      armRaidCargoClear(cargo);
      return driveRaidCargoClearMovement(input, ship, AUTO.raidCargoClear);
    }

    return beginRaidCargoScoop(cargo, ship);
  }

  function findCargoForPendingKill(pending) {
    if (!pending) return null;
    const nearDeath = listCargoNearPoint(pending.x, pending.y, POST_KILL_CARGO_RADIUS);
    if (!nearDeath.length) return null;
    // Prefer owner_id === me, then unowned; never foreign (already filtered)
    nearDeath.sort((a, b) => {
      const ownDiff = cargoOwnKillScore(a.id) - cargoOwnKillScore(b.id);
      if (ownDiff !== 0) return ownDiff;
      return a.distFromPoint - b.distFromPoint;
    });
    return nearDeath[0];
  }

  function tryStartPostKillCargoCollect() {
    if (!isBotLive()) return false;
    if (!canCollectCargoNow() || !AUTO.pendingCombatCargo) return false;
    if (abortCargoCollectIfHoldFull()) return false;
    // Bonus/booty collect must yield to own-kill cargo (nearest-bonus race).
    if (AUTO.currentTask === "collect") {
      const tid = AUTO.taskTargetId;
      const spr = tid ? getLootSprite(tid) : null;
      const collectingCargo =
        Boolean(tid && AUTO.cargoCollectInFlightId === tid) ||
        Boolean(tid && isCargoLoot(spr, tid));
      if (collectingCargo) return false;
      clearCollectMovement(tid);
      clearCurrentTask();
    }
    if (AUTO.cargoCollectInFlightId) {
      const inFlight = AUTO.cargoCollectInFlightId;
      const stillThere =
        getGameState()?.loots?.has?.(inFlight) || Boolean(getLootSprite(inFlight));
      if (stillThere) {
        // Resume collect if task was cleared while native path was still armed
        const spr = getLootSprite(inFlight);
        const loot = getGameState()?.loots?.get?.(inFlight);
        if (spr || loot) {
          const resumed = startCollectTask({
            id: inFlight,
            x: spr?.x ?? loot?.x ?? AUTO.pendingCombatCargo.x,
            y: spr?.y ?? loot?.y ?? AUTO.pendingCombatCargo.y,
            kind: "cargo",
            type: "CARGO",
          });
          if (!resumed) noteCargoCollectStartFailure();
          return resumed;
        }
        return false;
      }
      AUTO.cargoCollectInFlightId = null;
    }

    const pending = AUTO.pendingCombatCargo;
    const cargo = findCargoForPendingKill(pending);
    // Do NOT finish pending here on VISIBLE_GRACE — that raced soft approach /
    // WAIT_MS and abandoned standard-map scoops while still en route to the drop.
    // Abandonment is owned by drivePendingCombatCargoTick (WAIT_MS / at-site wait).
    if (!cargo || isCargoCollectAlreadyDone(cargo.id)) return false;

    clearLockedTarget();
    const input = getInputSystem();
    if (input) {
      input.attackMode = false;
      input.pendingAttackOnLock = null;
    }
    // Raid Gate: NPCs on the drop → kite clear before arming native scoop.
    if (isInRaidMap() && isRaidCargoApproachUnsafe(cargo)) {
      armRaidCargoClear(cargo);
      const shipNow = getShipPosition();
      if (shipNow && input && AUTO.raidCargoClear) {
        return driveRaidCargoClearMovement(input, shipNow, AUTO.raidCargoClear);
      }
      return Boolean(AUTO.raidCargoClear);
    }
    if (!startCollectTask(cargo)) {
      noteCargoCollectStartFailure();
      return false;
    }
    setStatus("status.cargo_collect", {
      npc: getNpcTypeLabel(resolveNpcType(pending.npcId) || "") || "NPC",
    });
    return true;
  }

  /**
   * Late lootAdd after pending was cleared (APPEAR_MS) but kill site is still fresh.
   * Re-arms pending from the remembered site and starts scoop — never chases empty air.
   */
  function tryScoopLatePostKillCargo(payload) {
    if (!isBotLive()) return false;
    if (!canCollectCargoNow()) return false;
    if (AUTO.pendingCombatCargo) return false;
    // Interrupt bonus/booty only — never abort an in-flight cargo scoop.
    if (AUTO.currentTask === "collect") {
      const tid = AUTO.taskTargetId;
      const spr = tid ? getLootSprite(tid) : null;
      if (
        (tid && AUTO.cargoCollectInFlightId === tid) ||
        (tid && isCargoLoot(spr, tid))
      ) {
        return false;
      }
      clearCollectMovement(tid);
      clearCurrentTask();
    }
    if (abortCargoCollectIfHoldFull()) return false;
    pruneRecentCargoKillSites();
    if (!AUTO.recentCargoKillSites?.length) return false;

    const loots = payload?.loots;
    if (!Array.isArray(loots) || !loots.length) return false;

    for (const u of loots) {
      const id = u?.id;
      if (id == null) continue;
      const type = u.loot_type || getLootTypeFromId(id, getLootSprite(id));
      if (type !== "CARGO") continue;
      const spr = getLootSprite(id);
      if (isForeignOwnedLoot(id, spr)) continue;
      if (isCargoCollectAlreadyDone(id)) continue;
      const x = spr?.x ?? u.x;
      const y = spr?.y ?? u.y;
      if (x == null || y == null) continue;
      const site = findRecentCargoKillSiteNear(x, y);
      if (!site) continue;
      // Re-arm a short pending so the normal scoop path owns lifecycle / settle.
      AUTO.pendingCombatCargo = {
        x: site.x,
        y: site.y,
        npcId: site.npcId,
        at: Date.now(),
        failCount: 0,
        lateArm: true,
      };
      enterMandatoryPostKillCargoPhase(
        site.npcId,
        site.x,
        site.y,
        AUTO.pendingCombatCargo.at
      );
      if (!isInRaidMap()) pauseCombatForPostKillCargo(site.npcId);
      if (tryStartPostKillCargoCollect()) return true;
      // Visible but start failed — leave pending for drivePending tick.
      return Boolean(AUTO.pendingCombatCargo);
    }
    return false;
  }

  function noteCargoCollectStartFailure() {
    const pending = AUTO.pendingCombatCargo;
    if (!pending) return;
    pending.failCount = (pending.failCount || 0) + 1;
    // Repeated start failures → stop blocking the tick (capacity or uncollectable)
    if (
      pending.failCount >= 3 ||
      Date.now() - pending.at > POST_KILL_CARGO_STUCK_MS
    ) {
      if (!canCollectCargoNow()) {
        blockCargoUntilHoldFrees("status.cargo_hold_full");
      } else {
        finishCombatCargoCollect(
          AUTO.cargoCollectInFlightId || AUTO.lastCargoCollectAttempt?.id,
          { count: false }
        );
      }
    }
  }

  /**
   * Disarm attack/lock so post-kill cargo owns movement.
   * keepAlive syncAttackSession + living combat task were chasing the next NPC
   * while pendingCombatCargo was still open (standard maps).
   *
   * mac41: counted / mandatory-phase kills ignore sprite.alive flicker — only a
   * truly fightable NPC (HP) may keep combat armed over cargo.
   */
  function pauseCombatForPostKillCargo(npcId) {
    // mac45: never disarm the player's lock/attack while Stop/Pause.
    if (!isBotLive()) return;
    const mandatoryOrCounted =
      (npcId && AUTO.mandatoryPostKillCargo?.npcId === npcId) ||
      (npcId && AUTO.countedNpcKillIds.has(npcId)) ||
      (npcId && AUTO.pendingCombatCargo?.npcId === npcId);
    if (npcId && isNpcStillFightable(npcId)) {
      return;
    }
    if (
      npcId &&
      !mandatoryOrCounted &&
      (getNpcSprite(npcId)?.alive || !isCombatTargetConfirmedGone(npcId))
    ) {
      return;
    }
    const input = getInputSystem();
    if (input) {
      input.attackMode = false;
      input.pendingAttackOnLock = null;
    }
    clearLockedTarget();
    if (AUTO.currentTask === "combat") {
      AUTO.combatFocusId = null;
      AUTO.combatTargetId = null;
      clearCurrentTask();
    }
  }

  /**
   * Post-kill cargo driver.
   * Phases: wait (short, time-boxed) → collect (delegated) → settle.
   * Returns true only while actively waiting/approaching during the grace window;
   * never blocks combat forever on cargo that already left or never spawned.
   */
  function drivePendingCombatCargoTick(input, ship) {
    if (!AUTO.collectCargo) return false;
    // mac41: re-arm pending from mandatory phase if phantom-clear wiped it.
    if (!AUTO.pendingCombatCargo && AUTO.mandatoryPostKillCargo) {
      rearmPendingCombatCargoFromRecentKillSite();
    }
    if (!AUTO.pendingCombatCargo) return false;

    // Phantom pending: living NPC again → clear even with no combat task.
    clearFalsePendingCargoForLivingTarget(AUTO.pendingCombatCargo.npcId);
    clearPhantomPendingCargoBlockingCombat();
    if (!AUTO.pendingCombatCargo) {
      // Keep owning the tick while mandatory phase still open (rearm next line).
      if (isMandatoryPostKillCargoPhaseOpen()) {
        if (!canCollectCargoNow()) {
          endMandatoryPostKillCargoPhase();
          return false;
        }
        rearmPendingCombatCargoFromRecentKillSite();
      }
      if (!AUTO.pendingCombatCargo) {
        return Boolean(isMandatoryPostKillCargoPhaseOpen());
      }
    }

    // Living sticky mid-fight: never own the tick / never pause combat for cargo.
    // mac41: counted/mandatory dead sticky is NOT "living" — see hasLivingStickyCombat.
    if (hasLivingStickyCombat()) return false;

    // Force-clear combat task so scoop is not blocked by `if (AUTO.currentTask)`.
    if (
      AUTO.currentTask === "combat" &&
      AUTO.mandatoryPostKillCargo &&
      !isNpcStillFightable(AUTO.mandatoryPostKillCargo.npcId)
    ) {
      pauseCombatForPostKillCargo(
        AUTO.mandatoryPostKillCargo.npcId || AUTO.pendingCombatCargo?.npcId
      );
    }

    // Hold full: drop pending + moveTarget immediately, resume combat
    if (abortCargoCollectIfHoldFull()) return false;
    if (!canCollectCargoNow()) {
      finishCombatCargoCollect(
        AUTO.cargoCollectInFlightId || AUTO.taskTargetId || AUTO.pendingCollectId,
        { count: false }
      );
      return false;
    }

    // Mid-fight in raid: don't linger forever under fire waiting for invisible cargo.
    // Visible but NPC-blocked cargo → evasive CLEARING/BREAKOUT instead of abandon.
    // When the stage is already clear, keep scooping — portal wait is next.
    if (isInRaidMap() && ship && !getGameState()?.raidStageClear) {
      if (
        AUTO.raidCargoClear?.phase === "CLEARING" ||
        AUTO.raidCargoClear?.phase === "BREAKOUT" ||
        AUTO.raidCargoClear?.phase === "APPROACH"
      ) {
        return driveRaidCargoClearMovement(input, ship, AUTO.raidCargoClear);
      }
      const threat = getNearestNpcDistance(ship.x, ship.y, getPlayerFireRange() + 220);
      if (threat < Infinity && threat <= getPlayerFireRange() + 80) {
        if (Date.now() - AUTO.pendingCombatCargo.at > 1800) {
          const cargo = findCargoForPendingKill(AUTO.pendingCombatCargo);
          if (cargo) {
            if (isRaidCargoApproachUnsafe(cargo, ship) || isRaidShipThreatenedForCargo(ship)) {
              armRaidCargoClear(cargo);
              return driveRaidCargoClearMovement(input, ship, AUTO.raidCargoClear);
            }
            // Visible + safe enough: fall through to normal scoop start.
          } else if (!listRaidVisibleCargo(ship).length) {
            // No visible cargo under fire — don't freeze forever on empty wait.
            finishCombatCargoCollect(AUTO.cargoCollectInFlightId, { count: false });
            return false;
          }
        }
      }
    }

    if (AUTO.currentTask === "combat") {
      const combatId = AUTO.taskTargetId;
      clearFalsePendingCargoForLivingTarget(combatId);

      const pendingId = AUTO.pendingCombatCargo?.npcId;
      const pendingKillReady =
        pendingId &&
        !isNpcStillFightable(pendingId) &&
        (AUTO.countedNpcKillIds.has(pendingId) ||
          pendingId === combatId ||
          !combatId);

      // Standard maps: after confirmed own kill, scoop owns the tick until done/missed.
      // Do NOT require visible cargo first — that let combat walk away while APPEAR_MS
      // expired, then late lootAdd found no pending. Still no soft-chase of empty air.
      if (!isInRaidMap() && pendingKillReady) {
        pauseCombatForPostKillCargo(pendingId || combatId);
      } else {
        // Raid / unconfirmed: only preempt when real allowed cargo is already visible.
        const visibleCargo = findCargoForPendingKill(AUTO.pendingCombatCargo);
        if (!visibleCargo) {
          // Living / unconfirmed kill, or phantom pending: never break combat to chase air.
          if (
            combatId &&
            (isNpcStillFightable(combatId) || !isCombatTargetConfirmedGone(combatId))
          ) {
            return false;
          }
          return false;
        }

        if (pendingKillReady && !isInRaidMap()) {
          pauseCombatForPostKillCargo(pendingId || combatId);
        } else if (
          combatId &&
          (isNpcStillFightable(combatId) || !isCombatTargetConfirmedGone(combatId))
        ) {
          return false;
        } else if (!getNpcEntry(combatId) && isCombatTargetConfirmedGone(combatId)) {
          pauseCombatForPostKillCargo(combatId);
        } else if (!isInRaidMap() && isCombatTargetConfirmedGone(combatId)) {
          pauseCombatForPostKillCargo(combatId);
        } else {
          return false;
        }
      }
    }

    // Collect already running — let driveCollect own the tick
    if (AUTO.currentTask === "collect") return false;
    if (AUTO.currentTask) return false;

    const pending = AUTO.pendingCombatCargo;
    const waitedMs = Date.now() - pending.at;

    // GOLDEN RULE: never abandon while visible allowed cargo remains near the kill.
    const visibleNearPending = listCargoNearPoint(
      pending.x,
      pending.y,
      POST_KILL_CARGO_RADIUS
    ).filter((c) => !isCargoCollectAlreadyDone(c.id));
    if (waitedMs > POST_KILL_CARGO_WAIT_MS) {
      if (visibleNearPending.length) {
        // Soft-extend the wait window — scoop owns until collected/gone.
        pending.at = Date.now() - Math.floor(POST_KILL_CARGO_WAIT_MS * 0.55);
      } else if (
        isInRaidMap() &&
        listRaidVisibleCargo(ship).length > 0
      ) {
        // Raid leftover elsewhere on map — yield to sweep, keep site for late lootAdd.
        finishCombatCargoCollect(AUTO.cargoCollectInFlightId, { count: false });
        return false;
      } else {
        finishCombatCargoCollect(AUTO.cargoCollectInFlightId, { count: false });
        return false;
      }
    }

    // Orphaned in-flight without a collect task: retry longer while cargo still visible.
    if (AUTO.cargoCollectInFlightId && waitedMs > POST_KILL_CARGO_STUCK_MS) {
      const inFlight = AUTO.cargoCollectInFlightId;
      const stillThere =
        getGameState()?.loots?.has?.(inFlight) || Boolean(getLootSprite(inFlight));
      if (!stillThere || isCargoCollectAlreadyDone(inFlight)) {
        finishCombatCargoCollect(inFlight, { count: false });
        return false;
      }
      if (!canCollectCargoNow()) {
        blockCargoUntilHoldFrees("status.cargo_hold_full");
        return false;
      }
      // Still visible — re-arm collect instead of abandoning (golden rule).
      if (tryStartPostKillCargoCollect()) return true;
      if (visibleNearPending.length) {
        pending.at = Date.now() - Math.floor(POST_KILL_CARGO_WAIT_MS * 0.55);
        return true;
      }
      finishCombatCargoCollect(inFlight, { count: false });
      return false;
    }

    if (tryStartPostKillCargoCollect()) return true;

    const pendingNow = AUTO.pendingCombatCargo;
    if (!pendingNow) return false;

    const waitedNow = Date.now() - pendingNow.at;
    const nearCargo = listCargoNearPoint(pendingNow.x, pendingNow.y, POST_KILL_CARGO_RADIUS).filter(
      (c) => !isCargoCollectAlreadyDone(c.id)
    );
    if (waitedNow > POST_KILL_CARGO_WAIT_MS && !nearCargo.length) {
      finishCombatCargoCollect(AUTO.cargoCollectInFlightId, { count: false });
      return false;
    }
    if (waitedNow > POST_KILL_CARGO_WAIT_MS && nearCargo.length) {
      pendingNow.at = Date.now() - Math.floor(POST_KILL_CARGO_WAIT_MS * 0.55);
    }

    // No visible/allowed cargo: never soft-chase the death spot (phantom "Vado al cargo").
    // Clear leftover move toward pending, expire after appear grace, let combat continue.
    if (!nearCargo.length) {
      const scoopedId =
        AUTO.cargoCollectInFlightId ||
        AUTO.lastCargoCollectAttempt?.id ||
        null;
      if (
        scoopedId &&
        (isCargoCollectAlreadyDone(scoopedId) ||
          (!getGameState()?.loots?.has?.(scoopedId) && !getLootSprite(scoopedId)))
      ) {
        finishCombatCargoCollect(scoopedId, { count: false });
        return false;
      }

      if (input?.moveTarget && pendingNow.x != null && pendingNow.y != null) {
        const mt = input.moveTarget;
        if (
          mt?.x != null &&
          mt?.y != null &&
          distance(mt.x, mt.y, pendingNow.x, pendingNow.y) < 120
        ) {
          input.moveTarget = null;
        }
      }
      const K = getGameState();
      if (K?.cargoTargetId) {
        const ct = K.cargoTargetId;
        if (!getGameState()?.loots?.has?.(ct) && !getLootSprite(ct)) {
          K.cargoTargetId = null;
        }
      }

      if (waitedNow > POST_KILL_CARGO_WAIT_MS) {
        finishCombatCargoCollect(AUTO.cargoCollectInFlightId, { count: false });
        return false;
      }
      // Raid Gate: do not freeze on empty air — let the visible-cargo sweep continue.
      // Pending stays armed so a late drop for this kill still scoops.
      if (isInRaidMap()) return false;
      // Own the post-kill window until WAIT_MS so nearest bonus / next NPC cannot
      // steal the tick while lootAdd is still in flight (no soft-chase of empty air).
      setStatus("status.cargo_wait");
      return true;
    }

    // Visible but startCollect failed this tick — don't freeze; retry next tick or stuck path
    pendingNow.siteArrivedAt = 0;
    return false;
  }

  function handleEntityKill(payload) {
    if (!payload) return;
    // mac45: kill→cargo arming is bot-only; manual play must keep lock/attack free.
    if (!isBotLive()) return;
    // hit/rocketHit often omit targetHp on normal damage — that is NOT a kill.
    // Only explicit HP<=0 may arm cargo / count; missing HP must wait for
    // entityRemove / clearTaskIfDone confirmed-gone (prevents mid-fight abandon).
    if (payload.targetHp == null || Number(payload.targetHp) > 0) return;

    const K = getGameState();
    if (!K?.mySessionId) return;

    const targetId = payload.targetId;
    if (!targetId || !isNpcEntity(targetId)) return;

    const isOurShot = payload.shooterId === K.mySessionId;
    if (!isOurShot) return;

    // Schema/sprite still living (incl. alive=false HP-sync flicker) — finish the kill.
    // A premature countedNpcKillIds.add made isCombatTargetConfirmedGone true on the
    // next not-fightable frame and cleared combat → wander/retarget for 1–2s.
    if (isNpcStillFightable(targetId) || getNpcSprite(targetId)?.alive) return;

    // Arm once here; noteNpcKill uses trackCargo:false to avoid double-write noise.
    // notePendingCombatCargo preempts combat on standard maps when arm succeeds.
    notePendingCombatCargo(targetId, getNpcLastPosition(targetId));

    if (AUTO.countedNpcKillIds.has(targetId)) return;

    const typeKey = resolveNpcType(targetId) || AUTO.trackedNpcTypes.get(targetId);
    if (!typeKey) return;

    noteNpcKill(targetId, typeKey, { trackCargo: false });
  }

  function handleEntityRemove(payload) {
    if (!isBotLive()) return;
    const ids = payload?.ids;
    if (!Array.isArray(ids)) return;

    for (const id of ids) {
      if (AUTO.countedNpcKillIds.has(id) || !isNpcEntity(id)) continue;
      if (!isOurCombatTarget(id) && !AUTO.watchedNpcIds.has(id)) continue;
      // AOI / schema flicker can remove a living NPC briefly — do not count a kill yet.
      if (isNpcStillFightable(id) || getNpcSprite(id)?.alive) continue;

      const typeKey = resolveNpcType(id) || AUTO.trackedNpcTypes.get(id);
      if (!typeKey) continue;

      noteNpcKill(id, typeKey, { trackCargo: wasActivelyAttackingNpc(id) });
    }
  }

  function scanWatchedNpcKills() {
    const entities = getEntities();
    if (!entities?.npcSprites) return;

    for (const id of [...AUTO.watchedNpcIds]) {
      if (isNpcStillFightable(id)) continue;
      const sprite = entities.npcSprites.get(id);
      if (sprite?.alive) continue;
      // Wait out brief alive flicker before counting a kill.
      if (!isCombatTargetConfirmedGone(id) && !AUTO.countedNpcKillIds.has(id)) continue;

      const typeKey = AUTO.trackedNpcTypes.get(id) || resolveNpcType(id);
      if (!typeKey) {
        AUTO.watchedNpcIds.delete(id);
        continue;
      }

      noteNpcKill(id, typeKey, { trackCargo: wasActivelyAttackingNpc(id) });
    }
  }

  function handleRaidDeath() {
    AUTO.deathInfoReceived = true;
    const K = getGameState();
    if (K) K.isDead = true;
    clearPostDeathRecoverState();
    AUTO.raidHealMode = false;
    AUTO.fleeActive = false;
    AUTO.fleeMode = null;
    clearCurrentTask();
    stopCombat();
    // Repair before register so death-limit stopPlay cannot block auto-repair.
    if (AUTO.active && !AUTO.paused) tryAutoRepairAfterDeath();
    registerPlayerDeath("raid");
    if (AUTO.active && !AUTO.paused) tryAutoRepairAfterDeath();
  }

  function isBonusLootId(lootId) {
    const K = getGameState();
    const loot = K?.loots?.get?.(lootId);
    if (loot?.loot_type === "BONUS_BOX") return true;
    const sprite = getEntities()?.lootSprites?.get(lootId);
    return isBonusLoot(sprite);
  }

  function maybeAlertAdminKill(payload) {
    if (!AUTO.active) return;
    const myNick = String(
      getLocalPlayer()?.nickname || getLocalPlayer()?.username || ""
    ).trim();
    const victim = String(payload?.victimNickname || payload?.victim || "").trim();
    const killer = String(
      payload?.killerNickname || payload?.killer || payload?.killerName || ""
    ).trim();
    // killed event: only when we are the victim. deathInfo may lack victim fields.
    if (victim && myNick && victim !== myNick) return;
    let adminName = "";
    if (killer && isKnownAdminNickname(killer)) adminName = killer;
    if (!adminName) {
      const nearby = findNearestAdminPlayer(FLEE_ENEMY_DETECT_RADIUS);
      if (nearby?.nickname) adminName = nearby.nickname;
    }
    if (!adminName && AUTO.adminPauseName) adminName = AUTO.adminPauseName;
    if (!adminName && !isSectorZMap()) return;
    if (!adminName) adminName = "?";
    rememberAdminName(adminName);
    sendDiscordAdminAlert(
      "admin_kill",
      t("discord.admin_alert.killed", { name: adminName }),
      { name: adminName }
    );
    setStatus("status.admin_killed_you", { name: adminName });
  }

  function registerStoryNetHooks() {
    const net = window.__RG_NET__;
    if (!net?.onMessage) return;

    net.onMessage("lootRemove", (payload) => {
      const ids = payload?.ids;
      if (!Array.isArray(ids)) return;
      forgetLootOwners(ids);
      for (const id of ids) {
        const tracked =
          AUTO.pendingBonusIds.has(id) ||
          AUTO.pendingCollectId === id ||
          AUTO.chasingBonusId === id;
        if (!tracked) continue;
        noteCollectRemoved(id);
        AUTO.pendingBonusIds.delete(id);
        if (AUTO.pendingCollectId === id) AUTO.pendingCollectId = null;
        if (AUTO.chasingBonusId === id) AUTO.chasingBonusId = null;
      }
    });

    // killReward has no reliable npcId — never re-arm pending from it.
    // Arming is owned by handleEntityKill / noteNpcKill / clearTaskIfDone.
    // Late killReward after collect was the main source of phantom cargo_wait.
    net.onMessage("killReward", () => {
      if (!isBotLive()) return;
      if (AUTO.pendingCombatCargo && canCollectCargoNow()) {
        tryStartPostKillCargoCollect();
      }
    });

    net.onMessage("lootAdd", (payload) => {
      rememberLootOwners(payload);
      if (!isBotLive()) return;
      if (AUTO.pendingCombatCargo) {
        tryStartPostKillCargoCollect();
      } else {
        tryScoopLatePostKillCargo(payload);
      }
    });

    net.onMessage("collectSuccess", (payload) => {
      if (applyCollectContentsToOres(payload?.contents)) {
        scheduleRefineryProcess();
        requestPlayerSlowSync();
      }
      // Solo cargo post-kill: bonus/baule chiudono su lootRemove / bootyBoxOpened
      if (AUTO.pendingCombatCargo || AUTO.cargoCollectInFlightId) {
        const id = AUTO.cargoCollectInFlightId || AUTO.taskTargetId || AUTO.pendingCollectId;
        finishCombatCargoCollect(id, { count: true });
      }
      // Se la stiva è piena dopo la raccolta, non inseguire altro cargo
      abortCargoCollectIfHoldFull();
    });

    net.onMessage("collectFailed", (payload) => {
      const reason = String(payload?.reason || "").toLowerCase();
      if (payload?.reason === "no_key") {
        AUTO.bootyKeysBlocked = true;
        AUTO.collectBooty = false;
        syncCollectMasterFlag();
        updateModeButtons();
        setStatus("status.idle_no_booty_keys");
        const bootyId = AUTO.taskTargetId || AUTO.pendingCollectId;
        if (bootyId) {
          clearCollectMovement(bootyId);
          if (AUTO.currentTask === "collect") clearCurrentTask();
        }
      }
      // Stiva piena / senza spazio: abbandona cargo e non ritornare
      if (
        reason.includes("full") ||
        reason.includes("capacity") ||
        reason.includes("space") ||
        reason === "cargo_full" ||
        reason === "inventory_full"
      ) {
        // Nearly-full rejects often arrive before used >= capacity — block until space frees
        blockCargoUntilHoldFrees("status.cargo_hold_full");
      }
      // too_far: ritenta solo se il lifecycle post-kill è ancora aperto
      if (payload?.reason === "too_far") {
        if (!canCollectCargoNow()) {
          abortCargoCollectIfHoldFull();
          return;
        }
        const attemptId =
          AUTO.lastCargoCollectAttempt?.id ||
          AUTO.cargoCollectInFlightId ||
          AUTO.taskTargetId ||
          AUTO.pendingCollectId;
        const pending = AUTO.pendingCombatCargo;
        // Never resurrect pending after finish/settle — that caused phantom cargo_wait
        if (!pending || (pending.npcId && isCargoSettledForNpc(pending.npcId))) {
          AUTO.cargoCollectInFlightId = null;
          AUTO.lastCargoCollectAttempt = null;
          clearCollectMovement(attemptId);
          if (AUTO.currentTask === "collect") clearCurrentTask();
          if (pending) finishCombatCargoCollect(attemptId, { count: false });
          return;
        }
        if (attemptId) {
          AUTO.cargoCollectDoneIds.delete(attemptId);
          AUTO.cargoCollectInFlightId = null;
          AUTO.collectArriveAt = 0;
          AUTO.lastCollectSendAt = 0;
        }
        const attempt = AUTO.lastCargoCollectAttempt;
        const stillThere =
          attempt?.id &&
          getGameState()?.loots?.has?.(attempt.id) &&
          !isCargoCollectAlreadyDone(attempt.id);
        const pendingAt = pending.at;
        if (
          attempt &&
          stillThere &&
          Date.now() - attempt.at < 4000 &&
          Date.now() - pendingAt < POST_KILL_CARGO_WAIT_MS
        ) {
          if (AUTO.currentTask !== "collect") {
            startCollectTask({
              id: attempt.id,
              x: attempt.x,
              y: attempt.y,
              kind: "cargo",
              type: "CARGO",
            });
          } else {
            armNativeCollect(attempt.id);
          }
        } else {
          AUTO.lastCargoCollectAttempt = null;
          if (Date.now() - pendingAt >= POST_KILL_CARGO_WAIT_MS) {
            finishCombatCargoCollect(attemptId, { count: false });
          }
        }
      }
    });

    net.onMessage("bootyCollectStart", (payload) => {
      const id = payload?.targetId;
      if (!id) return;
      AUTO.pendingCollectId = id;
      AUTO.chasingBonusId = id;
      if (AUTO.currentTask !== "collect") {
        AUTO.currentTask = "collect";
        AUTO.taskTargetId = id;
      }
      clearCollectMovement(id); // fermo durante il channel del baule
      setStatus("Raccolta baule...");
    });

    net.onMessage("bootyCollectCancelled", () => {
      const id = AUTO.taskTargetId || AUTO.pendingCollectId;
      clearCollectMovement(id);
      if (AUTO.currentTask === "collect") clearCurrentTask();
    });

    net.onMessage("bootyBoxOpened", () => {
      const id = getGameState()?.bootyTargetId || AUTO.taskTargetId || AUTO.pendingCollectId;
      clearCollectMovement(id);
      if (
        AUTO.currentTask === "collect" &&
        (!id || AUTO.taskTargetId === id || AUTO.pendingCollectId === id)
      ) {
        clearCurrentTask();
      }
    });

    net.onMessage("lockInfo", (payload) => {
      if (!payload?.targetId) return;
      const K = getGameState();
      // Mirror game client lock ownership flags (safe while Stop — no control steal).
      if (K && K.lockedTargetId === payload.targetId) {
        K.lockTargetOwnedByOther = !!payload.isOwnedByOther;
        K.lockOwnerExpiresAt = payload.expiresAt ?? 0;
      }
      // mac45: while Stop/Pause, never clear lock / attackMode — manual play owns input.
      if (!isBotLive()) return;
      if (!payload.isOwnedByOther) {
        // Confirmed our lock (red circle) — clear any stale foreign mark.
        AUTO.foreignNpcIds.delete(payload.targetId);
        clearForeignLockSuspect();
        return;
      }
      // Truly someone else's lock — abandon only if that is our current lock.
      if (K?.lockedTargetId === payload.targetId && !isOwnLockOnNpc(payload.targetId)) {
        markForeignNpc(payload.targetId);
        if (!AUTO.foreignNpcIds.has(payload.targetId)) return; // debounce sticky flicker
        clearLockedTarget();
        const input = getInputSystem();
        if (input) {
          input.attackMode = false;
          input.pendingAttackOnLock = null;
        }
        setStatus("status.honor_foreign");
        return;
      }
      // Not our lock: keep for selection avoidance only.
      AUTO.foreignNpcIds.add(payload.targetId);
    });

    net.onMessage("cargoStealPenalty", () => {
      setStatus("status.honor_cargo");
      const id =
        AUTO.cargoCollectInFlightId ||
        AUTO.taskTargetId ||
        AUTO.pendingCollectId ||
        AUTO.lastCargoCollectAttempt?.id;
      if (id) AUTO.lootOwnerById.set(id, "__foreign__");
      finishCombatCargoCollect(id, { count: false });
    });

    net.onMessage("refineOreSuccess", () => {
      AUTO.refineryPending = true;
      scheduleRefineryProcess(250);
      requestPlayerSlowSync();
    });

    net.onMessage("refineOreFailed", () => {
      AUTO.refineryPending = true;
      AUTO.refineryScheduledAt = Date.now() + 900;
      requestPlayerSlowSync();
    });

    net.onMessage("enrichOreSuccess", (payload) => {
      applyEnrichPayloadLocal(payload);
      AUTO.refineryPending = true;
      scheduleRefineryProcess(250);
      requestPlayerSlowSync();
    });

    net.onMessage("enrichOreFailed", () => {
      clearRefineryEnhanceQueue();
      AUTO.refineryPending = true;
      AUTO.refineryScheduledAt = Date.now() + 900;
      requestPlayerSlowSync();
    });

    net.onMessage("buyAmmoSuccess", (payload) => {
      const player = getLocalPlayer();
      if (player && payload?.ammoType) {
        if (!player.ammo) player.ammo = {};
        const granted = Number(payload.amount) || 0;
        if (granted > 0) {
          player.ammo[payload.ammoType] = (player.ammo[payload.ammoType] || 0) + granted;
        }
      }
      AUTO.combatAmmoBuyPending = false;
      updateAttackAmmoButtons();
      requestPlayerSlowSync();
    });

    net.onMessage("buyAmmoFailed", () => {
      AUTO.combatAmmoBuyPending = false;
      updateAttackAmmoButtons();
    });

    net.onMessage("hit", handleEntityKill);
    net.onMessage("rocketHit", handleEntityKill);
    net.onMessage("entityRemove", handleEntityRemove);
    net.onMessage("raidDeath", handleRaidDeath);
    net.onMessage("deathInfo", (payload) => {
      // Sticky definitive death — bypasses arrival-grace ignores / flaky alive sync.
      AUTO.deathInfoReceived = true;
      const K = getGameState();
      if (K) K.isDead = true;
      maybeAlertAdminKill(payload);
      // B13 reliability: repair FIRST so register→stopPlay(death limit) cannot block it.
      // Then count; then repair again if still active (ties wasDead for recover).
      if (AUTO.active && !AUTO.paused) tryAutoRepairAfterDeath();
      registerPlayerDeath(isInRaidMap() ? "raid" : "combat");
      if (AUTO.active && !AUTO.paused) tryAutoRepairAfterDeath();
    });
    net.onMessage("killed", (payload) => {
      maybeAlertAdminKill(payload);
    });
    net.onMessage("groupInviteReceived", (payload) => {
      handleGroupInviteReceived(payload);
    });
    net.onMessage("repairShipSuccess", () => {
      const K = getGameState();
      if (K) K.isDead = false;
      AUTO.deathInfoReceived = false;
      AUTO.deathSignalSince = 0;
      AUTO.repairSentAt = 0;
      dismissDeathProfileMenu({ allowEscape: false });
      window.setTimeout(() => dismissDeathProfileMenu({ allowEscape: false }), 400);
      // Enter recover→heal→resume without re-counting death.
      if (!AUTO.active || AUTO.paused) {
        AUTO.repairSentThisDeath = false;
        return;
      }
      if (AUTO.deathLimit > 0 && AUTO.deathCount >= AUTO.deathLimit) {
        AUTO.wasDead = false;
        AUTO.repairSentThisDeath = false;
        return;
      }
      if (AUTO.wasDead) {
        AUTO.wasDead = false;
        AUTO.repairSentThisDeath = false;
        beginPostDeathRecover();
      } else {
        AUTO.repairSentThisDeath = false;
        if (!AUTO.postDeathRecover) beginPostDeathRecover();
      }
    });
    net.onMessage("repairFailed", () => {
      // Do not stick in repair limbo — allow retry; keep death sticky until alive again.
      AUTO.repairSentThisDeath = false;
      AUTO.repairSentAt = 0;
      setStatus("status.repair_failed");
      dismissDeathProfileMenu({ allowEscape: false });
    });
    net.onMessage("respawned", (payload) => {
      const K = getGameState();
      if (payload?.playerId && K?.mySessionId && payload.playerId !== K.mySessionId) return;
      AUTO.deathInfoReceived = false;
    });
    net.onMessage("lockFailed", (payload) => {
      handleNetLockOrShootFailed(payload, "lock");
    });
    net.onMessage("shootFailed", (payload) => {
      handleNetLockOrShootFailed(payload, "shoot");
    });
    net.onMessage("cloakSuccess", () => {
      AUTO.lastCloakAt = Date.now();
    });
    net.onMessage("cloakFailed", () => {
      /* cooldown/ammo — leave lastCloakAt so we do not spam */
    });
    net.onMessage("buyBootyKeySuccess", () => {
      AUTO.bootyKeyBuyPending = false;
      AUTO.bootyKeysBlocked = false;
      requestPlayerSlowSync();
      setStatus("status.booty_key_bought");
    });
    net.onMessage("buyBootyKeyFailed", () => {
      AUTO.bootyKeyBuyPending = false;
      setStatus("status.booty_key_buy_failed");
    });
    net.onMessage("raidInfo", (payload) => {
      noteRaidProgressFromInfo(payload);
      if (!AUTO.raidGateId) return;
      applyRaidGateNpcSelection(AUTO.raidGateId);
      window.setTimeout(() => syncRaidNpcSelectionFromMap(), 600);
    });
    net.onMessage("raidWave", (payload) => {
      noteRaidProgressFromWave(payload);
      // Soft wave arm: short breakout window only — never clear combat/orbit (that caused freeze).
      armRaidWaveReposition("wave");
      // mac46: do NOT force heal just because HP/shield < 100% on a new wave.
      // That ignored Flee HP % and looked like random early flee. Heal flee is owned
      // by shouldFleeByHp / processSecurityGates; full heal stays for stage advance.
      if (shouldFleeByHp()) {
        AUTO.raidHealMode = true;
        AUTO.raidFleeTarget = null;
        AUTO.raidHealSide = -1;
        AUTO.raidHealPhase = "evade";
        if (AUTO.modeAttack) AUTO.combatSuspendedForFlee = true;
        const input = getInputSystem();
        if (input) clearCombatMoveTarget(input);
      } else {
        clearRaidFleeStateIfRecovered();
      }
      if (!AUTO.raidGateId) return;
      window.setTimeout(() => {
        if (shouldFleeByHp()) {
          AUTO.raidHealMode = true;
          AUTO.raidHealPhase = "evade";
          if (AUTO.modeAttack) AUTO.combatSuspendedForFlee = true;
        }
        syncRaidNpcSelectionFromMap();
      }, 700);
    });
    net.onMessage("raidStageClear", (payload) => {
      noteRaidProgressFromStageClear(payload);
      const isLast =
        Boolean(payload?.isLastStage) || Boolean(getGameState()?.raidIsLastStage);
      if (isLast) {
        window.setTimeout(() => maybeStopOnRaidGateComplete("last_stage"), 350);
        return;
      }
      if (mustHealBeforeRaidAdvance()) {
        AUTO.raidHealMode = true;
        AUTO.raidFleeTarget = null;
        AUTO.raidHealSide = -1;
        AUTO.raidHealPhase = null;
      } else {
        clearRaidFleeStateIfRecovered();
      }
      if (!AUTO.raidGateId) return;
      window.setTimeout(() => syncRaidNpcSelectionFromMap(), 400);
    });
    net.onMessage("raidExit", (payload) => {
      clearRaidProgressTracking();
      if (payload?.completed) {
        maybeStopOnRaidGateComplete("exit");
      }
    });

    // Portal jump confirmations: stop tryJump spam (esp. raid stage → "nessun portale vicino").
    const latchJumpIfNavigating = (reason) => () => {
      if (NAV.active && NAV.phase === "jump") latchPortalJump(reason);
    };
    net.onMessage("jumpApproved", latchJumpIfNavigating("jumpApproved"));
    net.onMessage("jumpExecute", latchJumpIfNavigating("jumpExecute"));
    net.onMessage("raidPortalReady", latchJumpIfNavigating("raidPortalReady")); // log "portale pronto"
    net.onMessage("raidJumpApproved", latchJumpIfNavigating("raidJumpApproved"));
    net.onMessage("raidJumpExecute", latchJumpIfNavigating("raidJumpExecute"));
  }

  function installGameHooks() {
    window.__RG_STORY_ON_BONUS__ = () => noteBonusCollected(null);

    const net = window.__RG_NET__;
    if (!net?.onMessage) return;

    if (!net.__rgStoryClearWrapped) {
      net.__rgStoryClearWrapped = true;
      const rebindStoryHooks = () => {
        AUTO.gameHooksInstalled = false;
        registerStoryNetHooks();
        AUTO.gameHooksInstalled = true;
        // Soft-reset / room transfer clears callbacks *after* clearCallbacks wrap
        // rebinds us, then messageBridge.register() wipes again via clearMessageCallbacks.
        // Re-request raidInfo once hooks are back so stage/total aren't stuck at 0.
        try {
          if (isInRaidMap() || getGameState()?.inRaid) {
            net.sendRequestRaidInfo?.();
          }
        } catch (_) {}
      };
      const origClear = net.clearCallbacks.bind(net);
      net.clearCallbacks = function rgStoryClearCallbacks() {
        origClear();
        rebindStoryHooks();
      };
      // Critical: room transfer softReset calls clearCallbacks THEN messageBridge.register()
      // which uses clearMessageCallbacks — that path was wiping Bastion raid/kill hooks.
      if (typeof net.clearMessageCallbacks === "function") {
        const origClearMsg = net.clearMessageCallbacks.bind(net);
        net.clearMessageCallbacks = function rgStoryClearMessageCallbacks() {
          origClearMsg();
          rebindStoryHooks();
        };
      }
    }

    if (AUTO.gameHooksInstalled) return;
    AUTO.gameHooksInstalled = true;
    registerStoryNetHooks();
  }

  function setLockedTarget(id) {
    const K = getGameState();
    const entities = getEntities();
    if (!K || !id) return false;
    if (!isNpcAllowedForCombat(id) && K.npcs?.has?.(id)) return false;
    K.cargoTargetId = null;
    if (K.lockedTargetId === id) return true;
    K.lockedTargetId = id;
    K.lockTargetOwnedByOther = false;
    K.lockOwnerExpiresAt = 0;
    entities?.updateLockedState?.();
    return true;
  }

  function clearLockedTarget() {
    const K = getGameState();
    const entities = getEntities();
    const input = getInputSystem();
    if (input?.sentAttackTarget) {
      window.__RG_NET__?.sendAttackStop?.();
      input.sentAttackTarget = null;
      input.sentAutoRocket = false;
    }
    if (K) {
      K.lockedTargetId = null;
      entities?.updateLockedState?.();
    } else {
      window.__RG_NET__?.sendUnlockTarget?.();
    }
  }

  /**
   * lockFailed / shootFailed: release matching lock; retarget only when appropriate.
   * Keep near-dead sticky focus unless the lock itself failed.
   * Do not thrash raid orbit (no orbit reset here).
   */
  function handleNetLockOrShootFailed(payload, source) {
    // mac45: do not clear the player's lock while Bastion is Stop/Pause.
    if (!isBotLive()) return;
    const reason = String(payload?.reason || "").toLowerCase();
    if (source === "shoot" && reason && reason !== "no_lock" && reason !== "invalid_target") {
      return;
    }

    const K = getGameState();
    const lockedId = K?.lockedTargetId || null;
    const focusId =
      AUTO.combatFocusId || AUTO.taskTargetId || AUTO.combatTargetId || lockedId || null;
    if (!lockedId && !focusId) return;

    const stickyAlive =
      focusId && isNpcStillFightable(focusId) && !isCombatTargetConfirmedGone(focusId);

    // shootFailed/no_lock on a living sticky: clear broken lock only — keep focus.
    if (stickyAlive && source === "shoot") {
      if (lockedId && (lockedId === focusId || lockedId === AUTO.combatFocusId)) {
        clearLockedTarget();
      }
      return;
    }

    // lockFailed, or failure on a gone target: release matching lock/focus cleanly.
    if (lockedId && (!focusId || lockedId === focusId || lockedId === AUTO.combatFocusId)) {
      clearLockedTarget();
    }

    if (source === "lock" || (focusId && isCombatTargetConfirmedGone(focusId))) {
      if (focusId && AUTO.combatFocusId === focusId) AUTO.combatFocusId = null;
      if (focusId && AUTO.combatTargetId === focusId) AUTO.combatTargetId = null;
      if (focusId && AUTO.currentTask === "combat" && AUTO.taskTargetId === focusId) {
        clearCurrentTask();
      }
    }
  }

  function listNpcTypes() {
    const counts = countNpcsByTypeMap();
    return Object.entries(NPC_TYPES).map(([key, label]) => ({
      key,
      label,
      count: counts.get(key) || 0,
    }));
  }

  /** Single pass over sprites → type counts (UI refresh). */
  function countNpcsByTypeMap() {
    const entities = getEntities();
    const counts = new Map();
    if (!entities?.npcSprites) return counts;
    for (const sprite of entities.npcSprites.values()) {
      if (!sprite?.alive) continue;
      const type = getSpriteNpcType(sprite);
      if (!type) continue;
      counts.set(type, (counts.get(type) || 0) + 1);
    }
    return counts;
  }

  function countNpcsOfType(typeKey) {
    if (!typeKey) return 0;
    return countNpcsByTypeMap().get(typeKey) || 0;
  }

  function listNpcsByType(typeKey, maxRadius) {
    const entities = getEntities();
    const ship = getShipPosition();
    if (!entities?.npcSprites || !ship || !typeKey) return [];

    const npcs = [];
    for (const [id, sprite] of entities.npcSprites) {
      if (!sprite?.alive) continue;
      if (!isNpcAllowedForCombat(id)) continue;
      if (getSpriteNpcType(sprite) !== typeKey) continue;
      const pos = getNpcPosition(sprite);
      if (!pos) continue;
      const dist = distance(ship.x, ship.y, pos.x, pos.y);
      if (maxRadius && dist > maxRadius) continue;
      npcs.push({
        id,
        x: pos.x,
        y: pos.y,
        dist,
        type: typeKey,
        name: getNpcTypeLabel(typeKey),
      });
    }
    npcs.sort((a, b) => a.dist - b.dist);
    return npcs;
  }

  function nearestNpcOfTypes(typeKeys) {
    if (!typeKeys?.size) return null;
    let best = null;
    for (const typeKey of typeKeys) {
      const npc = nearestNpcOfType(typeKey);
      if (!npc) continue;
      if (!best || npc.dist < best.dist) best = npc;
    }
    return best;
  }

  function toggleNpcTypeSelection(typeKey, options = {}) {
    if (!AUTO.modeAttack && !options.force) {
      setStatus("status.npc_requires_attack");
      return;
    }
    if (AUTO.selectedNpcTypes.has(typeKey)) {
      AUTO.selectedNpcTypes.delete(typeKey);
    } else {
      AUTO.selectedNpcTypes.add(typeKey);
    }
    // Keep acquisition filter in sync; never clear living sticky mid-kill.
    if (AUTO.combatActive) refreshCombatTargetTypesFromSelection();
    updateNpcListVisuals();
    updateStatisticsPanel();
  }

  function clearNpcTypeSelection() {
    AUTO.selectedNpcTypes.clear();
    if (AUTO.combatActive) refreshCombatTargetTypesFromSelection();
    updateNpcListVisuals();
    updateStatisticsPanel();
  }

  function selectAllNpcTypes(options = {}) {
    if (!AUTO.modeAttack && !options.force) {
      setStatus("status.npc_requires_attack");
      return;
    }
    for (const key of Object.keys(NPC_TYPES)) {
      AUTO.selectedNpcTypes.add(key);
    }
    if (AUTO.combatActive) refreshCombatTargetTypesFromSelection();
    updateNpcListVisuals();
    updateStatisticsPanel();
  }

  function getRaidGateNpcTypes(gateRef) {
    const gate = resolveRaidGate(gateRef);
    if (!gate) return [];
    return (RAID_GATE_NPC_TYPES[gate] || []).filter((type) => NPC_TYPES[type]);
  }

  function listVisibleMapNpcTypes() {
    const entities = getEntities();
    if (!entities?.npcSprites) return [];

    const types = new Set();
    for (const sprite of entities.npcSprites.values()) {
      if (!sprite?.alive) continue;
      const type = getSpriteNpcType(sprite);
      if (type && NPC_TYPES[type]) types.add(type);
    }
    return [...types];
  }

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

  function enableRaidCombatPreset() {
    AUTO.modeAttack = true;
    selectAllNpcTypes({ force: true });
    if (!AUTO.modeOrbit) resetOrbitState();
    AUTO.modeOrbit = true;
    if (AUTO.combatActive) refreshCombatTargetTypesFromSelection();
    updateModeButtons();
  }

  function applyRaidGateNpcSelection(gateRef, options = {}) {
    const gate = resolveRaidGate(gateRef);
    if (!gate) return false;

    enableRaidCombatPreset();

    const mergeVisible = options.mergeVisible !== false;
    if (mergeVisible && isInRaidMap()) {
      for (const type of listVisibleMapNpcTypes()) AUTO.selectedNpcTypes.add(type);
      updateNpcListVisuals();
      refreshCombatTargetTypesFromSelection();
    }

    if (!options.silent) {
      setStatus(
        `Raid ${gate.toUpperCase()}: ${AUTO.selectedNpcTypes.size} NPC, attacco + orbita attivi` +
          (isInRaidMap() ? "" : " (sync auto all'ingresso)")
      );
    }
    return true;
  }

  function syncRaidNpcSelectionFromMap() {
    if (!AUTO.raidGateId || !isInRaidMap()) return false;

    const types = new Set(getRaidGateNpcTypes(AUTO.raidGateId));
    for (const type of listVisibleMapNpcTypes()) types.add(type);
    if (!types.size) return false;

    let changed = types.size !== AUTO.selectedNpcTypes.size;
    if (!changed) {
      for (const type of types) {
        if (!AUTO.selectedNpcTypes.has(type)) {
          changed = true;
          break;
        }
      }
    }

    if (!changed) return false;

    AUTO.selectedNpcTypes = types;

    updateNpcListVisuals();
    updateStatisticsPanel();
    refreshCombatTargetTypesFromSelection();
    return true;
  }

  function resetPanelDockPosition() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    panel.style.top = "";
    panel.style.right = "";
    panel.style.left = "";
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function resetOrbitState() {
    AUTO.orbitNpcId = null;
    AUTO.orbitDirection = Math.random() < 0.5 ? 1 : -1;
    AUTO.orbitPhaseAngle = null;
    AUTO.orbitFlipAt = Date.now() + AUTO.orbitFlipIntervalMs;
    AUTO.orbitLastPos = null;
    AUTO.orbitStuckSince = 0;
    AUTO.stdOrbitLastRadialSign = 0;
  }

  /** Soft clear on raid retarget: keep clockwise/CCW and tower-orbit phase continuity. */
  function softResetOrbitForRetarget() {
    AUTO.orbitNpcId = null;
    // Keep orbitPhaseAngle — continuous tower arc across kill→retarget
    AUTO.orbitLastPos = null;
    AUTO.orbitStuckSince = 0;
    // Keep lastRaidOrbitMoveAt so wide-orbit health / direction preserve still applies
    if (!AUTO.orbitDirection) AUTO.orbitDirection = 1;
  }

  function hasRecentRaidOrbitMomentum() {
    return isInRaidMap() && Date.now() - (AUTO.lastRaidOrbitMoveAt || 0) < 4500;
  }

  function isRaidWideOrbitHealthy(ship = getShipPosition()) {
    if (!isInRaidMap() || !ship) return false;
    if (!hasRecentRaidOrbitMomentum() && AUTO.orbitNpcId == null) return false;
    const fireRange = getPlayerFireRange();
    const preferred = fireRange - (AUTO.raidOrbitPreferredInset ?? 8);
    const nearest = getNearestNpcDistance(ship.x, ship.y);
    if (!(nearest < Infinity)) return false;
    // Already on the wide laser-edge kite ring — do not dive inward on retarget
    return nearest >= preferred - 90 && nearest <= fireRange + 55;
  }

  function isCombatOrbitEngaged(npcId) {
    return Boolean(npcId && AUTO.combatOrbitEngagedIds.has(npcId));
  }

  function markCombatOrbitEngaged(npcId) {
    if (npcId) AUTO.combatOrbitEngagedIds.add(npcId);
  }

  function noteCombatEngageStart(npcId) {
    if (!npcId) return;
    if (AUTO.combatEngageNpcId !== npcId) {
      AUTO.combatEngageNpcId = npcId;
      AUTO.combatEngageStartedAt = Date.now();
    }
  }

  /**
   * True once sticky has taken our damage / aggro'd us, or first-hit timeout elapsed
   * while we were already in laser range (so portal-drift does not leave unhit NPCs).
   */
  function hasStickyFirstHitOrTimeout(npc) {
    if (!npc?.id) return true;
    updateCombatOrbitEngagement(npc);
    if (isCombatOrbitEngaged(npc.id)) return true;
    const state = getGameState()?.npcs?.get?.(npc.id);
    if (state?.max_hp > 0 && state.hp != null && state.hp < state.max_hp - 0.5) {
      markCombatOrbitEngaged(npc.id);
      return true;
    }
    if (isNpcAttackingPlayer(npc.id)) {
      markCombatOrbitEngaged(npc.id);
      return true;
    }
    const started =
      AUTO.combatEngageNpcId === npc.id ? AUTO.combatEngageStartedAt || 0 : 0;
    if (started && Date.now() - started >= PORTAL_DRIFT_FIRST_HIT_TIMEOUT_MS) {
      return true;
    }
    return false;
  }

  function updateCombatOrbitEngagement(npc) {
    if (!npc?.id || isInRaidMap() || isCombatOrbitEngaged(npc.id)) return;

    const input = getInputSystem();
    const K = getGameState();
    const id = npc.id;

    if (input?.attackMode && K?.lockedTargetId === id) {
      markCombatOrbitEngaged(id);
      return;
    }

    const state = K?.npcs?.get?.(id);
    if (state?.is_attacking && state.attack_target_id === K?.mySessionId) {
      markCombatOrbitEngaged(id);
      return;
    }

    if (state?.max_hp > 0 && state.hp != null && state.hp < state.max_hp - 0.5) {
      markCombatOrbitEngaged(id);
    }
  }

  function shouldHoldOrbitDistance(npc) {
    if (!AUTO.modeOrbit) return false;
    if (isInRaidMap()) return true;
    // Standard: hold/orbit from first engage. NPCs chase the attacker — no
    // "first hit" dive into the body (that only closed range and took damage).
    void npc;
    return true;
  }

  function shouldRaidKeepMoving(npc) {
    if (!isInRaidMap() || !npc) return false;
    const ship = getShipPosition();
    if (!ship) return false;
    const fireRange = getPlayerFireRange();
    if (npc.dist <= fireRange + 40) return true;
    const nearby = listNpcs(fireRange + 180);
    return nearby.length >= 2;
  }

  function isRaidWaveRepositionActive() {
    return isInRaidMap() && Date.now() < (AUTO.raidWaveRepositionUntil || 0);
  }

  /**
   * Soft wave arm: open a short breakout window + pick escape side.
   * Does NOT clear combat task / move target / orbit state (that caused stand-still epilepsy).
   */
  function armRaidWaveReposition(reason = "wave") {
    if (!isInRaidMap()) return;
    AUTO.raidWaveRepositionUntil = Date.now() + RAID_WAVE_REPOSITION_MS;
    AUTO.raidWaveEscapeDir = Math.random() < 0.5 ? 1 : -1;
    void reason;
  }

  function isNpcAttackingPlayer(npcId) {
    const K = getGameState();
    if (!npcId || !K?.mySessionId) return false;
    const state = K.npcs?.get?.(npcId);
    return Boolean(state?.is_attacking && state.attack_target_id === K.mySessionId);
  }

  function isRaidShipUnderFire(ship = getShipPosition()) {
    if (!isInRaidMap() || !ship) return false;
    if (isRaidShipEncircled(ship)) return true;
    const fireRange = getPlayerFireRange();
    const close = listNpcs(fireRange + 90);
    if (!close.length) return false;

    let attackers = 0;
    let inRange = 0;
    for (const npc of close) {
      if (isNpcAttackingPlayer(npc.id)) attackers += 1;
      if (npc.dist <= fireRange + 20) inRange += 1;
    }
    if (attackers > 0) return true;
    if (inRange >= 1 && close[0].dist <= fireRange * 0.95) return true;
    if (inRange >= 2) return true;
    return close.filter((n) => n.dist <= RAID_ENCIRCLE_CLOSE_R * 0.9).length >= 2;
  }

  function getRaidSwarmCentroid(npcs) {
    if (!npcs?.length) {
      const center = getRaidCenter();
      return { x: center.x, y: center.y, count: 0 };
    }
    let sx = 0;
    let sy = 0;
    for (const npc of npcs) {
      sx += npc.x;
      sy += npc.y;
    }
    return { x: sx / npcs.length, y: sy / npcs.length, count: npcs.length };
  }

  function countRaidNeighbors(npc, npcs, radius = RAID_SWARM_NEIGHBOR_R) {
    if (!npc || !npcs?.length) return 0;
    let n = 0;
    for (const other of npcs) {
      if (other.id === npc.id) continue;
      if (distance(npc.x, npc.y, other.x, other.y) <= radius) n += 1;
    }
    return n;
  }

  function getRaidAngularSpread(ship, npcs) {
    if (!ship || !npcs?.length) return 0;
    const angles = npcs.map((npc) => Math.atan2(npc.y - ship.y, npc.x - ship.x)).sort((a, b) => a - b);
    if (angles.length < 2) return 0;
    let maxGap = 0;
    for (let i = 0; i < angles.length; i++) {
      const a = angles[i];
      const b = angles[(i + 1) % angles.length] + (i + 1 === angles.length ? Math.PI * 2 : 0);
      maxGap = Math.max(maxGap, b - a);
    }
    return Math.PI * 2 - maxGap;
  }

  function isRaidShipEncircled(ship = getShipPosition()) {
    if (!isInRaidMap() || !ship) return false;
    return isShipEncircledByNpcs(ship);
  }

  /** Encircle / pack surround — works on standard maps and raid (shared geometry). */
  function isShipEncircledByNpcs(ship = getShipPosition()) {
    if (!ship) return false;
    const close = listNpcs(RAID_ENCIRCLE_CLOSE_R);
    if (close.length < RAID_ENCIRCLE_MIN_NPCS) return false;
    // 4+ close = packed (was MIN+2 with MIN=3 → 5).
    if (close.length >= RAID_ENCIRCLE_MIN_NPCS + 2) return true;
    const spread = getRaidAngularSpread(ship, close);
    // Partial surround / flanking: fire sooner so breakout is decisive (mac46).
    return spread >= Math.PI * 0.65;
  }

  function needsRaidWaveBreakout(ship = getShipPosition()) {
    if (!isInRaidMap() || !ship || isRaidHealActive()) return false;
    if (isRaidWaveRepositionActive()) return true;
    return isRaidShipEncircled(ship);
  }

  /**
   * Standard-map light breakout: encircled pack or stuck in a map corner while orbiting.
   * Reuses encircle detection + a simplified getRaidBreakoutPoint-style step (no raid FSM).
   */
  function needsStandardOrbitBreakout(ship = getShipPosition()) {
    if (isInRaidMap() || !ship || isRaidHealActive()) return false;
    if (!AUTO.modeOrbit || AUTO.currentTask !== "combat") return false;
    if (isShipEncircledByNpcs(ship)) return true;
    if (AUTO.orbitStuckSince && Date.now() - AUTO.orbitStuckSince >= (AUTO.orbitCornerEscapeMs || 1400)) {
      return true;
    }
    if (isNearMapBoundary(ship.x, ship.y, 80) && listNpcs(RAID_ENCIRCLE_CLOSE_R).length >= 2) {
      return true;
    }
    return false;
  }

  /** Lateral escape on standard maps — away from swarm, toward open space / map center. */
  function getStandardBreakoutPoint(ship) {
    const { w, h } = getMapBounds();
    const center = {
      x: w ? w * 0.5 : ship.x,
      y: h ? h * 0.5 : ship.y,
    };
    const all = listNpcs(0);
    const swarm = getRaidSwarmCentroid(all.length ? all : null);
    const fireRange = getPlayerFireRange();

    let away = Math.atan2(ship.y - swarm.y, ship.x - swarm.x);
    if (!Number.isFinite(away)) {
      away = Math.atan2(ship.y - center.y, ship.x - center.x) || 0;
    }
    const dir = AUTO.raidWaveEscapeDir || AUTO.orbitDirection || 1;
    away += dir * 0.55;

    // Prefer escaping toward map center when corner-trapped.
    if (isNearMapBoundary(ship.x, ship.y, 60)) {
      const toCenter = Math.atan2(center.y - ship.y, center.x - ship.x);
      away = away * 0.35 + toCenter * 0.65;
    }

    const step = Math.min(RAID_BREAKOUT_STEP, fireRange * 0.85 + 120);
    const candidates = [];
    for (const bias of [0, 0.45, -0.45, 0.9, -0.9, 1.35, -1.35]) {
      const ang = away + bias;
      const raw = clampToPlayArea(ship.x + Math.cos(ang) * step, ship.y + Math.sin(ang) * step);
      const threat = getNearestNpcDistance(raw.x, raw.y);
      const clearance = boundaryClearanceScore(raw.x, raw.y);
      const towardSwarm =
        (raw.x - ship.x) * (swarm.x - ship.x) + (raw.y - ship.y) * (swarm.y - ship.y);
      const score = threat + clearance * 0.35 - (towardSwarm > 0 ? 140 : 0);
      candidates.push({ x: raw.x, y: raw.y, score });
    }
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (!best) {
      return clampToPlayArea(ship.x + Math.cos(away) * step, ship.y + Math.sin(away) * step);
    }
    return { x: best.x, y: best.y };
  }

  /**
   * Light standard-map breakout: lateral step, keep shooting, then resume applyCombatOrbit.
   * Does not clear combat task / does not thrash raid orbit.
   */
  function driveStandardOrbitBreakout(input, ship, npc) {
    if (!input || !ship || !needsStandardOrbitBreakout(ship)) return false;

    if (!AUTO.raidWaveEscapeDir) AUTO.raidWaveEscapeDir = Math.random() < 0.5 ? 1 : -1;
    const encircled = isShipEncircledByNpcs(ship);
    const breakout = getStandardBreakoutPoint(ship);
    moveViaMinimap(breakout.x, breakout.y);
    AUTO.orbitStuckSince = 0;

    if (npc) {
      AUTO.taskTargetId = npc.id;
      AUTO.combatTargetId = npc.id;
      AUTO.combatFocusId = npc.id;
      if (getGameState()?.lockedTargetId !== npc.id) {
        setLockedTarget(npc.id);
        input.notifyPlayerLocked?.(npc.id);
      }
      engageNpc(npc.id);
      input.syncAttackSession?.();
    }

    setStatus(
      encircled
        ? `Orbita: esco dall'accerchiamento (${Math.round(getNearestNpcDistance(ship.x, ship.y))}m)`
        : "Orbita: escape angolo / trappola mappa"
    );
    return true;
  }

  /**
   * Legacy outer combat ring (~560m). Not used for arrive anymore — arrive is portal
   * safe/center (PORTAL_HEAL_CENTER_DIST / in_safe_zone). Kept for docs/hysteresis context.
   */
  const PORTAL_DRIFT_OUTER_RING_DIST = 560;
  /** Resume migrate only after leaving this ring (hysteresis vs safe-center arrive). */
  const PORTAL_DRIFT_RESUME_DIST = 780;
  /** Max soft-hold step toward portal (longer leg = fewer retargets; laser clamp still applies). */
  const PORTAL_DRIFT_STEP = 820;
  /** Prolonged heading hold before a soft retarget (human mouse-hold, not minimap spam). */
  const PORTAL_DRIFT_MIGRATE_HOLD_MS = 2650;
  /** Blend weight keeping prior heading vs portal vector (higher = more linear). */
  const PORTAL_DRIFT_HEADING_KEEP = 0.86;
  /** Soft / marked peak lateral wobble (irregular stretches; often 0 = straight). */
  const PORTAL_DRIFT_WOBBLE_SOFT_MAX = 16;
  const PORTAL_DRIFT_WOBBLE_MARKED_MAX = 44;

  /**
   * Irregular portal-drift lateral stretch: sometimes straight (amp=0), sometimes
   * near-imperceptible, sometimes slightly marked. Hold length + side change
   * irregularly — never alternating L/R on a fixed bucket clock.
   */
  function refreshPortalDriftWobbleState() {
    const now = Date.now();
    if (AUTO.portalDriftWobbleUntil && now < AUTO.portalDriftWobbleUntil) return;
    const roll = Math.random();
    let amp = 0;
    let holdMs;
    if (roll < 0.4) {
      // Straight stretch — longer holds feel smoother / less twitchy.
      amp = 0;
      holdMs = randBetween(2400, 5200);
    } else if (roll < 0.78) {
      // Nearly imperceptible lateral bias.
      amp = randBetween(4, PORTAL_DRIFT_WOBBLE_SOFT_MAX);
      holdMs = randBetween(1600, 3400);
    } else {
      // Slightly more marked oscillation (still soft).
      amp = randBetween(PORTAL_DRIFT_WOBBLE_SOFT_MAX + 4, PORTAL_DRIFT_WOBBLE_MARKED_MAX);
      holdMs = randBetween(1200, 2800);
    }
    // Prefer keeping the same side across stretches (~60%) so path doesn't flip-flop.
    if (amp > 0 && Math.random() >= 0.6) {
      AUTO.portalDriftWobbleSide = Math.random() < 0.5 ? 1 : -1;
    } else if (!AUTO.portalDriftWobbleSide) {
      AUTO.portalDriftWobbleSide = Math.random() < 0.5 ? 1 : -1;
    }
    AUTO.portalDriftWobbleAmp = amp;
    AUTO.portalDriftWobbleUntil = now + holdMs;
  }

  /**
   * Portal drift (opt-in, standard maps): independent from Orbita.
   * Migrate toward nearest allied portal CENTER / safe zone without abandoning sticky fire range.
   * Works with orbit ON or OFF — only requires combat sticky + drift toggle.
   * Arrived + Orbit OFF: hold still inside safe/center and keep laser on sticky.
   * Arrived + Orbit ON: release so applyCombatOrbit can kite around sticky near portal
   * (still inside safe hysteresis — do NOT re-hold at center).
   * Do NOT treat the ~560m outer ring as arrived — NPCs can still hurt there.
   */
  function getPortalDriftRetreatPortal(ship) {
    if (!AUTO.orbitPortalDrift || isInRaidMap() || !ship) return null;
    const portal = findNearestFriendlyPortal({ preferSafeBase: false });
    if (!portal) return null;
    // Same safe signal as heal / coffee-admin hold (not PORTAL_DRIFT_OUTER_RING_DIST).
    if (isInSafeZone() || isAtFriendlyPortalHealCenter(ship)) {
      AUTO.portalDriftArrived = true;
    } else if (portal.dist >= PORTAL_DRIFT_RESUME_DIST) {
      AUTO.portalDriftArrived = false;
    }
    if (AUTO.portalDriftArrived) return null;
    return portal;
  }

  /**
   * Owns movement while migrating, or while holding at portal after arrival (Orbit OFF only).
   * Returns true when this path owns the tick (caller keeps engage/shoot on sticky).
   */
  function drivePortalDriftRetreat(ship, npc) {
    if (!AUTO.orbitPortalDrift || isInRaidMap() || !ship || !npc) return false;

    // First-hit gate: some NPCs never follow unless wounded. Keep engaging in
    // laser range until sticky is hit (or timeout) before migrating to portal.
    const fireRangeEarly = getPlayerFireRange() || 635;
    if (npc.dist <= fireRangeEarly * 1.02) {
      noteCombatEngageStart(npc.id);
      updateCombatOrbitEngagement(npc);
      if (!hasStickyFirstHitOrTimeout(npc)) {
        return false;
      }
    } else {
      // Out of laser: approach first — never portal-migrate before first shot chance.
      return false;
    }

    const migratePortal = getPortalDriftRetreatPortal(ship);
    const fireRange = fireRangeEarly;
    const maxFire = fireRange * 0.95;

    // Safe/center reached:
    // - Orbit OFF → hold still (drift-only park) and keep attacking.
    // - Orbit ON  → release to applyCombatOrbit (orbit must work at portal).
    if (AUTO.portalDriftArrived) {
      if (AUTO.modeOrbit) return false;
      if (npc.dist <= fireRange * 1.02) {
        clearCombatMoveTarget(getInputSystem());
        AUTO.lastMinimapTarget = null;
        setStatus(
          `Deriva portale: fermo in safe, fuoco su ${npc.name} (${Math.round(npc.dist)}m)`
        );
        return true;
      }
      // Sticky left laser — release so approach can close; hysteresis keeps arrive until resume.
      return false;
    }

    if (!migratePortal) return false;

    // Ideal: portal center when sticky can still be shot from there; else closest in-band point.
    const portal = migratePortal;
    const dNpcPortal = Math.hypot(portal.x - npc.x, portal.y - npc.y);
    let idealX;
    let idealY;
    if (dNpcPortal <= maxFire) {
      idealX = portal.x;
      idealY = portal.y;
    } else {
      const a = Math.atan2(portal.y - npc.y, portal.x - npc.x);
      idealX = npc.x + Math.cos(a) * maxFire;
      idealY = npc.y + Math.sin(a) * maxFire;
    }

    const toIdealDx = idealX - ship.x;
    const toIdealDy = idealY - ship.y;
    const toIdealDist = Math.hypot(toIdealDx, toIdealDy) || 1;
    if (toIdealDist < 72) {
      // Already on ideal — avoid micro-step spam while still migrating (pre-arrive).
      clearCombatMoveTarget(getInputSystem());
      return true;
    }

    // Soft continuous migrate (gameplay setMoveTarget = prolonged mouse-hold feel):
    // longer heading holds, almost-linear blend toward portal, irregular soft wobble.
    // Prefer setMoveTargetDirect over minimap click spam; laser stand-off always wins.
    const held = AUTO.lastMinimapTarget;
    const heldAge = Date.now() - (AUTO.lastMinimapMoveAt || 0);
    if (held && heldAge < PORTAL_DRIFT_MIGRATE_HOLD_MS) {
      const rem = distance(ship.x, ship.y, held.x, held.y);
      if (rem > (AUTO.arriveDistance || 50) + 36) {
        // Re-assert same soft hold if the engine dropped moveTarget; no new click.
        const input = getInputSystem();
        const mt = input?.moveTarget;
        if (
          !mt ||
          mt.x == null ||
          distance(mt.x, mt.y, held.x, held.y) > 110
        ) {
          setMoveTargetDirect(input, held.x, held.y);
        }
        const outerHintHold =
          portal.dist > PORTAL_DRIFT_OUTER_RING_DIST
            ? `portale ~${Math.round(portal.dist)}m`
            : `verso safe ~${Math.round(portal.dist)}m`;
        setStatus(
          `Deriva portale: migro in safe (${Math.round(npc.dist)}m laser, ${outerHintHold})`
        );
        return true;
      }
    }

    const step = Math.min(PORTAL_DRIFT_STEP, Math.max(280, toIdealDist));
    let dirX = toIdealDx / toIdealDist;
    let dirY = toIdealDy / toIdealDist;
    if (held) {
      const curDx = held.x - ship.x;
      const curDy = held.y - ship.y;
      const curLen = Math.hypot(curDx, curDy);
      if (curLen > 48) {
        const keep = PORTAL_DRIFT_HEADING_KEEP;
        const bx = (curDx / curLen) * keep + dirX * (1 - keep);
        const by = (curDy / curLen) * keep + dirY * (1 - keep);
        const bLen = Math.hypot(bx, by) || 1;
        dirX = bx / bLen;
        dirY = by / bLen;
      }
    }

    // Non-periodic human wobble: refresh amp/side on irregular stretches (often zero).
    refreshPortalDriftWobbleState();
    const wobbleAmp = Number(AUTO.portalDriftWobbleAmp) || 0;
    const side = AUTO.portalDriftWobbleSide >= 0 ? 1 : -1;
    let tx = ship.x + dirX * step - dirY * side * wobbleAmp;
    let ty = ship.y + dirY * step + dirX * side * wobbleAmp;

    // Hard clamp: never leave effective fire / stand-off of sticky.
    let dNpc = Math.hypot(tx - npc.x, ty - npc.y);
    if (dNpc > maxFire) {
      const a = Math.atan2(ty - npc.y, tx - npc.x);
      tx = npc.x + Math.cos(a) * maxFire;
      ty = npc.y + Math.sin(a) * maxFire;
    } else if (dNpc < fireRange * 0.72 && npc.dist >= fireRange * 0.72) {
      // Don't dive inward toward sticky while portal-migrating (stand-off preference).
      const a = Math.atan2(ty - npc.y, tx - npc.x);
      const floorR = Math.min(maxFire, Math.max(npc.dist, fireRange * 0.82));
      tx = npc.x + Math.cos(a) * floorR;
      ty = npc.y + Math.sin(a) * floorR;
    }

    const safe = clampToPlayArea(tx, ty);
    const input = getInputSystem();
    setMoveTargetDirect(input, safe.x, safe.y);
    AUTO.lastMinimapTarget = { x: safe.x, y: safe.y };
    AUTO.lastMinimapMoveAt = Date.now();
    const outerHint =
      portal.dist > PORTAL_DRIFT_OUTER_RING_DIST
        ? `portale ~${Math.round(portal.dist)}m`
        : `verso safe ~${Math.round(portal.dist)}m`;
    setStatus(
      `Deriva portale: migro in safe (${Math.round(npc.dist)}m laser, ${outerHint})`
    );
    return true;
  }

  /**
   * Soft play-area clamp that preserves NPC-centered orbit radius.
   * Axis clamp alone turns the stand-off circle into an oval near map edges /
   * portals; reproject onto the ring and slide angle if needed.
   */
  function softClampStdOrbitCircle(x, y, npc, radius) {
    if (!npc || !(radius > 1)) return clampToPlayArea(x, y);
    const { w, h } = getMapBounds();
    const margin = AUTO.mapSafeMargin || 100;
    if (!w || !h) return { x, y };

    const inBounds = (px, py) =>
      px >= margin && px <= w - margin && py >= margin && py <= h - margin;

    const place = (ang, r) => ({
      x: npc.x + Math.cos(ang) * r,
      y: npc.y + Math.sin(ang) * r,
    });

    let ang = Math.atan2(y - npc.y, x - npc.x);
    let pt = place(ang, radius);
    if (inBounds(pt.x, pt.y)) return pt;

    // Slide along the circle toward map center — keep radius, change angle.
    const centerAng = Math.atan2(h * 0.5 - npc.y, w * 0.5 - npc.x);
    let dToCenter = centerAng - ang;
    while (dToCenter > Math.PI) dToCenter -= Math.PI * 2;
    while (dToCenter < -Math.PI) dToCenter += Math.PI * 2;
    let best = null;
    let bestAbs = Infinity;
    for (let i = 0; i <= 28; i++) {
      const t = i / 28;
      const candidates = [
        ang + dToCenter * t,
        ang - Math.sign(dToCenter || 1) * (Math.PI * 2 - Math.abs(dToCenter)) * t,
      ];
      for (const a of candidates) {
        const cand = place(a, radius);
        if (!inBounds(cand.x, cand.y)) continue;
        let da = a - ang;
        while (da > Math.PI) da -= Math.PI * 2;
        while (da < -Math.PI) da += Math.PI * 2;
        const abs = Math.abs(da);
        if (abs < bestAbs) {
          bestAbs = abs;
          best = cand;
        }
      }
    }
    if (best) return best;

    // Last resort: gently shrink radius (never squash only one axis).
    for (let scale = 0.96; scale >= 0.72; scale -= 0.04) {
      const cand = place(ang, radius * scale);
      if (inBounds(cand.x, cand.y)) return cand;
      const clamped = clampToPlayArea(cand.x, cand.y);
      const r2 = Math.hypot(clamped.x - npc.x, clamped.y - npc.y);
      if (r2 >= radius * 0.7) {
        const a2 = Math.atan2(clamped.y - npc.y, clamped.x - npc.x);
        const reproj = place(a2, Math.max(r2, radius * 0.72));
        if (inBounds(reproj.x, reproj.y)) return reproj;
      }
    }
    return clampToPlayArea(pt.x, pt.y);
  }

  function resetRaidDangerState() {
    AUTO.raidDangerMode = RAID_DANGER_MODE.CRUISE;
    AUTO.raidDangerModeSince = 0;
    AUTO.raidDangerLastEffectiveHp = null;
    AUTO.raidDangerHitAt = 0;
    AUTO.raidDangerSafeSince = 0;
    AUTO.raidDangerBreakoutClearSince = 0;
  }

  function isRaidDangerBreakoutMode() {
    return false;
  }

  function isRaidDangerCautiousMode() {
    return false;
  }

  function countRaidCloseAttackers(ship = getShipPosition()) {
    if (!ship) return 0;
    const fireRange = getPlayerFireRange();
    let n = 0;
    for (const npc of listNpcs(fireRange + 120)) {
      if (isNpcAttackingPlayer(npc.id)) n += 1;
    }
    return n;
  }

  function detectRaidSignificantHit() {
    const snap = getPlayerHpSnapshot();
    const effective = snap.effective;
    const prev = AUTO.raidDangerLastEffectiveHp;
    AUTO.raidDangerLastEffectiveHp = effective;
    if (prev == null || snap.totalMax <= 0) return false;
    const drop = prev - effective;
    if (drop <= 0) return false;
    const pctDrop = (drop / snap.totalMax) * 100;
    return drop >= RAID_DANGER_HP_DROP_ABS || pctDrop >= RAID_DANGER_HP_DROP_PCT;
  }

  function assessRaidDanger(ship = getShipPosition()) {
    const encircled = isRaidShipEncircled(ship);
    const underFire = isRaidShipUnderFire(ship);
    const closeCount = listNpcs(RAID_ENCIRCLE_CLOSE_R).length;
    const attackers = countRaidCloseAttackers(ship);
    const justHit = detectRaidSignificantHit();
    const wideOrbit = isRaidWideOrbitHealthy(ship);
    const waveReposition = isRaidWaveRepositionActive();
    return {
      encircled,
      underFire,
      closeCount,
      attackers,
      justHit,
      wideOrbit,
      waveReposition,
      heavySurround:
        encircled ||
        closeCount >= RAID_DANGER_HEAVY_SURROUND ||
        attackers >= 3,
    };
  }

  function setRaidDangerMode(mode, reason = "") {
    if (AUTO.raidDangerMode === mode) return;
    AUTO.raidDangerMode = mode;
    AUTO.raidDangerModeSince = Date.now();
    void reason;
  }

  /** Dead: danger FSM removed from raid combat hot path (Story 3 restore). */
  function getRaidDangerOrbitModifiers() {
    return { radiusScale: 1, stepScale: 1, widen: false };
  }

  /** Dead: danger FSM removed from raid combat hot path (Story 3 restore). */
  function updateRaidDangerState(ship = getShipPosition()) {
    void ship;
    return RAID_DANGER_MODE.CRUISE;
  }

  function getRaidDangerStatusSuffix() {
    return "";
  }

  function scoreRaidThreatTarget(npc, ship) {
    if (!npc || !ship) return -Infinity;
    const fireRange = getPlayerFireRange();
    let score = -npc.dist * 1.4;
    if (isNpcAttackingPlayer(npc.id)) score += 560;
    if (npc.dist <= fireRange) score += 300;
    else if (npc.dist <= fireRange * 1.2) score += 140;
    else score -= (npc.dist - fireRange * 1.2) * 1.05;

    const state = getGameState()?.npcs?.get?.(npc.id);
    if (state?.max_hp > 0 && state.hp != null && state.hp < state.max_hp - 0.5) {
      score += 45;
    }
    return score;
  }

  function pickRaidThreatCombatTarget(preferredId) {
    const ship = getShipPosition();
    const all = listNpcs(0);
    if (!all.length || !ship) return null;

    let best = null;
    let bestScore = -Infinity;
    for (const npc of all) {
      const score = scoreRaidThreatTarget(npc, ship);
      if (score > bestScore) {
        bestScore = score;
        best = npc;
      }
    }
    if (!best) return all[0] || null;

    // Keep preferred only when still top threat — never sticky-lock a distant edge pick
    // while nearer NPCs are attacking or in laser range.
    if (preferredId && isNpcAllowedForCombat(preferredId) && preferredId !== best.id) {
      const preferred = getNpcEntry(preferredId);
      if (preferred) {
        const prefScore = scoreRaidThreatTarget(preferred, ship);
        const nearerAttacker = all.find(
          (n) => n.id !== preferred.id && isNpcAttackingPlayer(n.id) && n.dist < preferred.dist - 60
        );
        const nearerInRange = all.find(
          (n) => n.id !== preferred.id && n.dist <= getPlayerFireRange() + 25 && n.dist < preferred.dist - 100
        );
        if (!nearerAttacker && !nearerInRange && prefScore + 90 >= bestScore) return preferred;
      }
    }
    return best;
  }

  function scoreRaidEdgeTarget(npc, ship, swarm, allNpcs) {
    if (!npc || !ship) return -Infinity;
    const fireRange = getPlayerFireRange();
    const neighbors = countRaidNeighbors(npc, allNpcs);
    const fromSwarm = distance(npc.x, npc.y, swarm.x, swarm.y);
    // Prefer edge of pack (far from centroid, few neighbors), still reachable
    const distPenalty = npc.dist > fireRange * 1.85 ? (npc.dist - fireRange * 1.85) * 0.35 : 0;
    const tooClosePenalty = npc.dist < 180 ? (180 - npc.dist) * 1.2 : 0;
    // Prefer targets on our side of the swarm (pull toward us, not through pack)
    const shipToSwarm = Math.atan2(ship.y - swarm.y, ship.x - swarm.x);
    const npcToSwarm = Math.atan2(npc.y - swarm.y, npc.x - swarm.x);
    const align =
      Math.cos(shipToSwarm) * Math.cos(npcToSwarm) + Math.sin(shipToSwarm) * Math.sin(npcToSwarm);
    return fromSwarm * 1.15 - neighbors * 95 - distPenalty - tooClosePenalty + align * 140 - npc.dist * 0.08;
  }

  function pickRaidEdgeCombatTarget(preferredId) {
    const ship = getShipPosition();
    const all = listNpcs(0);
    if (!all.length) return null;

    const swarm = getRaidSwarmCentroid(all);
    const preferBreakout = needsRaidWaveBreakout(ship) && !isRaidShipUnderFire(ship);

    // Keep preferred only if it's already a decent edge pick (or unique)
    if (preferredId && isNpcAllowedForCombat(preferredId)) {
      const preferred = getNpcEntry(preferredId);
      if (preferred) {
        if (!preferBreakout || all.length <= 2) return preferred;
        const prefScore = scoreRaidEdgeTarget(preferred, ship, swarm, all);
        const bestOther = all
          .filter((n) => n.id !== preferred.id)
          .map((n) => scoreRaidEdgeTarget(n, ship, swarm, all))
          .reduce((m, s) => Math.max(m, s), -Infinity);
        if (prefScore + 60 >= bestOther) return preferred;
      }
    }

    let best = null;
    let bestScore = -Infinity;
    for (const npc of all) {
      const score = scoreRaidEdgeTarget(npc, ship, swarm, all);
      if (score > bestScore) {
        bestScore = score;
        best = npc;
      }
    }
    return best || all[0] || null;
  }

  /** True when a nearer NPC should pull focus off a distant locked edge target. */
  function hasCloserRaidThreatThan(preferredId) {
    if (!preferredId || !isInRaidMap()) return false;
    const preferred = getNpcEntry(preferredId);
    const nearest = listNpcs(0)[0];
    if (!preferred || !nearest || nearest.id === preferred.id) return false;
    if (nearest.dist >= preferred.dist - 100) return false;
    if (isNpcAttackingPlayer(nearest.id)) return true;
    const fireRange = getPlayerFireRange();
    if (nearest.dist <= fireRange + 30) return true;
    return listNpcs(fireRange + 80).length >= 2;
  }

  /**
   * Hybrid raid targeting (unused on hot path — resolveRaidCombatTarget is Story 3 nearest).
   * Kept as nearest for any residual callers.
   */
  function pickRaidCombatTarget(preferredId) {
    return resolveRaidCombatTarget(preferredId);
  }

  /** Lateral escape point away from swarm, clamped to cruise/support ring. */
  function getRaidBreakoutPoint(ship) {
    const center = getRaidCenter();
    const all = listNpcs(0);
    const swarm = getRaidSwarmCentroid(all.length ? all : null);
    const turretR = getRaidTurretRange() * 0.72;
    const fireRange = getPlayerFireRange();
    const encircled = isShipEncircledByNpcs(ship);
    // Decisive step when packed; normal step otherwise.
    const breakStep = encircled ? RAID_BREAKOUT_STEP * 1.25 : RAID_BREAKOUT_STEP;

    let away = Math.atan2(ship.y - swarm.y, ship.x - swarm.x);
    if (!Number.isFinite(away)) {
      away = Math.atan2(ship.y - center.y, ship.x - center.x) || 0;
    }
    const dir = AUTO.raidWaveEscapeDir || 1;
    away += dir * 0.55;

    // Prefer largest open angular gap when encircled (same idea as cargo breakout).
    if (encircled) {
      const close = listNpcs(RAID_ENCIRCLE_CLOSE_R);
      if (close.length >= RAID_ENCIRCLE_MIN_NPCS) {
        const angles = close
          .map((n) => Math.atan2(n.y - ship.y, n.x - ship.x))
          .sort((a, b) => a - b);
        let maxGap = 0;
        let gapMid = away;
        for (let i = 0; i < angles.length; i++) {
          const a = angles[i];
          const b =
            angles[(i + 1) % angles.length] +
            (i + 1 === angles.length ? Math.PI * 2 : 0);
          const gap = b - a;
          if (gap > maxGap) {
            maxGap = gap;
            gapMid = a + gap * 0.5;
          }
        }
        if (maxGap >= 0.45) away = gapMid;
      }
    }

    // mac46: when encircled, escape is ship-relative + decisive — do not ring-clamp
    // first (that caused thrash / "crisis" before leaving the pack).
    if (encircled) {
      const candidates = [];
      for (const bias of [0, 0.35, -0.35, 0.75, -0.75, 1.15, -1.15]) {
        const ang = away + bias;
        const raw = clampToPlayArea(
          ship.x + Math.cos(ang) * breakStep,
          ship.y + Math.sin(ang) * breakStep
        );
        const threat = getNearestNpcDistance(raw.x, raw.y);
        const towardSwarm =
          (raw.x - ship.x) * (swarm.x - ship.x) + (raw.y - ship.y) * (swarm.y - ship.y);
        const r = distance(raw.x, raw.y, center.x, center.y);
        // Prefer open space + staying inside support zone when possible.
        const support = getRaidOrbitSupportMax();
        const supportBonus = r <= support ? 40 : r <= support * 1.08 ? 0 : -80;
        const score = threat + supportBonus - (towardSwarm > 0 ? 160 : 0);
        candidates.push({ x: raw.x, y: raw.y, score });
      }
      candidates.sort((a, b) => b.score - a.score);
      if (candidates[0]) return { x: candidates[0].x, y: candidates[0].y };
      return clampToPlayArea(
        ship.x + Math.cos(away) * breakStep,
        ship.y + Math.sin(away) * breakStep
      );
    }

    const shipR = Math.hypot(ship.x - center.x, ship.y - center.y) || turretR;
    const cruiseCap = getRaidOrbitCruiseMax();
    const desiredR = clamp(
      Math.max(shipR, turretR * 0.62, getNearestNpcDistance(ship.x, ship.y) + fireRange * 0.55),
      turretR * 0.48,
      Math.min(cruiseCap, Math.max(turretR * 0.88, fireRange + 40))
    );

    const candidates = [];
    for (const bias of [0, 0.4, -0.4, 0.85, -0.85, 1.3, -1.3]) {
      const ang = away + bias;
      for (const radius of [desiredR, Math.max(desiredR, turretR * 0.78), shipR + breakStep * 0.55]) {
        const pt = clampToPlayArea(center.x + Math.cos(ang) * radius, center.y + Math.sin(ang) * radius);
        const threat = getNearestNpcDistance(pt.x, pt.y);
        const r = distance(pt.x, pt.y, center.x, center.y);
        const ringPenalty = Math.abs(r - turretR * 0.7) * 0.25;
        const towardSwarm =
          (pt.x - ship.x) * (swarm.x - ship.x) + (pt.y - ship.y) * (swarm.y - ship.y);
        const score = threat - ringPenalty - (towardSwarm > 0 ? 120 : 0);
        candidates.push({ x: pt.x, y: pt.y, score, threat });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (!best) {
      return clampToPlayArea(
        ship.x + Math.cos(away) * breakStep,
        ship.y + Math.sin(away) * breakStep
      );
    }

    const dist = distance(ship.x, ship.y, best.x, best.y);
    if (dist <= breakStep) return { x: best.x, y: best.y };
    const t = breakStep / dist;
    return clampToPlayArea(ship.x + (best.x - ship.x) * t, ship.y + (best.y - ship.y) * t);
  }

  function normalizeRaidAngle(a) {
    let x = a;
    while (x > Math.PI) x -= Math.PI * 2;
    while (x < -Math.PI) x += Math.PI * 2;
    return x;
  }

  function getRaidOrbitSoftMax() {
    return getRaidTurretRange() * RAID_ORBIT_TURRET_SOFT;
  }

  /** Story 3 support-zone ceiling (turret × 0.78) — primary soft clamp for raid kite. */
  function getRaidOrbitSupportMax() {
    return getRaidTurretRange() * RAID_ORBIT_SUPPORT_FRAC;
  }

  /** Preferred cruise ceiling — inside Story 3 support zone, never softMax wall. */
  function getRaidOrbitCruiseMax() {
    const supportMax = getRaidOrbitSupportMax();
    if (isRaidOrbitExpandActive()) return Math.min(getRaidOrbitSoftMax(), supportMax * 1.08);
    return supportMax * RAID_ORBIT_CRUISE_FRAC;
  }

  /**
   * Preferred wide tower-ring radius (kite edge vs nearest threats).
   * Cruise inside softMax — soft preference, not a wall to ride each tick.
   */
  function getRaidWideOrbitRadius(ship, npc = null) {
    const center = getRaidCenter();
    const supportMax = getRaidOrbitSupportMax();
    const cruiseMax = getRaidOrbitCruiseMax();
    const softMax = getRaidOrbitSoftMax();
    const shipR = ship ? distance(ship.x, ship.y, center.x, center.y) : cruiseMax * 0.95;
    const fireRange = getPlayerFireRange();
    const preferred = fireRange - (AUTO.raidOrbitPreferredInset ?? 8);
    // Prefer current radius while under cruise — do not chase softMax
    let want = Math.min(Math.max(shipR, cruiseMax * 0.78), cruiseMax);

    const refineFromNpc = (n) => {
      if (!n) return;
      const npcR = distance(n.x, n.y, center.x, center.y);
      const d = ship ? distance(ship.x, ship.y, n.x, n.y) : preferred;
      // Outer kite stand-off ≈ laser preferred (hit them; they struggle to hit us)
      want = Math.max(want, Math.min(npcR + preferred * 0.95, cruiseMax), cruiseMax * 0.7);
      if (d < preferred - 20) {
        // Slightly too close → soft outward bias (may briefly exceed cruise)
        want = Math.min(
          Math.max(want, shipR + Math.min(preferred - d, 90)),
          Math.min(softMax * 0.96, cruiseMax * 1.08)
        );
      }
      if (d > fireRange + 30 && shipR > npcR + preferred * 0.45) {
        // Out of our laser reach → soft inward to regain shots, stay outer-ish
        want = Math.min(want, Math.max(npcR + preferred * 0.85, cruiseMax * 0.55));
      }
    };

    if (npc) {
      refineFromNpc(npc);
    } else {
      const nearestNpc = listNpcs(fireRange + 200)[0];
      if (nearestNpc) refineFromNpc(nearestNpc);
    }

    const hi = isRaidOrbitExpandActive()
      ? Math.min(softMax, cruiseMax * 1.12)
      : cruiseMax;
    return clamp(want, supportMax * 0.42, hi);
  }

  /**
   * Smooth circular waypoint around the tower (δθ ≪ π/2).
   * Primary raid kite geometry — path center = tower, NPC is target/bias only.
   */
  function getRaidTowerOrbitPoint(npc, options = {}) {
    const ship = getShipPosition();
    const center = getRaidCenter();
    if (!ship) {
      return { x: npc?.x || center.x, y: npc?.y || center.y };
    }

    const dir = AUTO.orbitDirection || 1;
    const baseR = options.radius ?? getRaidWideOrbitRadius(ship, npc);
    const R = baseR * (options.radiusScale ?? 1);
    const shipAng = Math.atan2(ship.y - center.y, ship.x - center.x);
    const shipR = distance(ship.x, ship.y, center.x, center.y) || R;

    // Prefer continuous phase on the tower ring; resync if ship drifted far from phase
    let phase = AUTO.orbitPhaseAngle;
    if (!Number.isFinite(phase)) {
      phase = Number.isFinite(shipAng) ? shipAng : 0;
    } else {
      const err = normalizeRaidAngle(shipAng - phase);
      if (Math.abs(err) > 0.85) phase = shipAng;
      else phase += err * 0.2;
    }

    const arcLen =
      options.arcLen ??
      (AUTO.raidOrbitArcLength || 125) * (1 + randBetween(0, 0.06));
    const maxStep = AUTO.raidOrbitArcRadians || 0.2;
    const deltaTheta = clamp(arcLen / Math.max(R, 80), 0.06, maxStep);
    const stepScale = options.stepScale ?? 1;
    phase += dir * deltaTheta * stepScale;

    // Light continuous bias toward locked target when out of laser range (not an FSM)
    if (npc) {
      const fireRange = getPlayerFireRange();
      if (npc.dist > fireRange) {
        const threatAng = Math.atan2(npc.y - center.y, npc.x - center.x);
        const pull = normalizeRaidAngle(threatAng - phase);
        phase += clamp(pull, -0.07, 0.07) * 0.45;
      }
    }
    AUTO.orbitPhaseAngle = phase;

    // Soft radial settle: outside preferred → gentle inward spiral; inside → ease out
    const slack = AUTO.raidOrbitRecenterSlack || 48;
    let useR = R;
    if (shipR > R + slack) {
      useR = shipR - Math.min(shipR - R, Math.max(36, (shipR - R) * 0.3));
    } else if (shipR < R - slack) {
      useR = shipR + Math.min(R - shipR, arcLen * 0.85);
    } else {
      useR = shipR * 0.35 + R * 0.65;
    }

    const raw = {
      x: center.x + Math.cos(phase) * useR,
      y: center.y + Math.sin(phase) * useR,
    };
    const biased = biasRaidOrbitAwayFromForwardPack(ship, npc, raw.x, raw.y);
    if (options.skipClamp) return clampToPlayArea(biased.x, biased.y);
    return clampRaidOrbitPoint(biased.x, biased.y, npc);
  }

  function getRaidSafeOrbitApproachPoint(npc) {
    const ship = getShipPosition();
    const { fireRange } = getOrbitRadii(npc);
    if (!ship || !npc) return { x: npc?.x || 0, y: npc?.y || 0 };

    // Always approach on the tower ring — never dive onto an NPC-centered band.
    return getRaidTowerOrbitPoint(npc, {
      stepScale: npc.dist > fireRange ? 1.1 : 1,
    });
  }

  /**
   * Next point on the wide tower ring along the current orbit direction.
   * Used for retarget / approach so we stay on the kite arc instead of cutting inward.
   */
  function getRaidTangentialOrbitPoint(npc, options = {}) {
    return getRaidTowerOrbitPoint(npc, options);
  }

  /**
   * Single-mover encircle / wave breakout: lateral step via getRaidBreakoutPoint,
   * keep shooting, then hand control back to applyCombatOrbit when clear.
   * Does not clear combat task.
   */
  function driveRaidWaveBreakout(input, ship, npc) {
    if (!input || !ship || !needsRaidWaveBreakout(ship)) return false;

    if (!AUTO.raidWaveEscapeDir) AUTO.raidWaveEscapeDir = Math.random() < 0.5 ? 1 : -1;

    const encircled = isRaidShipEncircled(ship);
    const closeThreat = getNearestNpcDistance(ship.x, ship.y);
    // Already clear enough during wave grace → resume Story 3 orbit
    if (
      !encircled &&
      isRaidWaveRepositionActive() &&
      closeThreat > getPlayerFireRange() * 0.72 &&
      listNpcs(RAID_ENCIRCLE_CLOSE_R).length <= 1
    ) {
      AUTO.raidWaveRepositionUntil = 0;
      return false;
    }

    const breakout = getRaidBreakoutPoint(ship);
    // Escape = minimap only. Packed: force a fresh click (bypass soft interval/delta).
    AUTO.lastMinimapMoveAt = 0;
    AUTO.lastMinimapTarget = null;
    AUTO.orbitHumanHoldUntil = 0;
    moveViaMinimap(breakout.x, breakout.y);

    if (npc) {
      AUTO.taskTargetId = npc.id;
      AUTO.combatTargetId = npc.id;
      AUTO.combatFocusId = npc.id;
      if (getGameState()?.lockedTargetId !== npc.id) {
        setLockedTarget(npc.id);
        input.notifyPlayerLocked?.(npc.id);
      }
      engageNpc(npc.id);
      sustainRaidAttack(input);
    }

    setStatus(
      encircled
        ? `Raid: esco dall'accerchiamento (${Math.round(closeThreat)}m)`
        : `Raid: riposiziono a inizio onda (${Math.round(closeThreat)}m)`
    );
    return true;
  }

  /**
   * Dead helper: tower-ring kite removed from raid hot path.
   * Story 3 used applyCombatOrbit (NPC π/2); all callers redirected there.
   */
  function applyRaidCombatKite(npc) {
    return applyCombatOrbit(npc);
  }

  function isNpcMovingAwayFromPlayer(npcId) {
    const ship = getShipPosition();
    const npc = getNpcEntry(npcId);
    const pos = AUTO.npcLastPositions.get(npcId);
    if (!ship || !npc || !pos) return false;

    const moved = distance(pos.prevX, pos.prevY, pos.x, pos.y);
    if (moved < 10) return false;

    const prevDist = distance(ship.x, ship.y, pos.prevX, pos.prevY);
    return npc.dist > prevDist + 8;
  }

  function shouldChaseCombatTarget(npc, fireRange) {
    if (!npc) return false;
    if (isInRaidMap()) return npc.dist > fireRange;
    // Standard: close only when outside laser range. Never chase a fleeing NPC
    // while already in fire range — they come to you; diving causes needless hits.
    return npc.dist > fireRange;
  }

  function clearCombatMoveTarget(input) {
    const targetInput = input || getInputSystem();
    if (!targetInput) return;
    targetInput.clearMoveTarget?.();
    targetInput.moveTarget = null;
  }

  function boundaryClearanceScore(x, y) {
    const { w, h } = getMapBounds();
    const margin = (AUTO.mapSafeMargin || 100) + 40;
    if (!w || !h) return 9999;
    return Math.min(x - margin, w - margin - x, y - margin, h - margin - y);
  }

  function isNearMapBoundary(x, y, extra = 0) {
    return boundaryClearanceScore(x, y) < (AUTO.orbitBoundaryBuffer || 220) + extra;
  }

  function pickOrbitDirection(npc, ship) {
    const { minR, maxR } = getOrbitRadii(npc);
    const radialAngle = Math.atan2(ship.y - npc.y, ship.x - npc.x);
    const radius = clamp(Math.hypot(ship.x - npc.x, ship.y - npc.y), minR, maxR);
    let bestDir = AUTO.orbitDirection || 1;
    let bestScore = -Infinity;

    for (const dir of [1, -1]) {
      const angle = radialAngle + dir * (Math.PI / 2) + dir * (AUTO.orbitArcRadians || 0.1);
      const tx = npc.x + Math.cos(angle) * radius;
      const ty = npc.y + Math.sin(angle) * radius;
      const score = boundaryClearanceScore(tx, ty);
      if (score > bestScore) {
        bestScore = score;
        bestDir = dir;
      }
    }

    return bestDir;
  }

  function nudgeOrbitFromBoundary(tx, ty, ship, npc) {
    const { w, h } = getMapBounds();
    const margin = AUTO.mapSafeMargin || 100;
    const buffer = AUTO.orbitBoundaryBuffer || 220;
    let x = tx;
    let y = ty;
    const distFromNpc = npc ? Math.hypot(x - npc.x, y - npc.y) : 0;

    if (w && h && ship) {
      let shiftX = 0;
      let shiftY = 0;
      if (ship.x < margin + buffer) shiftX += (margin + buffer - ship.x) * 0.32;
      if (ship.x > w - margin - buffer) shiftX -= (ship.x - (w - margin - buffer)) * 0.32;
      if (ship.y < margin + buffer) shiftY += (margin + buffer - ship.y) * 0.32;
      if (ship.y > h - margin - buffer) shiftY -= (ship.y - (h - margin - buffer)) * 0.32;
      x += shiftX;
      y += shiftY;
    }

    if (npc && distFromNpc > 1) {
      const angle = Math.atan2(y - npc.y, x - npc.x);
      x = npc.x + Math.cos(angle) * distFromNpc;
      y = npc.y + Math.sin(angle) * distFromNpc;
    }

    return clampToPlayArea(x, y);
  }

  function applyOrbitCornerEscape(npc, ship) {
    const { w, h } = getMapBounds();
    const { maxR } = getOrbitRadii(npc);
    const cx = w ? w * 0.5 : ship.x;
    const cy = h ? h * 0.5 : ship.y;

    let dx = cx - ship.x;
    let dy = cy - ship.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;

    const radialAngle = Math.atan2(ship.y - npc.y, ship.x - npc.x);
    let escapeAngle = radialAngle + AUTO.orbitDirection * 0.22;
    if (isNearMapBoundary(ship.x, ship.y, 40)) {
      escapeAngle = Math.atan2(dy, dx) * 0.45 + radialAngle * 0.55;
    }

    const target = nudgeOrbitFromBoundary(
      npc.x + Math.cos(escapeAngle) * maxR,
      npc.y + Math.sin(escapeAngle) * maxR,
      ship,
      npc
    );

    // B: raid keeps session direction; non-raid may re-pick like Story 3
    if (!isInRaidMap()) {
      AUTO.orbitDirection = pickOrbitDirection(npc, ship);
    }
    AUTO.orbitStuckSince = 0;
    AUTO.orbitFlipAt = Date.now() + AUTO.orbitFlipIntervalMs;
    const safe =
      isInRaidMap() && !isRaidHealActive()
        ? softClampToRaidSupportZone(target.x, target.y)
        : target;
    moveViaMinimap(safe.x, safe.y);
    setStatus("Orbita: escape angolo mappa");
    return true;
  }

  function getPlayerLaserRange() {
    return AUTO.playerLaserRange || AUTO.attackRange || 650;
  }

  function getPlayerFireRange() {
    return getPlayerLaserRange() - (AUTO.playerLaserFireInset || 15);
  }

  function getNpcAttackRange(npc) {
    void npc;
    return AUTO.npcAttackRange || 650;
  }

  function getOrbitRadii(npc) {
    const playerRange = getPlayerLaserRange();
    const fireRange = getPlayerFireRange();
    const npcRange = getNpcAttackRange(npc);
    // Raid: use laser-edge insets (slightly farther kite). Non-raid unchanged.
    const inRaid = isInRaidMap();
    const outerInset = inRaid ? (AUTO.raidOrbitOuterInset ?? 4) : (AUTO.orbitOuterInset || 12);
    const innerInset = inRaid ? (AUTO.raidOrbitInnerInset ?? 32) : (AUTO.orbitInnerInset || 58);
    const preferredInset = inRaid
      ? (AUTO.raidOrbitPreferredInset ?? 5)
      : (AUTO.orbitPreferredInset || 18);
    const maxR = fireRange - outerInset;
    const minR = fireRange - innerInset;
    const preferred = fireRange - preferredInset;

    return {
      minR: clamp(minR, fireRange - 72, maxR - 16),
      maxR,
      preferred: clamp(preferred, minR, maxR),
      playerRange,
      fireRange,
      npcRange,
    };
  }

  /**
   * Stand-off floor used by cargo CLEARING waypoints (post-kill only).
   * Not used to diverge combat orbit when collectCargo toggle is ON.
   * Numbers @ laser 650: preferred≈630, maxR≈631, floor max(preferred, 620)≈630m.
   */
  function getCargoCombatSafeStandOff(npc = null) {
    const { minR, maxR, preferred } = getOrbitRadii(npc);
    const outer = Math.max(preferred, maxR * 0.98);
    return Math.max(outer, minR + 16, RAID_CARGO_CLEAR_NPC_FLOOR);
  }

  /**
   * Push a CLEARING/BREAKOUT waypoint outside living-NPC hit range.
   */
  function pushPointOutsideLivingNpcs(pt, floorR = null) {
    if (!pt) return pt;
    const floor = floorR != null ? floorR : getCargoCombatSafeStandOff();
    const threats = listNpcs(floor + 80);
    if (!threats.length) return pt;
    let x = pt.x;
    let y = pt.y;
    for (let pass = 0; pass < 4; pass++) {
      let moved = false;
      for (const n of threats) {
        const d = distance(x, y, n.x, n.y);
        if (d >= floor || d < 1e-3) continue;
        const ang = Math.atan2(y - n.y, x - n.x);
        x = n.x + Math.cos(ang) * floor;
        y = n.y + Math.sin(ang) * floor;
        moved = true;
      }
      if (!moved) break;
      if (isInRaidMap()) {
        const z = clampToRaidSupportZone(x, y);
        x = z.x;
        y = z.y;
      } else {
        const z = clampToPlayArea(x, y);
        x = z.x;
        y = z.y;
      }
    }
    return { x, y };
  }

  /**
   * Light raid-only orbit bias: when locked NPC is slightly behind and pack sits
   * in front, nudge the waypoint away from the swarm so micro-moves don't soft-hit.
   * No direction flip / no FSM — preserves tangential recovery.
   */
  function biasRaidOrbitAwayFromForwardPack(ship, npc, x, y) {
    if (!ship || !npc || !isInRaidMap()) return { x, y };
    const fireRange = getPlayerFireRange();
    const nearby = listNpcs(fireRange + 80);
    if (nearby.length < 2) return { x, y };

    const swarm = getRaidSwarmCentroid(nearby);
    const toNpcX = npc.x - ship.x;
    const toNpcY = npc.y - ship.y;
    const toSwarmX = swarm.x - ship.x;
    const toSwarmY = swarm.y - ship.y;
    const npcLen = Math.hypot(toNpcX, toNpcY) || 1;
    const swarmLen = Math.hypot(toSwarmX, toSwarmY) || 1;
    const behindDot =
      (toNpcX / npcLen) * (toSwarmX / swarmLen) + (toNpcY / npcLen) * (toSwarmY / swarmLen);
    if (behindDot >= -0.12) return { x, y };

    let forwardHits = 0;
    for (const n of nearby) {
      if (n.id === npc.id) continue;
      const fx = n.x - ship.x;
      const fy = n.y - ship.y;
      if (fx * toSwarmX + fy * toSwarmY > 0 && n.dist <= fireRange * 0.92) forwardHits += 1;
    }
    if (forwardHits < 1) return { x, y };

    const away = Math.atan2(ship.y - swarm.y, ship.x - swarm.x);
    if (!Number.isFinite(away)) return { x, y };
    return clampToPlayArea(x + Math.cos(away) * 36, y + Math.sin(away) * 36);
  }

  /**
   * Raid orbit points: keep a wide tower-centered path.
   * Soft turret tether must NOT collapse into NPC π/2 chords (those made square corners).
   * If a point is too close to the pack, push outward on the tower ring / away from NPC.
   */
  function isRaidOrbitExpandActive() {
    return isInRaidMap() && Date.now() < (AUTO.raidOrbitExpandUntil || 0);
  }

  function armRaidOrbitExpand() {
    if (!isInRaidMap()) return;
    const until = Date.now() + RAID_ORBIT_EXPAND_MS;
    if ((AUTO.raidOrbitExpandUntil || 0) < until) {
      AUTO.raidOrbitExpandUntil = until;
    }
  }

  function isRaidOrbitCornered(ship = getShipPosition(), npc = null) {
    if (!isInRaidMap() || !ship) return false;
    const center = getRaidCenter();
    const softMax = getRaidOrbitSoftMax();
    const cruiseMax = getRaidOrbitCruiseMax();
    const shipR = distance(ship.x, ship.y, center.x, center.y);
    // Only "cornered" when pressed against the absolute soft tether (not cruise ring)
    if (!(softMax > 1 && shipR >= softMax * 0.96)) return false;

    // Map-edge pinch on the tether is a real corner
    if (isNearMapBoundary(ship.x, ship.y, 60)) return true;

    const fireRange = getPlayerFireRange();
    const close = listNpcs(fireRange + 70);
    if (!close.length) return false;

    let inward = 0;
    for (const n of close) {
      const nR = distance(n.x, n.y, center.x, center.y);
      if (nR < shipR - 30 && n.dist <= fireRange + 50) inward += 1;
      if (isNpcAttackingPlayer(n.id) && n.dist <= fireRange + 40) inward += 1;
    }
    if (npc && npc.dist <= fireRange + 40) inward += 1;
    // Require real pack pressure — a single in-range NPC while cruising is normal kite
    return inward >= 2 || (close.length >= 3 && shipR >= Math.max(cruiseMax, softMax * 0.97));
  }

  function clampRaidOrbitPoint(x, y, npc) {
    let pt = clampToPlayArea(x, y);
    if (!isInRaidMap()) return pt;

    const center = getRaidCenter();
    const softMax = getRaidOrbitSoftMax();
    const cruiseMax = getRaidOrbitCruiseMax();
    let rCenter = distance(pt.x, pt.y, center.x, center.y);
    let towerAng = Math.atan2(pt.y - center.y, pt.x - center.x);
    if (!Number.isFinite(towerAng)) towerAng = 0;

    // Soft barrier: preferred cruise is an attractor, not a hard wall.
    // Temporary exit beyond support/cruise is allowed; ease back in fractions.
    if (rCenter > cruiseMax && cruiseMax > 1) {
      const overshoot = rCenter - cruiseMax;
      const pull = Math.min(overshoot, Math.max(28, overshoot * 0.28));
      rCenter -= pull;
      pt = clampToPlayArea(
        center.x + Math.cos(towerAng) * rCenter,
        center.y + Math.sin(towerAng) * rCenter
      );
    }

    // Absolute safety tether only (far outside preferred ring)
    if (rCenter > softMax && softMax > 1) {
      rCenter = softMax;
      pt = clampToPlayArea(
        center.x + Math.cos(towerAng) * softMax,
        center.y + Math.sin(towerAng) * softMax
      );
    }

    if (!npc) return pt;

    const { preferred, minR } = getOrbitRadii(npc);
    const dNpc = distance(pt.x, pt.y, npc.x, npc.y);
    if (dNpc >= preferred - 8) return pt;

    // Too close to pack: soft outward on tower ring (may briefly exceed cruise)
    const need = preferred - dNpc;
    const widenR = Math.min(rCenter + Math.min(Math.max(need, 40), 70), softMax * 0.98);
    let candidate = clampToPlayArea(
      center.x + Math.cos(towerAng) * widenR,
      center.y + Math.sin(towerAng) * widenR
    );
    if (distance(candidate.x, candidate.y, npc.x, npc.y) >= preferred * 0.88) {
      return candidate;
    }

    const away = Math.atan2(pt.y - npc.y, pt.x - npc.x);
    const pushR = Math.max(preferred, minR);
    candidate = clampToPlayArea(
      npc.x + Math.cos(away) * pushR,
      npc.y + Math.sin(away) * pushR
    );
    const cR = distance(candidate.x, candidate.y, center.x, center.y);
    if (cR > softMax && softMax > 1) {
      const cAng = Math.atan2(candidate.y - center.y, candidate.x - center.x);
      candidate = clampToPlayArea(
        center.x + Math.cos(cAng) * softMax,
        center.y + Math.sin(cAng) * softMax
      );
    }
    return candidate;
  }

  function getOrbitApproachPoint(npc) {
    const ship = getShipPosition();
    const { maxR } = getOrbitRadii(npc);
    if (!ship) return { x: npc.x + maxR, y: npc.y };

    const dx = ship.x - npc.x;
    const dy = ship.y - npc.y;
    let angle = Math.atan2(dy, dx);
    if (!Number.isFinite(angle)) angle = 0;

    // Standard maps: slight tangential lead so approach is not a dead radial jab.
    if (!isInRaidMap()) {
      const dir = AUTO.orbitDirection || 1;
      const hitSoft = isStdCombatRecentlyDamaged();
      const lead = dir * (0.22 + randBetween(0, 0.1) + (hitSoft ? 0.06 : 0));
      const softR = maxR * (
        (hitSoft ? 1.04 + STD_HIT_APPROACH_SOFT : 1.04) + randBetween(0, 0.06)
      );
      return {
        x: npc.x + Math.cos(angle + lead) * softR,
        y: npc.y + Math.sin(angle + lead) * softR,
      };
    }

    return {
      x: npc.x + Math.cos(angle) * maxR,
      y: npc.y + Math.sin(angle) * maxR,
    };
  }

  /**
   * Standard maps only: track local HP+shield drops for a short post-hit distance soften.
   * Does not touch raid / PvP flee trackers.
   */
  function updateStdCombatHitTracker() {
    if (isInRaidMap()) return;
    const hp = getPlayerHpSnapshot();
    const shield = getPlayerShieldSnapshot();
    const effective = (Number(hp.effective) || 0) + (Number(shield.current) || 0);
    const prev = AUTO.stdCombatLastEffective;
    AUTO.stdCombatLastEffective = effective;
    if (prev == null) return;
    if (effective < prev - 0.5) {
      AUTO.stdCombatHitAt = Date.now();
    }
  }

  function isStdCombatRecentlyDamaged() {
    return (
      !isInRaidMap() &&
      !!AUTO.stdCombatHitAt &&
      Date.now() - AUTO.stdCombatHitAt < STD_COMBAT_HIT_WINDOW_MS
    );
  }

  /** Record whether the last standard-orbit click moved outward (+) or inward (−) vs NPC. */
  function noteStdOrbitRadialSign(ship, npc, tx, ty) {
    if (isInRaidMap() || !ship || !npc || tx == null || ty == null) return;
    const curD = distance(ship.x, ship.y, npc.x, npc.y);
    const newD = distance(tx, ty, npc.x, npc.y);
    const delta = newD - curD;
    if (Math.abs(delta) < 8) return;
    AUTO.stdOrbitLastRadialSign = delta > 0 ? 1 : -1;
  }

  /**
   * Standard maps: suppress inward radial clicks that close distance while the
   * ship can already shoot — plus stable kite under fire (no approach↔retreat loop).
   */
  function shouldSuppressStdInwardAfterHit(ship, npc, tx, ty) {
    if (isInRaidMap() || !ship || !npc || tx == null || ty == null) return false;
    const curD = distance(ship.x, ship.y, npc.x, npc.y);
    const newD = distance(tx, ty, npc.x, npc.y);
    if (!(newD < curD - 8)) return false;

    const fireRange = getPlayerFireRange();
    // Already in laser range: never click inward toward the NPC body.
    if (curD <= fireRange) return true;

    if (!isStdCombatRecentlyDamaged()) return false;

    // Under fire with sticky: prefer stable outer kite while still near laser band.
    if (curD <= fireRange * 1.2) return true;

    // After an outward retreat: block the immediate inward re-click.
    if (AUTO.stdOrbitLastRadialSign !== 1) return false;
    return newD < curD - 12;
  }

  /** Rewrite an inward click to a slightly wider tangential hold / outer stand-off. */
  function softenStdOrbitPointAfterHit(ship, npc, tx, ty) {
    if (!ship || !npc) return { x: tx, y: ty };
    const { preferred, maxR } = getOrbitRadii(npc);
    const dist = distance(ship.x, ship.y, npc.x, npc.y) || 1;
    const holdR = Math.min(
      Math.max(dist, preferred, maxR * 0.92) * (1 + STD_HIT_ORBIT_OUTWARD),
      maxR * (1 + STD_HIT_ORBIT_OUTWARD)
    );
    const ang = Math.atan2(ship.y - npc.y, ship.x - npc.x);
    const dir = AUTO.orbitDirection || 1;
    // Prefer strafe (π/2) over radial jab — stable kite under fire.
    const lead = dir * (Math.PI / 2) * (isStdCombatRecentlyDamaged() ? 0.72 : 0.35);
    return clampToPlayArea(
      npc.x + Math.cos(ang + lead) * holdR,
      npc.y + Math.sin(ang + lead) * holdR
    );
  }

  /**
   * Orbit ON + portalDriftArrived: soft-clamp orbit waypoint so sticky stays in
   * laser stand-off and the ship is not yanked repeatedly outside safe.
   * Does not force hold-still — still orbits, just gentler near the portal.
   */
  function softenPortalSafeOrbitPoint(ship, npc, tx, ty) {
    if (!ship || !npc || tx == null || ty == null) return { x: tx, y: ty };
    const { minR, maxR, preferred, fireRange } = getOrbitRadii(npc);
    const laserCap = Math.min(maxR, fireRange * 0.94);
    let x = tx;
    let y = ty;
    let dNpc = Math.hypot(x - npc.x, y - npc.y) || 1;
    // Keep distance in [minStandOff, laserRange] — never sit on NPC, never leave laser.
    if (dNpc < minR || dNpc > laserCap) {
      const ang = Math.atan2(y - npc.y, x - npc.x);
      const r = clamp(Math.max(dNpc, preferred, minR * 1.05), minR, laserCap);
      x = npc.x + Math.cos(ang) * r;
      y = npc.y + Math.sin(ang) * r;
      dNpc = r;
    }
    const portal = findNearestFriendlyPortal({ preferSafeBase: false });
    if (portal && Number.isFinite(portal.x) && Number.isFinite(portal.y)) {
      const dPortal = Math.hypot(x - portal.x, y - portal.y);
      // Soft pull toward portal when the orbit chord would leave the safe disk.
      // Keep laser on sticky — blend, don't snap to center.
      const safePull = PORTAL_HEAL_CENTER_DIST * 3.2;
      if (dPortal > safePull) {
        const pull = 0.28;
        x = x * (1 - pull) + portal.x * pull;
        y = y * (1 - pull) + portal.y * pull;
        // Reproject onto laser ring after portal blend.
        const ang2 = Math.atan2(y - npc.y, x - npc.x);
        const r2 = clamp(
          Math.hypot(x - npc.x, y - npc.y) || preferred,
          minR,
          laserCap
        );
        x = npc.x + Math.cos(ang2) * r2;
        y = npc.y + Math.sin(ang2) * r2;
      }
    }
    return clampToPlayArea(x, y);
  }

  function getMapBounds() {
    const K = getGameState();
    const w = K?.mapWidth || window.__RG_MAP_W__ || AUTO.lastMapDims?.w || 0;
    const h = K?.mapHeight || window.__RG_MAP_H__ || AUTO.lastMapDims?.h || 0;
    return { w, h };
  }

  function clampToPlayArea(x, y) {
    const { w, h } = getMapBounds();
    const margin = AUTO.mapSafeMargin || 100;
    if (!w || !h) return { x, y };
    return {
      x: clamp(x, margin, Math.max(margin, w - margin)),
      y: clamp(y, margin, Math.max(margin, h - margin)),
    };
  }

  function worldToMinimapClient(worldX, worldY) {
    const canvas = getMinimapCanvas();
    const { w, h } = getMapBounds();
    if (!canvas || !w || !h) return null;

    const rect = canvas.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return null;

    const safe = clampToPlayArea(worldX, worldY);
    return {
      clientX: rect.left + (safe.x / w) * rect.width,
      clientY: rect.top + (safe.y / h) * rect.height,
      worldX: safe.x,
      worldY: safe.y,
    };
  }

  function setMoveTargetDirect(input, x, y) {
    const targetInput = input || getInputSystem();
    if (!targetInput) return false;
    const safe = clampToPlayArea(x, y);

    // Standard maps only: skip retarget spam when already heading roughly the same way.
    if (!isInRaidMap() && shouldKeepExistingMoveTarget(targetInput, safe.x, safe.y)) {
      return true;
    }

    if (typeof targetInput.setMoveTarget === "function") {
      targetInput.setMoveTarget(safe.x, safe.y);
    } else {
      targetInput.moveTarget = { x: safe.x, y: safe.y };
    }
    return true;
  }

  /**
   * Light imperfect pathing for long/safe moves.
   * Never for: laser orbit fine positioning, portal-center final approach, or in-raid.
   * Mid-path flee / coffee / map hops: allowed when options.midPath (or default map travel).
   */
  function canHumanizePathMove(options = {}) {
    if (options.precise || options.finalApproach) return false;
    if (isInRaidMap()) return false;
    // Combat laser orbit / sticky fine positioning must stay accurate.
    if (AUTO.currentTask === "combat" && (AUTO.modeOrbit || AUTO.taskTargetId)) return false;
    // Flee / coffee: only mid-path soft legs (caller sets midPath + finalApproach near portal).
    if (AUTO.fleeActive || NAV.kind === "flee" || NAV.kind === "coffee") {
      return options.midPath === true;
    }
    if (AUTO.portalHoldReason === "admin" || AUTO.portalHoldReason === "coffee") {
      return options.midPath === true;
    }
    return true;
  }

  function countVisibleOtherPlayers() {
    const K = getGameState();
    if (!K?.players || !K?.mySessionId) return 0;
    let n = 0;
    for (const sessionId of K.players.keys()) {
      if (sessionId !== K.mySessionId) n += 1;
    }
    return n;
  }

  /**
   * Irregular long-path lateral stretch (same idea as portal-drift wobble):
   * sometimes straight, sometimes soft, sometimes marked — never fixed L/R 2s clock.
   */
  function refreshPathHumanWobbleState() {
    const now = Date.now();
    if (AUTO.pathHumanUntil && now < AUTO.pathHumanUntil) return;
    const roll = Math.random();
    let amp = 0;
    let holdMs;
    if (roll < 0.42) {
      amp = 0;
      holdMs = randBetween(2200, 4800);
    } else if (roll < 0.8) {
      amp = randBetween(8, 28);
      holdMs = randBetween(1500, 3200);
    } else {
      amp = randBetween(30, 62);
      holdMs = randBetween(1100, 2600);
    }
    if (amp > 0 && Math.random() >= 0.55) {
      AUTO.pathHumanSide = Math.random() < 0.5 ? 1 : -1;
    } else if (!AUTO.pathHumanSide) {
      AUTO.pathHumanSide = Math.random() < 0.5 ? 1 : -1;
    }
    AUTO.pathHumanAmp = amp;
    AUTO.pathHumanUntil = now + holdMs;
  }

  /**
   * Soft mid-chord toward destination with irregular human wobble.
   * Final destination unchanged for short / precise / final-approach moves.
   */
  function humanizeLongMovePoint(ship, destX, destY, options = {}) {
    if (!ship || !canHumanizePathMove(options)) return { x: destX, y: destY };
    const dx = destX - ship.x;
    const dy = destY - ship.y;
    const dist = Math.hypot(dx, dy);
    const minDist = options.minDist || 420;
    if (!(dist > minDist)) return { x: destX, y: destY };

    refreshPathHumanWobbleState();
    const others = countVisibleOtherPlayers();
    let amp = Number(AUTO.pathHumanAmp) || 0;
    if (others > 0 && amp > 0) amp = Math.min(amp * 1.25, 78);
    // Cap vs remaining distance so we don't overshoot wildly.
    amp = Math.min(amp, dist * 0.055);
    const inv = 1 / dist;
    const nx = -dy * inv;
    const ny = dx * inv;
    // Along fraction: mostly ahead on the chord (mouse-hold toward goal).
    const along = clamp(0.28 + Math.random() * 0.14, 0.26, 0.48);
    const side = (AUTO.pathHumanSide >= 0 ? 1 : -1) * amp;
    const step = Math.min(dist * along, Math.max(360, Math.min(920, dist * 0.42)));
    return clampToPlayArea(
      ship.x + dx * inv * step + nx * side,
      ship.y + dy * inv * step + ny * side
    );
  }

  /** Soft prolonged move toward a far destination (map / flee mid / coffee mid / raid-gate). */
  function softLongMoveToward(input, ship, destX, destY, options = {}) {
    if (!ship) return false;
    const dist = distance(ship.x, ship.y, destX, destY);
    const finalR = options.finalRange != null ? options.finalRange : 240;
    if (dist <= finalR || options.finalApproach) {
      return setMoveTargetDirect(input, destX, destY);
    }
    const soft = humanizeLongMovePoint(ship, destX, destY, {
      ...options,
      midPath: true,
    });
    // Hold existing soft waypoint longer (fewer retargets = less robotic).
    const holdMs = 2100;
    const held = AUTO.lastMinimapTarget;
    const heldAge = Date.now() - (AUTO.lastMinimapMoveAt || 0);
    if (held && heldAge < holdMs) {
      const rem = distance(ship.x, ship.y, held.x, held.y);
      if (rem > (AUTO.arriveDistance || 50) + 40) {
        const mt = input?.moveTarget;
        if (!mt || mt.x == null || distance(mt.x, mt.y, held.x, held.y) > 120) {
          setMoveTargetDirect(input, held.x, held.y);
        }
        return true;
      }
    }
    const ok = setMoveTargetDirect(input, soft.x, soft.y);
    if (ok) {
      AUTO.lastMinimapTarget = { x: soft.x, y: soft.y };
      AUTO.lastMinimapMoveAt = Date.now();
    }
    return ok;
  }

  /**
   * Soft-move memory must not keep a waypoint aimed at a previous sticky's geometry.
   * Call whenever the living combat sticky id changes.
   */
  function syncMinimapSoftMoveSticky(stickyId) {
    const id = stickyId || null;
    if (AUTO.lastMinimapStickyId === id) return;
    AUTO.lastMinimapStickyId = id;
    AUTO.lastMinimapTarget = null;
    AUTO.orbitHumanHoldUntil = 0;
  }

  function shouldKeepExistingMoveTarget(input, x, y) {
    const ship = getShipPosition();
    const cur = input?.moveTarget;
    if (!ship || !cur || cur.x == null || cur.y == null) return false;

    const toCurDx = cur.x - ship.x;
    const toCurDy = cur.y - ship.y;
    const toNewDx = x - ship.x;
    const toNewDy = y - ship.y;
    const curLen = Math.hypot(toCurDx, toCurDy);
    const newLen = Math.hypot(toNewDx, toNewDy);
    if (curLen < 40 || newLen < 40) return false;

    // Still far from current waypoint — keep it unless the new heading diverges a lot.
    const remaining = distance(ship.x, ship.y, cur.x, cur.y);
    if (remaining < (AUTO.arriveDistance || 50) + 20) return false;

    // Standard combat: never keep an inward click when the new one opens range
    // (soft-move was letting post-retreat re-dives stick).
    if (!isInRaidMap() && AUTO.currentTask === "combat" && AUTO.taskTargetId) {
      const npc = getNpcEntry(AUTO.taskTargetId);
      if (npc) {
        const fireRange = getPlayerFireRange();
        const shipD = distance(ship.x, ship.y, npc.x, npc.y);
        if (shipD <= fireRange) {
          const oldD = distance(cur.x, cur.y, npc.x, npc.y);
          const newD = distance(x, y, npc.x, npc.y);
          if (newD > shipD + 8 && oldD < shipD - 6) return false;
          if (newD > oldD + 14) return false;
        }
      }
    }

    const dot = (toCurDx / curLen) * (toNewDx / newLen) + (toCurDy / curLen) * (toNewDy / newLen);
    // Soft continuous retreat / same-vector hold (mouse-hold feel).
    if (dot >= 0.88 && remaining > 90) {
      const targetDelta = distance(cur.x, cur.y, x, y);
      if (targetDelta < Math.max(130, remaining * 0.45)) return true;
    }
    // ~cos(40°) ≈ 0.76 — same-ish direction
    if (dot < 0.76) return false;

    const targetDelta = distance(cur.x, cur.y, x, y);
    // New waypoint is close to the old one, or only a mild lateral nudge.
    return targetDelta < Math.max(70, remaining * 0.28);
  }

  function moveViaMinimap(worldX, worldY) {
    syncMapDimsFromWindow();
    const safe = clampToPlayArea(worldX, worldY);
    const now = Date.now();
    const softStandard = !isInRaidMap();
    const execFluid = !softStandard && isRaidExecutionerRound();
    const combatSoft =
      softStandard &&
      (AUTO.currentTask === "combat" || AUTO.orbitPortalDrift);
    // Combat orbit: longer irregular cadence (not every ~300ms tick).
    const combatInterval = combatSoft
      ? Math.max(AUTO.minimapMoveMinIntervalMs || 90, 480)
      : 220;
    const minInterval = softStandard
      ? combatInterval
      : execFluid
        ? Math.max(AUTO.raidOrbitMoveMinIntervalMs || 260, 470)
        : AUTO.minimapMoveMinIntervalMs;
    const minDelta = softStandard
      ? Math.max(AUTO.minimapMoveMinDelta || 28, combatSoft ? 95 : 55)
      : execFluid
        ? Math.max(AUTO.minimapMoveMinDelta || 28, 78)
        : AUTO.minimapMoveMinDelta;

    if (
      AUTO.lastMinimapTarget &&
      now - AUTO.lastMinimapMoveAt < minInterval &&
      distance(AUTO.lastMinimapTarget.x, AUTO.lastMinimapTarget.y, safe.x, safe.y) < minDelta
    ) {
      return true;
    }

    // Soft heading gate (standard maps + Executioner raid): don't spam a nearly-identical click.
    if ((softStandard || execFluid) && AUTO.lastMinimapTarget) {
      const ship = getShipPosition();
      if (ship && shouldKeepExistingMoveTarget({ moveTarget: AUTO.lastMinimapTarget }, safe.x, safe.y)) {
        return true;
      }
    }

    const minimap = getMinimap();
    hookMinimap(minimap);
    const point = worldToMinimapClient(safe.x, safe.y);

    if (point && clickMinimapAtClient(point.clientX, point.clientY)) {
      AUTO.lastMinimapTarget = { x: point.worldX, y: point.worldY };
      AUTO.lastMinimapMoveAt = now;
      return true;
    }

    const { w, h } = getMapBounds();
    if (minimap?.onMapClick && w > 0 && h > 0) {
      rememberMapDims(w, h);
      minimap.onMapClick(safe.x, safe.y);
      AUTO.lastMinimapTarget = safe;
      AUTO.lastMinimapMoveAt = now;
      return true;
    }

    const moved = setMoveTargetDirect(null, safe.x, safe.y);
    if (moved) {
      AUTO.lastMinimapTarget = safe;
      AUTO.lastMinimapMoveAt = now;
    }
    return moved;
  }

  /**
   * Raid-only: true when the intended move is mostly radial vs the turret center
   * (straight in/out across the designated orbit radius instead of circling).
   */
  function isRaidOrbitMoveTooRadial(ship, target) {
    if (!ship || !target) return false;
    const moveDx = target.x - ship.x;
    const moveDy = target.y - ship.y;
    const moveLen = Math.hypot(moveDx, moveDy);
    if (moveLen < 18) return false;
    const center = getRaidCenter();
    const shipAng = Math.atan2(ship.y - center.y, ship.x - center.x);
    if (!Number.isFinite(shipAng)) return false;
    const radX = Math.cos(shipAng);
    const radY = Math.sin(shipAng);
    return Math.abs((moveDx / moveLen) * radX + (moveDy / moveLen) * radY) >= 0.7;
  }

  /**
   * Raid trajectory recovery: one tangential step on the current tower-radius band.
   * Does not flip orbitDirection. Places the waypoint inside supportMax so softClamp
   * cannot immediately re-radialize the click.
   */
  function recoverRaidOrbitTangential(ship, npc) {
    const center = getRaidCenter();
    const dir = AUTO.orbitDirection || 1;
    const supportMax = getRaidOrbitSupportMax();
    const cruiseMax = getRaidOrbitCruiseMax();
    const shipR = distance(ship.x, ship.y, center.x, center.y);
    // Prefer current radius, but stay inside soft support so clamp stays a no-op
    const wantR = clamp(shipR, supportMax * 0.55, Math.min(cruiseMax, supportMax * 0.97));
    const shipAng = Math.atan2(ship.y - center.y, ship.x - center.x);
    const step = Math.max(AUTO.orbitArcRadians || 0.24, 0.16);
    let tx = center.x + Math.cos(shipAng + dir * step) * wantR;
    let ty = center.y + Math.sin(shipAng + dir * step) * wantR;

    // Light NPC-laser bias so recovery still holds fire range when possible
    if (npc) {
      const { preferred } = getOrbitRadii(npc);
      const dNpc = distance(tx, ty, npc.x, npc.y);
      if (dNpc > preferred + 40) {
        const pull = Math.atan2(npc.y - ty, npc.x - tx);
        tx += Math.cos(pull) * Math.min(48, dNpc - preferred);
        ty += Math.sin(pull) * Math.min(48, dNpc - preferred);
      }
    }
    const biased = biasRaidOrbitAwayFromForwardPack(ship, npc, tx, ty);
    return softClampToRaidSupportZone(biased.x, biased.y);
  }

  /**
   * Story 3 applyCombatOrbit (~2307) — NPC-centered π/2 kite.
   * Raid uses the same geometry (Story 3 reliability). Deltas: B lock dir, E soft support,
   * F radial ping-pong recovery (raid gates only).
   * @param {{ force?: boolean }} [opts] force=true: kite even when Orbit UI is off
   *   (Executioner last wave — never stand still).
   */
  function applyCombatOrbit(npc, opts = {}) {
    if (!npc) return false;
    if (!AUTO.modeOrbit && !opts.force) return false;
    // Heal-flee / wave breakout own movement — do not fight them with π/2 orbit clicks.
    if (isRaidHealActive()) return false;
    if (isInRaidMap() && needsRaidWaveBreakout()) return false;
    const shipEarly = getShipPosition();
    if (!isInRaidMap() && shipEarly && needsStandardOrbitBreakout(shipEarly)) return false;

    // Abort cargo FSM/native cargo walk only when it is actually interfering.
    // mac33: collectCargo toggle alone must NOT call release (that null'd the kite).
    if (
      isInRaidMap() &&
      AUTO.collectCargo &&
      hasLivingStickyCombat() &&
      hasInterferingRaidCargoState()
    ) {
      releaseRaidCargoClearForCombat();
    }

    const ship = getShipPosition();
    const input = getInputSystem();
    if (!ship || !input) return false;

    // Portal drift: interrupt circle and retreat to portal before any orbit geometry.
    if (drivePortalDriftRetreat(ship, npc)) return true;

    // Orbit ON + drift arrived: gentler kite near safe (stable laser stand-off, less thrash).
    const portalSafeOrbit =
      AUTO.orbitPortalDrift && AUTO.portalDriftArrived && !isInRaidMap();

    const { minR, maxR, fireRange, preferred } = getOrbitRadii(npc);
    // A: still approach-orbit when slightly outside fire band (Story 3 gate was fireRange+40)
    if (npc.dist > fireRange + 40) return false;

    const now = Date.now();
    const inRaid = isInRaidMap() && !isRaidHealActive();
    const execFluid = inRaid && isRaidExecutionerRound();
    if (!inRaid) updateStdCombatHitTracker();
    const hitSoft = !inRaid && isStdCombatRecentlyDamaged();

    if (AUTO.orbitNpcId !== npc.id) {
      AUTO.orbitNpcId = npc.id;
      // B: raid session keeps CW/CCW — never re-pick on retarget (Story 3 flipped here)
      if (!inRaid || !AUTO.orbitDirection) {
        AUTO.orbitDirection = pickOrbitDirection(npc, ship);
      }
      AUTO.orbitFlipAt = now + AUTO.orbitFlipIntervalMs;
      AUTO.orbitLastPos = null;
      AUTO.orbitStuckSince = 0;
    }

    if (AUTO.orbitLastPos) {
      const moved = distance(ship.x, ship.y, AUTO.orbitLastPos.x, AUTO.orbitLastPos.y);
      if (moved < (AUTO.orbitStuckMinMove || 10) && isNearMapBoundary(ship.x, ship.y, 60)) {
        if (!AUTO.orbitStuckSince) AUTO.orbitStuckSince = now;
      } else if (moved >= (AUTO.orbitStuckMinMove || 10)) {
        AUTO.orbitStuckSince = 0;
      }
    }
    AUTO.orbitLastPos = { x: ship.x, y: ship.y };

    if (AUTO.orbitStuckSince && now - AUTO.orbitStuckSince >= (AUTO.orbitCornerEscapeMs || 1400)) {
      return applyOrbitCornerEscape(npc, ship);
    }

    if (now >= AUTO.orbitFlipAt) {
      if (inRaid) {
        // B: no timed reverse in raid — only advance the timer
        AUTO.orbitFlipAt = now + AUTO.orbitFlipIntervalMs + randBetween(-2500, 2500);
      } else if (isNearMapBoundary(ship.x, ship.y, 40)) {
        AUTO.orbitDirection = pickOrbitDirection(npc, ship);
        AUTO.orbitFlipAt = now + AUTO.orbitFlipIntervalMs + randBetween(-2500, 2500);
      } else {
        // Standard maps: avoid abrupt timed 180° orbit flips (robotic jerks).
        // Only nudge the timer forward; direction changes come from boundary/stuck.
        const flipBase = portalSafeOrbit
          ? Math.max(AUTO.orbitFlipIntervalMs || 14000, 24000)
          : Math.max(AUTO.orbitFlipIntervalMs || 14000, 18000);
        AUTO.orbitFlipAt = now + flipBase + randBetween(-2000, 3000);
      }
    }

    const dx = ship.x - npc.x;
    const dy = ship.y - npc.y;
    let dist = Math.hypot(dx, dy);
    if (dist < 1) dist = 1;

    const radialAngle = Math.atan2(dy, dx);
    let tx;
    let ty;

    if (dist < minR || dist > maxR + 10) {
      // Standard + recent hit: prefer slightly larger band (less inward settle).
      // Standard maps: ease toward preferred/maxR — never settle on minR.
      // Raid: same as cargo OFF — ease with safety margin (collectCargo must not diverge).
      let targetR = dist > maxR
        ? maxR
        : inRaid
          ? clamp(
              Math.max(dist + AUTO.orbitNpcSafetyMargin, preferred),
              minR,
              maxR
            )
          : clamp(
              Math.max(dist + AUTO.orbitNpcSafetyMargin, preferred),
              minR,
              maxR
            );
      if (portalSafeOrbit) {
        // Near portal: keep a strict laser stand-off — never dive into NPC body.
        targetR = clamp(Math.max(preferred, minR * 1.08, dist), minR, Math.min(maxR, fireRange * 0.94));
      }
      if (hitSoft && dist < minR) {
        targetR = clamp(
          Math.max(targetR, preferred, minR * (1 + STD_HIT_ORBIT_OUTWARD), dist + AUTO.orbitNpcSafetyMargin),
          minR,
          maxR * (1 + STD_HIT_ORBIT_OUTWARD)
        );
      }
      if (inRaid) {
        // F: raid band correction must stay tangential — pure radial = turret-radius ping-pong
        const arcStep = AUTO.orbitArcRadians * (1 + randBetween(0, 0.08));
        const tangentLead = AUTO.orbitDirection * (Math.PI / 2);
        const targetAngle = radialAngle + tangentLead + AUTO.orbitDirection * arcStep;
        tx = npc.x + Math.cos(targetAngle) * targetR;
        ty = npc.y + Math.sin(targetAngle) * targetR;
      } else {
        // Soft band correction: light tangential bias (not a hard radial snap).
        // Portal-safe: smaller angle nudge so we don't thrash safe edges.
        const bandBias = portalSafeOrbit ? 0.06 + randBetween(0, 0.04) : 0.12 + randBetween(0, 0.08);
        let angle = radialAngle + AUTO.orbitDirection * bandBias;
        if (isNearMapBoundary(ship.x, ship.y, 60)) {
          angle += AUTO.orbitDirection * 0.1;
        }
        if (hitSoft) angle += AUTO.orbitDirection * 0.05;
        tx = npc.x + Math.cos(angle) * targetR;
        ty = npc.y + Math.sin(angle) * targetR;
      }
    } else {
      // Standard: slightly longer lead / softer arc so orbit clicks feel less twitchy.
      // Portal-safe: smaller π/2 lead + shorter arc → less yank outside safe.
      // Executioner: slightly smaller arc than mac24 fluid — stay in laser (don't outrun sticky).
      const arcBase = inRaid
        ? execFluid
          ? Math.max(AUTO.orbitArcRadians || 0.1, 0.11)
          : AUTO.orbitArcRadians
        : portalSafeOrbit
          ? Math.max(AUTO.orbitArcRadians || 0.1, 0.08)
          : Math.max(AUTO.orbitArcRadians || 0.1, hitSoft ? 0.18 : 0.14);
      const arcStep = arcBase * (1 + randBetween(0, inRaid ? (execFluid ? 0.07 : 0.08) : portalSafeOrbit ? 0.06 : hitSoft ? 0.2 : 0.12));
      const tangentLead = AUTO.orbitDirection * (portalSafeOrbit ? Math.PI / 2.6 : Math.PI / 2);
      const targetAngle = radialAngle + tangentLead + AUTO.orbitDirection * arcStep;
      let targetRadius = clamp(dist, minR, maxR);
      if (!inRaid) {
        // Prefer outer stand-off (preferred/maxR); don't settle near minR while in fire range.
        if (dist < preferred) {
          targetRadius = clamp(
            Math.max(dist + (AUTO.orbitNpcSafetyMargin || 36) * 0.45, preferred),
            minR,
            maxR
          );
        } else {
          targetRadius = clamp(Math.max(dist, preferred), minR, maxR);
        }
      } else if (execFluid) {
        // Hold preferred laser band — tighter orbit so sticky shots land reliably.
        targetRadius = clamp(
          dist > preferred + 28
            ? Math.min(dist, preferred + 10)
            : Math.max(Math.min(dist, preferred + 6), preferred - 10),
          minR,
          Math.min(maxR, fireRange - 2)
        );
      } else {
        // mac33: raid combat (cargo ON or OFF identical) — prefer outer laser stand-off,
        // never lock targetRadius = current dist when already inside preferred.
        if (dist < preferred) {
          targetRadius = clamp(
            Math.max(dist + (AUTO.orbitNpcSafetyMargin || 36), preferred),
            minR,
            maxR
          );
        } else {
          targetRadius = clamp(Math.max(dist, preferred), minR, maxR);
        }
      }
      if (portalSafeOrbit) {
        // Strict laser band while kiting near portal safe.
        targetRadius = clamp(
          Math.max(preferred, Math.min(dist, maxR)),
          minR,
          Math.min(maxR, fireRange * 0.94)
        );
      }
      if (hitSoft) {
        // Stable outer kite under fire — prefer maxR/strafe, not preferred re-settle.
        targetRadius = Math.min(
          maxR * (1 + STD_HIT_ORBIT_OUTWARD),
          Math.max(targetRadius, preferred, dist) * (1 + STD_HIT_ORBIT_OUTWARD)
        );
      }
      tx = npc.x + Math.cos(targetAngle) * targetRadius;
      ty = npc.y + Math.sin(targetAngle) * targetRadius;
      if (!inRaid) {
        // Light curve offset on approach chord — reproject so radius stays circular.
        const curveAmp = portalSafeOrbit
          ? 8 + randBetween(0, 6)
          : 18 + randBetween(0, 14) + (hitSoft ? 10 : 0);
        const curve = AUTO.orbitDirection * curveAmp;
        tx += Math.cos(targetAngle + Math.PI / 2) * curve * (portalSafeOrbit ? 0.22 : 0.35);
        ty += Math.sin(targetAngle + Math.PI / 2) * curve * (portalSafeOrbit ? 0.22 : 0.35);
        const angCurve = Math.atan2(ty - npc.y, tx - npc.x);
        tx = npc.x + Math.cos(angCurve) * targetRadius;
        ty = npc.y + Math.sin(angCurve) * targetRadius;
      }
    }

    // Intended stand-off radius around NPC (pre-clamp). Keep this circular on
    // standard maps — portal drift / map-edge clamp must not squash into an oval.
    const wantOrbitR = Math.hypot(tx - npc.x, ty - npc.y);
    const target = nudgeOrbitFromBoundary(tx, ty, ship, npc);
    // E: soft support attractor (Story 3 used hard clampToRaidSupportZone ~3802)
    let safeTarget = inRaid
      ? softClampToRaidSupportZone(target.x, target.y)
      : softClampStdOrbitCircle(target.x, target.y, npc, wantOrbitR > 1 ? wantOrbitR : preferred);
    if (inRaid) {
      // Light pack bias before radial check — still no direction flip
      const biased = biasRaidOrbitAwayFromForwardPack(ship, npc, safeTarget.x, safeTarget.y);
      safeTarget = softClampToRaidSupportZone(biased.x, biased.y);
    }
    if (inRaid && isRaidOrbitMoveTooRadial(ship, safeTarget)) {
      // F: softClamp (or residual radial chord) collapsed the move — recover to circle now
      safeTarget = recoverRaidOrbitTangential(ship, npc);
    }
    if (!inRaid) {
      // Near portal (or drift off): keep circular softClamp. Far retreat is handled
      // earlier by drivePortalDriftRetreat — never soft-blend orbit waypoints again.
      const orbitR =
        wantOrbitR > 1
          ? wantOrbitR
          : Math.hypot(safeTarget.x - npc.x, safeTarget.y - npc.y) || preferred;
      safeTarget = softClampStdOrbitCircle(safeTarget.x, safeTarget.y, npc, orbitR);
      if (shouldSuppressStdInwardAfterHit(ship, npc, safeTarget.x, safeTarget.y)) {
        safeTarget = softenStdOrbitPointAfterHit(ship, npc, safeTarget.x, safeTarget.y);
        safeTarget = softClampStdOrbitCircle(
          safeTarget.x,
          safeTarget.y,
          npc,
          Math.hypot(safeTarget.x - npc.x, safeTarget.y - npc.y) || orbitR
        );
      }
      if (portalSafeOrbit) {
        safeTarget = softenPortalSafeOrbitPoint(ship, npc, safeTarget.x, safeTarget.y);
      }
      noteStdOrbitRadialSign(ship, npc, safeTarget.x, safeTarget.y);
    }
    // Portal-safe / Executioner / standard / raid combat: irregular human hold before retarget.
    // Not every mainTick — prolonged mouse-hold feel on the orbit chord.
    // Escape breakout never reaches here (needsRaidWaveBreakout returns early above).
    if (!AUTO.orbitHumanHoldUntil || now >= AUTO.orbitHumanHoldUntil) {
      // Refresh next hold window irregularly (380–900ms).
      AUTO.orbitHumanHoldUntil =
        now +
        (portalSafeOrbit
          ? randBetween(520, 920)
          : hitSoft
            ? randBetween(420, 780)
            : inRaid
              ? randBetween(400, 820)
              : randBetween(380, 860));
    } else if (
      AUTO.lastMinimapTarget &&
      shouldKeepExistingMoveTarget(
        { moveTarget: AUTO.lastMinimapTarget },
        safeTarget.x,
        safeTarget.y
      )
    ) {
      // Re-assert soft hold if engine dropped moveTarget — no new click.
      const mt = input.moveTarget;
      const held = AUTO.lastMinimapTarget;
      if (
        !mt ||
        mt.x == null ||
        distance(mt.x, mt.y, held.x, held.y) > 120
      ) {
        setMoveTargetDirect(input, held.x, held.y);
      }
      return true;
    }
    const holdMs = portalSafeOrbit
      ? 620
      : execFluid
        ? Math.max((AUTO.raidOrbitMoveMinIntervalMs || 260) * 2.25, 580)
        : !inRaid
          ? 480
          : 420;
    if (
      holdMs > 0 &&
      AUTO.lastMinimapTarget &&
      now - (AUTO.lastMinimapMoveAt || 0) < holdMs &&
      shouldKeepExistingMoveTarget(
        { moveTarget: AUTO.lastMinimapTarget },
        safeTarget.x,
        safeTarget.y
      )
    ) {
      return true;
    }
    // mac46: raid combat orbit = prolonged gameplay click (human hold).
    // Escape / encircle breakout stays on minimap via driveRaidWaveBreakout.
    setMoveTargetDirect(input, safeTarget.x, safeTarget.y);
    AUTO.lastMinimapTarget = { x: safeTarget.x, y: safeTarget.y };
    AUTO.lastMinimapMoveAt = now;
    if (inRaid) AUTO.lastRaidOrbitMoveAt = now;
    return true;
  }

  function refreshCombatOrbit() {
    if (AUTO.currentTask !== "combat") return;
    if (isRaidHealActive()) return;
    const ship = getShipPosition();
    // KeepAlive assist: if encircled / wave-armed, break out instead of orbiting into the pack.
    if (isInRaidMap() && ship && needsRaidWaveBreakout(ship)) {
      const npc = getNpcEntry(AUTO.taskTargetId) || resolveRaidCombatTarget(AUTO.taskTargetId);
      const input = getInputSystem();
      if (input) driveRaidWaveBreakout(input, ship, npc);
      return;
    }
    if (!isInRaidMap() && ship && needsStandardOrbitBreakout(ship)) {
      const npc = getNpcEntry(AUTO.taskTargetId);
      const input = getInputSystem();
      if (input) driveStandardOrbitBreakout(input, ship, npc);
      return;
    }
    const npc = getNpcEntry(AUTO.taskTargetId);
    // Portal drift is independent from Orbita — run even when orbit is off.
    if (!isInRaidMap() && ship && npc && drivePortalDriftRetreat(ship, npc)) return;
    if (!AUTO.modeOrbit) return;
    if (!npc || !shouldHoldOrbitDistance(npc)) return;
    applyCombatOrbit(npc);
  }

  function togglePlayMode(mode) {
    if (mode === "collect") {
      AUTO.collectBonus = !AUTO.collectBonus;
      syncCollectMasterFlag();
    }
    if (mode === "attack") {
      AUTO.modeAttack = !AUTO.modeAttack;
      if (!AUTO.modeAttack) {
        clearNpcTypeSelection();
        stopCombat();
      }
    }
    updateModeButtons();
    updateNpcListVisuals();
    const parts = [];
    if (hasAnyCollectMode()) parts.push("Raccolta");
    if (AUTO.modeAttack) parts.push("Attacco");
    setStatus(parts.length ? `Modalità: ${parts.join(" + ")}` : "Seleziona almeno una modalità");
  }

  function toggleCollectOption(option) {
    if (option === "bonus") AUTO.collectBonus = !AUTO.collectBonus;
    if (option === "cargo") AUTO.collectCargo = !AUTO.collectCargo;
    if (option === "booty") AUTO.collectBooty = !AUTO.collectBooty;
    syncCollectMasterFlag();
    updateModeButtons();
  }

  function toggleOrbitMode() {
    AUTO.modeOrbit = !AUTO.modeOrbit;
    resetOrbitState();
    updateModeButtons();
    setStatus(
      AUTO.modeOrbit
        ? "Orbita attiva (kiting via minimappa, laser in range)"
        : "Orbita disattivata"
    );
  }

  function toggleOrbitPortalDrift() {
    AUTO.orbitPortalDrift = !AUTO.orbitPortalDrift;
    if (!AUTO.orbitPortalDrift) {
      AUTO.portalDriftArrived = false;
      AUTO.portalDriftWobbleUntil = 0;
      AUTO.portalDriftWobbleAmp = 0;
    }
    updateModeButtons();
    setStatus(AUTO.orbitPortalDrift ? "status.portal_drift_on" : "status.portal_drift_off");
  }

  function updateModeButtons() {
    document.getElementById("rg-mode-collect-bonus")?.classList.toggle("selected", AUTO.collectBonus);
    document.getElementById("rg-mode-collect-cargo")?.classList.toggle("selected", AUTO.collectCargo);
    document.getElementById("rg-mode-collect-booty")?.classList.toggle("selected", AUTO.collectBooty && canCollectBootyNow());
    document.getElementById("rg-refinery-sell")?.classList.toggle("selected", AUTO.refinerySellMinerals && isPlayerPremium());
    document.getElementById("rg-refinery-antimatter")?.classList.toggle("selected", AUTO.refinerySendAntimatter && isPlayerPremium());
    document.getElementById("rg-refinery-refine")?.classList.toggle("selected", AUTO.refineryAutoRefine);
    document.getElementById("rg-refinery-enhance")?.classList.toggle("selected", AUTO.refineryAutoEnhance);
    document.querySelectorAll("[data-refinery-category]").forEach((btn) => {
      const category = btn.dataset.refineryCategory;
      const ore = btn.dataset.refineryOre;
      const selected = AUTO.refineryAutoEnhance && (AUTO.refineryOres[category]?.has(ore) ?? false);
      btn.classList.toggle("selected", selected);
      btn.disabled = !AUTO.refineryAutoEnhance;
      btn.title = AUTO.refineryAutoEnhance
        ? "Seleziona minerale per potenziamento"
        : "Abilita prima Potenziamento";
    });
    document.getElementById("rg-mode-attack")?.classList.toggle("selected", AUTO.modeAttack);
    document.getElementById("rg-mode-orbit")?.classList.toggle("selected", AUTO.modeOrbit);
    document.getElementById("rg-mode-portal-drift")?.classList.toggle("selected", AUTO.orbitPortalDrift);
    updateAttackAmmoButtons();

    const sellBtn = document.getElementById("rg-refinery-sell");
    if (sellBtn) {
      sellBtn.disabled = !isPlayerPremium();
      sellBtn.title = isPlayerPremium() ? "Vende tutto tranne Plutonio, Tritio, Antimateria" : "Richiede account Premium";
    }
    const amBtn = document.getElementById("rg-refinery-antimatter");
    if (amBtn) {
      amBtn.disabled = !isPlayerPremium();
      amBtn.title = isPlayerPremium()
        ? t("ui.refinery_antimatter_hint")
        : t("status.premium_antimatter");
    }
  }

  function ensureNpcListBuilt() {
    const listEl = document.getElementById("rg-npc-list");
    if (!listEl || listEl.dataset.built === "1") return;

    listEl.dataset.built = "1";
    listEl.innerHTML = Object.entries(NPC_TYPES)
      .map(
        ([key, label]) => `
      <button type="button" class="rg-npc-item" data-npc-type="${key}">
        <span class="rg-npc-name">${escapeHtml(label)}</span>
        <span class="rg-npc-meta">selezionabile</span>
      </button>`
      )
      .join("");

    listEl.addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-npc-type]");
      if (!btn) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (!AUTO.modeAttack) {
        setStatus("status.npc_requires_attack");
        return;
      }
      toggleNpcTypeSelection(btn.dataset.npcType);
      const n = AUTO.selectedNpcTypes.size;
      setStatus(n > 0 ? `${n} tipo/i NPC selezionati` : "Nessun tipo NPC selezionato");
    });
  }

  function updateNpcListVisuals() {
    const listEl = document.getElementById("rg-npc-list");
    const countEl = document.getElementById("rg-npc-count");
    if (!listEl) return;

    ensureNpcListBuilt();
    const counts = new Map(listNpcTypes().map((t) => [t.key, t.count]));
    let visible = 0;
    const attackOn = Boolean(AUTO.modeAttack);
    listEl.querySelectorAll("[data-npc-type]").forEach((btn) => {
      const key = btn.dataset.npcType;
      const count = counts.get(key) || 0;
      if (count > 0) visible += 1;
      btn.classList.toggle("selected", AUTO.selectedNpcTypes.has(key));
      btn.disabled = !attackOn;
      btn.title = attackOn ? "" : t("status.npc_requires_attack");
      const meta = btn.querySelector(".rg-npc-meta");
      const kills = AUTO.npcKillsByType[key] || 0;
      const parts = [];
      if (!attackOn) parts.push(t("status.npc_requires_attack"));
      else {
        if (kills > 0) parts.push(`${kills} uccisi`);
        if (count > 0) parts.push(`${count} in mappa`);
      }
      if (meta) meta.textContent = parts.length ? parts.join(" · ") : "selezionabile";
    });
    if (countEl) countEl.textContent = String(visible);
  }

  function listNpcs(maxRadius) {
    const entities = getEntities();
    const ship = getShipPosition();
    if (!entities?.npcSprites || !ship) return [];

    const npcs = [];
    for (const [id, sprite] of entities.npcSprites) {
      if (!sprite?.alive) continue;
      if (!isNpcAllowedForCombat(id)) continue;
      const type = getSpriteNpcType(sprite);
      if (!type) continue;
      const pos = getNpcPosition(sprite);
      if (!pos) continue;
      const dist = distance(ship.x, ship.y, pos.x, pos.y);
      if (maxRadius && dist > maxRadius) continue;
      npcs.push({
        id,
        x: pos.x,
        y: pos.y,
        dist,
        type,
        name: getNpcTypeLabel(type),
      });
    }
    npcs.sort((a, b) => a.dist - b.dist);
    return npcs;
  }

  /**
   * True while schema/sprite still show a living NPC (hp>0 or alive).
   * Prefer K.npcs over sprite.alive — hit handlers set alive=false before HP sync,
   * and sprite.alive can flicker while a sliver of HP remains.
   * HP > 0 always wins over alive===false sync flicker.
   * alive===false with unknown HP must NOT abandon while the sprite still lives.
   */
  function isNpcStillFightable(npcId) {
    if (!npcId) return false;
    const state = getGameState()?.npcs?.get?.(npcId);
    const sprite = getNpcSprite(npcId);
    if (state) {
      if (state.hp != null && Number(state.hp) > 0) return true;
      if (state.hp != null && Number(state.hp) <= 0) return false;
      // hp unknown: alive=false is a common mid-hit flicker — trust living sprite.
      if (state.alive === false) return Boolean(sprite?.alive);
      return true;
    }
    return Boolean(sprite?.alive);
  }

  function isPostKillCargoNpcId(npcId) {
    if (!npcId) return false;
    return (
      AUTO.mandatoryPostKillCargo?.npcId === npcId ||
      AUTO.pendingCombatCargo?.npcId === npcId ||
      AUTO.countedNpcKillIds.has(npcId)
    );
  }

  function tickNpcRecoveryDebounce(npcId) {
    if (!npcId) return;
    if (!AUTO.npcRecoverySince) AUTO.npcRecoverySince = new Map();
    if (!isNpcStillFightable(npcId) || !getNpcSprite(npcId)?.alive) {
      AUTO.npcRecoverySince.delete(npcId);
      return;
    }
    if (!AUTO.npcRecoverySince.has(npcId)) {
      AUTO.npcRecoverySince.set(npcId, Date.now());
    }
  }

  /** True only after sustained fightable+alive — not post-kill HP sync flicker. */
  function isGenuineNpcRecovery(npcId) {
    if (!npcId || !isNpcStillFightable(npcId)) return false;
    if (!getNpcSprite(npcId)?.alive) return false;
    if (!getNpcEntry(npcId)) return false;
    tickNpcRecoveryDebounce(npcId);
    const since = AUTO.npcRecoverySince?.get(npcId);
    return Boolean(since && Date.now() - since >= POST_KILL_FALSE_RECOVERY_MS);
  }

  /**
   * Undo a premature kill count when the NPC is clearly still in the fight.
   * False hit/rocketHit counts made confirmed-gone fire on the next flicker.
   */
  function reclaimFalselyCountedLivingNpc(npcId) {
    if (!npcId || !AUTO.countedNpcKillIds.has(npcId)) return;
    if (!isNpcStillFightable(npcId) && !getNpcSprite(npcId)?.alive) return;
    AUTO.countedNpcKillIds.delete(npcId);
    const typeKey = resolveNpcType(npcId) || AUTO.trackedNpcTypes.get(npcId);
    if (typeKey) {
      const n = Number(AUTO.npcKillsByType[typeKey]) || 0;
      if (n > 0) AUTO.npcKillsByType[typeKey] = n - 1;
      updateNpcKillCounter();
    }
    AUTO.watchedNpcIds.add(npcId);
  }

  /** Confirmed dead/gone: counted kill, or missing long enough (not a one-frame flicker). */
  function isCombatTargetConfirmedGone(npcId) {
    if (!npcId) return true;
    if (isNpcStillFightable(npcId)) {
      AUTO.combatTargetGoneAt = 0;
      reclaimFalselyCountedLivingNpc(npcId);
      return false;
    }
    const sprite = getNpcSprite(npcId);
    // Sprite still drawing → never treat a premature counted kill as confirmed gone.
    if (sprite?.alive) {
      AUTO.combatTargetGoneAt = 0;
      reclaimFalselyCountedLivingNpc(npcId);
      return false;
    }
    if (AUTO.countedNpcKillIds.has(npcId)) return true;

    const state = getGameState()?.npcs?.get?.(npcId);
    // Fully removed from schema + sprites — still wait ≥2 mainTicks.
    if (!sprite && !state) {
      if (!AUTO.combatTargetGoneAt) AUTO.combatTargetGoneAt = Date.now();
      return Date.now() - AUTO.combatTargetGoneAt >= COMBAT_TARGET_GONE_FULL_REMOVE_MS;
    }

    // Schema/sprite say dead or missing — wait out HP/alive sync lag before retarget.
    if (!AUTO.combatTargetGoneAt) AUTO.combatTargetGoneAt = Date.now();
    return Date.now() - AUTO.combatTargetGoneAt >= COMBAT_TARGET_GONE_CONFIRM_MS;
  }

  function clearFalsePendingCargoForLivingTarget(npcId) {
    if (!npcId || !AUTO.pendingCombatCargo) return;
    if (AUTO.pendingCombatCargo.npcId !== npcId) return;
    // mac41: confirmed/counted/mandatory kills must NOT be wiped by sprite.alive
    // flicker — that cleared pending so portal-drift heal armed mid-cargo.
    const confirmedKill =
      AUTO.countedNpcKillIds.has(npcId) ||
      isCombatTargetConfirmedGone(npcId) ||
      AUTO.mandatoryPostKillCargo?.npcId === npcId;
    if (confirmedKill) {
      if (isGenuineNpcRecovery(npcId)) {
        AUTO.pendingCombatCargo = null;
        endMandatoryPostKillCargoPhase(npcId);
        reclaimFalselyCountedLivingNpc(npcId);
      } else if (isNpcStillFightable(npcId)) {
        tickNpcRecoveryDebounce(npcId);
      }
      return;
    }
    if (!isNpcStillFightable(npcId) && !getNpcSprite(npcId)?.alive) return;
    AUTO.pendingCombatCargo = null;
    reclaimFalselyCountedLivingNpc(npcId);
  }

  /**
   * Drop phantom post-kill cargo expectation that would freeze the ship mid-fight.
   * Returns true if pending was cleared.
   *
   * mac40/mac41: a confirmed/counted/mandatory kill must NOT be wiped by
   * sprite.alive flicker — that cleared pending right after clearTaskIfDone
   * armed it, so portal-drift post-kill heal armed with an empty lifecycle
   * and abandoned cargo.
   */
  function clearPhantomPendingCargoBlockingCombat() {
    const pending = AUTO.pendingCombatCargo;
    if (!pending?.npcId) return false;
    const pid = pending.npcId;
    const confirmedKill =
      AUTO.countedNpcKillIds.has(pid) ||
      isCombatTargetConfirmedGone(pid) ||
      AUTO.mandatoryPostKillCargo?.npcId === pid;
    if (confirmedKill) {
      // Only drop on sustained recovery — not post-kill HP flicker.
      if (isGenuineNpcRecovery(pid)) {
        AUTO.pendingCombatCargo = null;
        endMandatoryPostKillCargoPhase(pid);
        reclaimFalselyCountedLivingNpc(pid);
        return true;
      }
      if (isNpcStillFightable(pid)) tickNpcRecoveryDebounce(pid);
      return false;
    }
    if (isNpcStillFightable(pid) || getNpcSprite(pid)?.alive) {
      AUTO.pendingCombatCargo = null;
      reclaimFalselyCountedLivingNpc(pid);
      return true;
    }
    // Living sticky fight open → never keep a cargo-wait freeze (even for another dead id).
    // Scoop resumes after the sticky kill; mid-fight pending only stalls movement.
    const sticky =
      AUTO.combatFocusId ||
      AUTO.combatTargetId ||
      (AUTO.currentTask === "combat" ? AUTO.taskTargetId : null);
    if (
      sticky &&
      sticky !== pid &&
      (isNpcStillFightable(sticky) ||
        getNpcSprite(sticky)?.alive ||
        !isCombatTargetConfirmedGone(sticky))
    ) {
      // Defer: do not clear a real other-kill pending forever — just don't block this tick.
      return false;
    }
    return false;
  }

  /**
   * If phantom-clear / race wiped pending but a fresh own-kill site remains,
   * re-arm so cargo scoop owns the tick before portal-drift cold heal.
   */
  function rearmPendingCombatCargoFromRecentKillSite() {
    if (!AUTO.collectCargo || AUTO.pendingCombatCargo) return false;
    if (!canCollectCargoNow() || hasLivingStickyCombat()) return false;
    // Prefer mandatory phase (survives settle-skip / fightable flicker on sites).
    const phase = AUTO.mandatoryPostKillCargo;
    if (
      phase &&
      phase.x != null &&
      phase.y != null &&
      !isNpcStillFightable(phase.npcId) &&
      !isCargoSettledForNpc(phase.npcId)
    ) {
      AUTO.pendingCombatCargo = {
        x: phase.x,
        y: phase.y,
        npcId: phase.npcId,
        at: phase.at || Date.now(),
        failCount: 0,
        lateArm: true,
      };
      return true;
    }
    pruneRecentCargoKillSites();
    const now = Date.now();
    let best = null;
    for (const site of AUTO.recentCargoKillSites || []) {
      if (!site || now - site.at > POST_KILL_CARGO_WAIT_MS) continue;
      if (site.npcId && isCargoSettledForNpc(site.npcId)) continue;
      // mac41: counted kills stay eligible despite brief fightable flicker.
      if (
        site.npcId &&
        isNpcStillFightable(site.npcId) &&
        !AUTO.countedNpcKillIds.has(site.npcId)
      ) {
        continue;
      }
      if (!best || site.at > best.at) best = site;
    }
    if (!best || best.x == null || best.y == null) return false;
    AUTO.pendingCombatCargo = {
      x: best.x,
      y: best.y,
      npcId: best.npcId,
      at: best.at,
      failCount: 0,
      lateArm: true,
    };
    enterMandatoryPostKillCargoPhase(best.npcId, best.x, best.y, best.at);
    return true;
  }

  /** True when we still have a living combat sticky (must not freeze for cargo wait). */
  function hasLivingStickyCombat() {
    const id =
      AUTO.combatFocusId ||
      AUTO.combatTargetId ||
      (AUTO.currentTask === "combat" ? AUTO.taskTargetId : null);
    if (!id) return false;
    // mac43: post-kill cargo owns the tick — HP flicker must not block scoop.
    if (isPostKillCargoNpcId(id)) {
      if (isGenuineNpcRecovery(id)) return true;
      return false;
    }
    return (
      isNpcStillFightable(id) ||
      Boolean(getNpcSprite(id)?.alive) ||
      !isCombatTargetConfirmedGone(id)
    );
  }

  /** Keep lock/fire on sticky id during brief invalid frames (finish the kill). */
  function sustainCombatOnStickyId(npcId) {
    if (!npcId) return false;
    const input = getInputSystem();
    if (!input) return false;
    trackNpcPosition(npcId);
    setLockedTarget(npcId);
    engageNpc(npcId);
    input.syncAttackSession?.();
    setStatus("Finisco il bersaglio...");
    return true;
  }

  function getNpcEntry(id) {
    const sprite = getNpcSprite(id);
    const state = getGameState()?.npcs?.get?.(id);
    const ship = getShipPosition();
    if (!ship) return null;

    // Schema living with HP wins over sprite.alive / alive===false flicker.
    if (state) {
      if (state.hp != null && Number(state.hp) > 0) {
        // fightable despite alive flicker
      } else if (state.hp != null && Number(state.hp) <= 0) {
        return null;
      } else if (state.alive === false && !sprite?.alive) {
        // alive=false with unknown HP and dead/missing sprite → gone
        return null;
      }
      // alive=false + unknown HP + living sprite: keep fighting (hit-handler flicker)
    }

    const stateAlive = Boolean(state && state.alive !== false);
    const spriteAlive = Boolean(sprite?.alive);
    if (!stateAlive && !spriteAlive) {
      // HP>0 already handled above; no state and dead sprite → gone.
      if (!(state && state.hp != null && Number(state.hp) > 0)) return null;
    }

    if (!isNpcAllowedForCombat(id)) return null;

    const pos =
      (spriteAlive || sprite ? getNpcPosition(sprite) : null) ||
      (state && state.x != null && state.y != null ? { x: state.x, y: state.y } : null) ||
      getNpcLastPosition(id);
    if (!pos) return null;

    const type =
      getSpriteNpcType(sprite) ||
      state?.npc_type ||
      AUTO.trackedNpcTypes.get(id) ||
      null;
    if (!type) return null;

    return {
      id,
      x: pos.x,
      y: pos.y,
      dist: distance(ship.x, ship.y, pos.x, pos.y),
      type,
      name: getNpcTypeLabel(type),
    };
  }

  /**
   * Sticky combat lookup: same as getNpcEntry but keeps a living focus even when
   * honor-filter briefly excludes it — caller decides foreign abandon separately.
   */
  function getStickyCombatNpcEntry(id) {
    if (!id) return null;
    const entry = getNpcEntry(id);
    if (entry) return entry;
    if (!isNpcStillFightable(id)) return null;
    const sprite = getNpcSprite(id);
    const state = getGameState()?.npcs?.get?.(id);
    const ship = getShipPosition();
    if (!ship) return null;
    const pos =
      getNpcPosition(sprite) ||
      (state && state.x != null ? { x: state.x, y: state.y } : null) ||
      getNpcLastPosition(id);
    if (!pos) return null;
    const type =
      getSpriteNpcType(sprite) ||
      state?.npc_type ||
      AUTO.trackedNpcTypes.get(id) ||
      null;
    if (!type) return null;
    return {
      id,
      x: pos.x,
      y: pos.y,
      dist: distance(ship.x, ship.y, pos.x, pos.y),
      type,
      name: getNpcTypeLabel(type),
    };
  }

  function resolveRaidCombatTarget(preferredId) {
    // Sticky-first: finish the current kill before hopping to another NPC (any type).
    // Acquisition (no living sticky) still uses nearest / local-threat below.
    const fireRange = getPlayerFireRange();

    if (preferredId && isNpcAllowedForCombat(preferredId)) {
      const preferred =
        getStickyCombatNpcEntry(preferredId) || getNpcEntry(preferredId);
      if (
        preferred &&
        (isNpcStillFightable(preferredId) ||
          getNpcSprite(preferredId)?.alive ||
          !isCombatTargetConfirmedGone(preferredId))
      ) {
        return preferred;
      }
    }

    const near = listNpcs(fireRange + 150);
    const localAttacker = near.find((n) => isNpcAttackingPlayer(n.id));
    const localInRange = near.find((n) => n.dist <= fireRange + 40);
    const localThreat = localAttacker || localInRange || null;

    const input = getInputSystem();
    const nearestId = input?.findNearestEnemy?.();
    let nearest =
      nearestId && isNpcAllowedForCombat(nearestId) ? getNpcEntry(nearestId) : null;

    if (localThreat) {
      if (!nearest) {
        nearest = localThreat;
      } else if (
        nearest.id !== localThreat.id &&
        (nearest.dist > localThreat.dist + 160 ||
          (isNpcAttackingPlayer(localThreat.id) && nearest.dist > fireRange + 80))
      ) {
        nearest = localThreat;
      }
    }

    if (nearest) return nearest;

    const preferred =
      preferredId && isNpcAllowedForCombat(preferredId) ? getNpcEntry(preferredId) : null;
    if (preferred) return preferred;

    const lockedId = getGameState()?.lockedTargetId;
    if (lockedId && isNpcAllowedForCombat(lockedId)) {
      const locked = getNpcEntry(lockedId);
      if (locked) return locked;
    }

    return listNpcs(0)[0] || null;
  }

  function sustainRaidAttack(input) {
    const K = getGameState();
    const id = K?.lockedTargetId;
    if (!input || !id || !getNpcEntry(id)) return false;
    if (input.canFire?.(id) !== "ok") return false;
    if (!input.attackMode) input.attackMode = true;
    input.syncAttackSession?.();
    return true;
  }

  function engageRaidNearestEnemy() {
    const input = getInputSystem();
    if (!input) return false;

    const npc = resolveRaidCombatTarget();
    if (!npc) return false;

    if (!engageNpc(npc.id)) return false;

    AUTO.combatTargetId = npc.id;
    AUTO.combatFocusId = npc.id;
    AUTO.taskTargetId = npc.id;
    trackNpcType(npc.id, npc.type);
    trackNpcPosition(npc);
    AUTO.watchedNpcIds.add(npc.id);
    sustainRaidAttack(input);
    return true;
  }

  function getRaidCombatNpc() {
    return resolveRaidCombatTarget(AUTO.taskTargetId);
  }

  function startRaidCombatTask() {
    if (!engageRaidNearestEnemy()) return false;
    const npc = getRaidCombatNpc();
    if (!npc) return false;

    AUTO.currentTask = "combat";
    AUTO.taskTargetId = npc.id;
    AUTO.combatTargetId = npc.id;
    AUTO.combatFocusId = npc.id;
    AUTO.chasingBonusId = null;
    AUTO.pendingCollectId = null;
    // B: keep session CW/CCW across engage if already set
    if (AUTO.orbitDirection) softResetOrbitForRetarget();
    else resetOrbitState();
    return true;
  }

  function engageNpc(id) {
    const input = getInputSystem();
    const npc = getNpcEntry(id);
    const K = getGameState();
    if (!input || !npc || !K) return false;

    if (!canEngageFarmCombat()) {
      if (AUTO.workingMapId && getCurrentMapId() !== AUTO.workingMapId && !AUTO.raidGateId) {
        setStatus("status.wrong_map_no_farm", {
          map: formatMapLabel(AUTO.workingMapId) || AUTO.workingMapId,
        });
      }
      return false;
    }

    if (!isNpcAllowedForCombat(id)) {
      markForeignNpc(id);
      setStatus("NPC di un altro giocatore — ignoro (onore)");
      return false;
    }

    const canFire = input.canFire?.(id);
    if (canFire !== "ok") {
      if (canFire && canFire !== "dead") setStatus(`Combattimento: ${canFire}`);
      return false;
    }

    const alreadyLocked = K.lockedTargetId === id;
    setLockedTarget(id);
    // Foreign grey lock only — never abandon our own red circle when helpers join.
    if (K.lockTargetOwnedByOther && !isOwnLockOnNpc(id)) {
      markForeignNpc(id);
      clearLockedTarget();
      setStatus("NPC di un altro giocatore — ignoro (onore)");
      return false;
    }
    trackNpcType(npc.id, npc.type);
    trackNpcPosition(npc);
    AUTO.watchedNpcIds.add(id);
    input.notifyPlayerLocked?.(id);

    if (alreadyLocked) {
      input.attackMode = true;
      input.syncAttackSession?.();
    } else {
      input.pendingAttackOnLock = id;
    }
    return true;
  }

  function stopCombat() {
    AUTO.combatActive = false;
    AUTO.combatTargetTypes = null;
    AUTO.combatTargetId = null;
    AUTO.combatFocusId = null;
    AUTO.combatOrbitEngagedIds.clear();
    AUTO.combatEngageNpcId = null;
    AUTO.combatEngageStartedAt = 0;
    if (AUTO.currentTask === "combat") clearCurrentTask();
    const input = getInputSystem();
    if (input) {
      input.attackMode = false;
      input.pendingAttackOnLock = null;
    }
    if (!AUTO.active) {
      if (input) input.moveTarget = null;
      clearLockedTarget();
    }
    updatePlayControls();
    updateNpcListVisuals();
  }

  function pauseCombatForFlee() {
    clearCurrentTask();
    AUTO.combatFocusId = null;
    AUTO.combatTargetId = null;
    AUTO.raidFleeTarget = null;
    AUTO.raidHealSide = -1;
    AUTO.raidHealPhase = null;
    resetOrbitState();
    // Suspend cargo-clear / combat orbit retargets — heal owns movement.
    clearRaidCargoClearState();
    const input = getInputSystem();
    if (input) {
      input.attackMode = false;
      input.pendingAttackOnLock = null;
      clearRaidHealMovement(input);
    }
    clearLockedTarget();
  }

  function resumeCombatAfterFlee() {
    if (!AUTO.combatSuspendedForFlee) return false;
    if (!AUTO.active || !AUTO.modeAttack) {
      AUTO.combatSuspendedForFlee = false;
      return false;
    }
    if (AUTO.postDeathRecover) return false;
    if (AUTO.portalWaitUntil && Date.now() < AUTO.portalWaitUntil) return false;
    if (AUTO.coffeeBreakUntil && Date.now() < AUTO.coffeeBreakUntil) return false;
    if (AUTO.coffeeBreakActive || NAV.kind === "coffee") return false;
    if (shouldFleeByHp() || isRaidHealActive() || AUTO.fleeActive || NAV.active) return false;
    // Flee-to-heal: never resume until HP+shield are full (Play recover standard).
    if (!isPlayerFullyHealed()) {
      if (!AUTO.postDeathRecover) beginPreObjectiveHeal({ armBaseWait: false });
      return false;
    }
    // mac42: never resume farm on the wrong map after flee/heal — return first.
    if (AUTO.workingMapId && getCurrentMapId() !== AUTO.workingMapId && !AUTO.raidGateId) {
      AUTO.combatSuspendedForFlee = false;
      ensureReturnToWorkingMap("after_flee");
      return false;
    }
    if (!canEngageFarmCombat()) {
      AUTO.combatSuspendedForFlee = false;
      return false;
    }
    if (AUTO.selectedNpcTypes.size === 0) {
      AUTO.combatSuspendedForFlee = false;
      return false;
    }

    AUTO.combatSuspendedForFlee = false;
    if (!AUTO.combatActive) startCombatFromSelection();
    setStatus("Riparato — riprendo attacco");
    return true;
  }

  function suspendCombatForFlee() {
    pauseCombatForFlee();
    if (AUTO.modeAttack) AUTO.combatSuspendedForFlee = true;
  }

  function startCombatFromSelection() {
    AUTO.combatTargetTypes = new Set(AUTO.selectedNpcTypes);
    AUTO.combatActive = true;
    return true;
  }

  function resolveCombatTarget() {
    return nearestNpcOfTypes(AUTO.combatTargetTypes);
  }

  function getFocusedCombatNpc() {
    if (!AUTO.combatActive || !AUTO.combatTargetTypes?.size) return null;

    // Heal combatFocus ↔ taskTarget desync: prefer the active combat task id.
    if (
      !AUTO.combatFocusId &&
      AUTO.currentTask === "combat" &&
      AUTO.taskTargetId
    ) {
      AUTO.combatFocusId = AUTO.taskTargetId;
    }

    if (AUTO.combatFocusId) {
      const focused =
        getNpcEntry(AUTO.combatFocusId) || getStickyCombatNpcEntry(AUTO.combatFocusId);
      // Sticky finish-kill: keep living focus even if type set briefly diverged
      // (raid sync adding other types must not hop mid-fight).
      if (
        focused &&
        (AUTO.combatTargetTypes.has(focused.type) ||
          isNpcStillFightable(focused.id) ||
          getNpcSprite(focused.id)?.alive)
      ) {
        AUTO.combatTargetGoneAt = 0;
        clearFalsePendingCargoForLivingTarget(focused.id);
        return focused;
      }
      // Brief invalid frame — keep focus until confirmed gone (do not hop to nearest).
      if (!isCombatTargetConfirmedGone(AUTO.combatFocusId)) {
        clearFalsePendingCargoForLivingTarget(AUTO.combatFocusId);
        return (
          getStickyCombatNpcEntry(AUTO.combatFocusId) ||
          focused ||
          null
        );
      }
      // Standard maps: never drop a still-drawn sprite for a random nearest hop.
      if (!isInRaidMap() && getNpcSprite(AUTO.combatFocusId)?.alive) {
        AUTO.combatTargetGoneAt = 0;
        clearFalsePendingCargoForLivingTarget(AUTO.combatFocusId);
        return getStickyCombatNpcEntry(AUTO.combatFocusId);
      }
      AUTO.combatFocusId = null;
      AUTO.combatTargetGoneAt = 0;
    }

    // Soft band early-heal: do not open a new sticky when already ≤ thr+tol.
    if (shouldBlockNewEngageForHealBand()) return null;

    const npc = resolveCombatTarget();
    if (npc) AUTO.combatFocusId = npc.id;
    return npc;
  }

  function getBoxById(id) {
    return getCollectibleById(id);
  }

  function clearCurrentTask() {
    const K = getGameState();
    const input = getInputSystem();
    if (
      K &&
      AUTO.currentTask === "collect" &&
      AUTO.taskTargetId &&
      K.cargoTargetId === AUTO.taskTargetId
    ) {
      K.cargoTargetId = null;
    }
    if (AUTO.currentTask === "collect" && input?.moveTarget) {
      input.moveTarget = null;
    }
    AUTO.currentTask = null;
    AUTO.taskTargetId = null;
    AUTO.chasingBonusId = null;
    AUTO.pendingCollectId = null;
  }

  function clearTaskIfDone() {
    if (AUTO.currentTask === "combat" && AUTO.taskTargetId) {
      const deadNpcId = AUTO.taskTargetId;

      // Honor: another player took the target — abandon without treating as our kill.
      if (
        isNpcStillFightable(deadNpcId) &&
        !isNpcAllowedForCombat(deadNpcId) &&
        isNpcEngagedByOtherPlayer(deadNpcId)
      ) {
        AUTO.combatTargetGoneAt = 0;
        markForeignNpc(deadNpcId);
        return;
      }

      if (
        isNpcStillFightable(deadNpcId) ||
        getStickyCombatNpcEntry(deadNpcId) ||
        getNpcSprite(deadNpcId)?.alive
      ) {
        AUTO.combatTargetGoneAt = 0;
        clearFalsePendingCargoForLivingTarget(deadNpcId);
        return;
      }

      // Sprite/schema flicker: stick until confirmed gone — do not retarget yet.
      if (!isCombatTargetConfirmedGone(deadNpcId)) {
        return;
      }

      AUTO.combatTargetGoneAt = 0;
      const killPos = getNpcLastPosition(deadNpcId) || getShipPosition();
      // Re-check living after confirm window — flicker can restore the NPC.
      if (
        isNpcStillFightable(deadNpcId) ||
        getNpcSprite(deadNpcId)?.alive
      ) {
        clearFalsePendingCargoForLivingTarget(deadNpcId);
        reclaimFalselyCountedLivingNpc(deadNpcId);
        return;
      }
      if (AUTO.collectCargo && AUTO.combatActive && wasActivelyAttackingNpc(deadNpcId)) {
        notePendingCombatCargo(deadNpcId, killPos);
      }
      AUTO.combatFocusId = null;
      AUTO.combatTargetId = null;
      clearCurrentTask();
      // GOLDEN RULE: scoop preempts retarget until done/missed (cargo may appear late).
      // Raid: also hold when ANY visible leftover cargo remains (wave / stage idle).
      if (AUTO.pendingCombatCargo && canCollectCargoNow()) {
        if (
          !isInRaidMap() ||
          findCargoForPendingKill(AUTO.pendingCombatCargo) ||
          findNearestRaidVisibleCargo()
        ) {
          pauseCombatForPostKillCargo(deadNpcId);
        }
        return;
      }
      if (
        isInRaidMap() &&
        AUTO.collectCargo &&
        canCollectCargoNow() &&
        findNearestRaidVisibleCargo()
      ) {
        // Leftover wave/stage cargo — do not start next sticky; sweep owns next ticks.
        return;
      }
      if (isInRaidMap() && AUTO.combatActive && AUTO.modeAttack) {
        const next = resolveRaidCombatTarget();
        if (next) startCombatTask(next, { preserveOrbit: true });
      }
      return;
    }

    if (AUTO.currentTask === "collect" && AUTO.taskTargetId) {
      const item = getCollectibleById(AUTO.taskTargetId);
      if (!item && !getLootSprite(AUTO.taskTargetId)) {
        const lootId = AUTO.taskTargetId;
        // Loot gone: end post-kill lifecycle immediately so drivePending cannot
        // soft-wait the full POST_KILL_CARGO_WAIT_MS on an empty death spot.
        // count:false — lootRemove/collectSuccess own the tally when they fire.
        if (
          AUTO.pendingCombatCargo ||
          AUTO.cargoCollectInFlightId === lootId ||
          isCargoCollectAlreadyDone(lootId)
        ) {
          finishCombatCargoCollect(lootId, { count: false });
          return;
        }
        clearCurrentTask();
      }
    }
  }

  function startCombatTask(npc, options = {}) {
    if (!npc) return false;
    AUTO.currentTask = "combat";
    AUTO.taskTargetId = npc.id;
    AUTO.combatFocusId = npc.id;
    AUTO.combatTargetId = npc.id;
    AUTO.combatTargetGoneAt = 0;
    noteCombatEngageStart(npc.id);
    trackNpcType(npc.id, npc.type);
    trackNpcPosition(npc);
    AUTO.chasingBonusId = null;
    AUTO.pendingCollectId = null;
    // Raid kill→retarget: keep orbit direction / wide kite; do not randomize CW/CCW
    if (options.preserveOrbit && isInRaidMap()) {
      softResetOrbitForRetarget();
    } else {
      resetOrbitState();
    }
    return true;
  }

  function startCollectTask(box) {
    if (!isBotLive()) return false;
    if (!box) return false;
    if (box.kind === "cargo") {
      if (!canCollectCargoNow()) {
        blockCargoUntilHoldFrees("status.cargo_hold_full");
        return false;
      }
      const spr = getLootSprite(box.id);
      if (isForeignOwnedLoot(box.id, spr)) return false;
      if (!isAllowedCombatCargo(box.id, spr)) return false;
    } else if (isForeignOwnedLoot(box.id)) {
      return false;
    }
    AUTO.currentTask = "collect";
    AUTO.taskTargetId = box.id;
    AUTO.chasingBonusId = box.id;
    AUTO.pendingCollectId = box.id;
    // Come un click sul loot: attiva path nativo (animazione + collect automatico)
    armNativeCollect(box.id);
    return true;
  }

  function pickNewTask() {
    if (AUTO.currentTask) return false;
    if (isRaidHealActive()) return false;

    // Drop phantom pending before it can block combat forever.
    if (AUTO.pendingCombatCargo?.npcId) {
      clearFalsePendingCargoForLivingTarget(AUTO.pendingCombatCargo.npcId);
    }

    if (tryStartPostKillCargoCollect()) return true;

    // HARD RULE: while post-kill cargo lifecycle is open, never start heal / next NPC /
    // bonus — scoop owns the window until collected or full WAIT_MS despawn.
    if (hasOpenPostKillCargoLifecycle()) return false;

    // Living sticky fight owns combat kite — never start cargo clear/scoop first.
    // (mac28 left this ungated: brief currentTask=null → cargo dive → closer stand-off.)
    if (isInRaidMap() && hasLivingStickyCombat()) {
      if (
        canEngageFarmCombat() &&
        AUTO.modeAttack &&
        AUTO.combatActive &&
        startRaidCombatTask()
      ) {
        return true;
      }
      return false;
    }

    // Raid Gate: sweep every visible cargo before hunting the next NPC.
    if (isInRaidMap() && AUTO.collectCargo && canCollectCargoNow()) {
      const raidCargo = findNearestRaidVisibleCargo(getShipPosition());
      if (raidCargo) {
        const shipNow = getShipPosition();
        if (
          isRaidCargoApproachUnsafe(raidCargo, shipNow) ||
          isRaidShipThreatenedForCargo(shipNow)
        ) {
          armRaidCargoClear(raidCargo);
          // driveRaidCargoSweepTick owns BREAKOUT/CLEARING on the next tick.
          return false;
        }
        if (startCollectTask(raidCargo)) {
          AUTO.raidCargoClear = {
            cargoId: raidCargo.id,
            x: raidCargo.x,
            y: raidCargo.y,
            phase: "SCOOP",
            startedAt: Date.now(),
            clearingEnteredAt: 0,
            cargoClearSince: Date.now(),
            scoopCooldownUntil: 0,
            approachR: null,
            angle: null,
            dir: AUTO.orbitDirection || 1,
            holdUntil: 0,
          };
          setStatus("status.raid_cargo_sweep", { dist: Math.round(raidCargo.dist) });
          return true;
        }
      }
    }

    // Portal drift hold: heal Attack config in place before hunting the next NPC.
    if (maybeBeginPortalDriftPostKillHeal()) return false;

    if (AUTO.modeAttack && AUTO.combatActive) {
      if (!canEngageFarmCombat()) {
        // Wrong map / Sector Z: never pick farm combat (nav/heal/flee still OK).
        // mac42: actively return to working map instead of farming here.
        if (ensureReturnToWorkingMap("farm_gate")) return true;
      } else if (isInRaidMap()) {
        if (startRaidCombatTask()) return true;
      } else {
        // Soft band: don't hunt a new NPC when already in early-heal HP band.
        if (shouldBlockNewEngageForHealBand()) return false;
        // Sticky: re-lock same focus before hopping to a random nearest NPC.
        const npc = getFocusedCombatNpc();
        if (npc && startCombatTask(npc)) return true;
      }
    }

    if (hasAnyCollectMode()) {
      const items = listCollectibles(AUTO.bonusRadius);
      if (items.length > 0 && startCollectTask(items[0])) return true;
    }

    return false;
  }

  function isCombatEngaged() {
    if (AUTO.currentTask !== "combat" || !AUTO.taskTargetId) return false;
    if (getNpcEntry(AUTO.taskTargetId) || getStickyCombatNpcEntry(AUTO.taskTargetId)) {
      return true;
    }
    return !isCombatTargetConfirmedGone(AUTO.taskTargetId);
  }

  function listBonusesInAttackRange(npc) {
    const ship = getShipPosition();
    if (!ship || !npc) return [];

    return listCollectibles(AUTO.attackRange).filter((item) => {
      if (item.dist > AUTO.attackRange) return false;
      const boxToNpc = distance(item.x, item.y, npc.x, npc.y);
      return boxToNpc <= AUTO.attackRange;
    });
  }

  function tryOpportunisticCollect(npc) {
    if (!hasAnyCollectMode() || !npc || AUTO.currentTask !== "combat") return false;
    if (AUTO.pendingCombatCargo) return false;

    const ship = getShipPosition();
    const input = getInputSystem();
    if (!ship || !input) return false;

    if (npc.dist > AUTO.attackRange) return false;

    const items = listBonusesInAttackRange(npc).filter((item) => {
      if (item.kind === "cargo") return false;
      if (item.kind === "bonus") return AUTO.collectBonus;
      if (item.kind === "booty") return canCollectBootyNow();
      return false;
    });
    if (!items.length) return false;

    const item = items[0];
    const ap = approachPoint(item);
    const distAp = distance(ship.x, ship.y, ap.x, ap.y);
    // Solo se già nel raggio collect nativo: altrimenti interromperebbe l'attacco per andare al loot
    if (distAp > getCollectTriggerDistance(item)) return false;

    const now = Date.now();
    if (now - AUTO.lastCollectSendAt <= 700) return false;

    if (!armNativeCollect(item.id, { keepAttack: true })) return false;
    engageNpc(npc.id);
    input.syncAttackSession?.();
    setStatus(`Raccolta ${item.kind} (${Math.round(distAp)}m) + attacco ${npc.name}`);
    return true;
  }

  function isRaidExecutionerRound() {
    // Solo ultimo round (11/11). Latch once so attack↔executioner config does not flap.
    if (!isInRaidMap()) {
      AUTO.raidExecutionerLatched = false;
      return false;
    }
    if (AUTO.raidExecutionerLatched) return true;
    const K = getGameState();
    if (K?.raidIsLastStage) {
      AUTO.raidExecutionerLatched = true;
      return true;
    }
    for (const npc of listNpcs(0)) {
      if (npc.type === "EXECUTIONER" || npc.type === "EXECUTIONER1") {
        AUTO.raidExecutionerLatched = true;
        return true;
      }
    }
    return false;
  }

  function getRaidAttackConfig() {
    // Ultimo round: config Executioner dedicata per orbitare/attaccare.
    if (isRaidExecutionerRound()) return AUTO.executionerConfig;
    return AUTO.attackConfig;
  }

  function getRaidFleeConfig() {
    // Stesso round: stessa config anche in fuga/rientro (Executioner troppo veloci).
    if (isRaidExecutionerRound()) return AUTO.executionerConfig;
    return AUTO.runConfig;
  }

  function driveRaidCombatEngage(npc) {
    // Story 3 driveRaidCombatEngage (~2828): approach on NPC ring → applyCombatOrbit + shoot every tick.
    // Heal-flee and encircle/wave breakout divert movement first; orbit resumes when clear.
    const input = getInputSystem();
    const ship = getShipPosition();
    if (!input || !ship) return false;

    // HP% flee owns movement — never let orbit overwrite the evade waypoint.
    if (isRaidHealActive()) {
      return driveRaidHealTick(input, ship);
    }

    // Abort cargo walk/FSM only if it is actually interfering (not toggle alone).
    if (
      AUTO.collectCargo &&
      hasLivingStickyCombat() &&
      hasInterferingRaidCargoState()
    ) {
      releaseRaidCargoClearForCombat();
    }

    if (abandonForeignLockedTarget()) return true;

    if (maintainRaidSupportDuringCombat(input, ship)) return true;

    ensureActiveConfig(getRaidAttackConfig());
    const game = getGame();
    if (game?.isPaused) game.resume();

    npc = resolveRaidCombatTarget(npc?.id || AUTO.taskTargetId);
    if (!npc) {
      // Never stand still on Executioner round — keep kiting until a lock exists.
      if (needsRaidWaveBreakout(ship) || isRaidExecutionerRound()) {
        const breakout = getRaidBreakoutPoint(ship);
        AUTO.lastMinimapMoveAt = 0;
        AUTO.lastMinimapTarget = null;
        AUTO.orbitHumanHoldUntil = 0;
        moveViaMinimap(breakout.x, breakout.y);
        setStatus(
          isRaidExecutionerRound()
            ? "Raid Executioner: mi tengo in movimento"
            : "Raid: attendo spawn — mi tengo fuori dal centro"
        );
        return true;
      }
      setStatus("Raid: cerco bersaglio...");
      return true;
    }

    AUTO.taskTargetId = npc.id;
    AUTO.combatTargetId = npc.id;
    AUTO.combatFocusId = npc.id;
    syncMinimapSoftMoveSticky(npc.id);

    if (getGameState()?.lockedTargetId !== npc.id) {
      setLockedTarget(npc.id);
      input.notifyPlayerLocked?.(npc.id);
    }

    trackNpcPosition(npc);
    applySmartCombatAmmo(npc.id);

    // Encircle / first-wave pressure: single breakout mover, keep shooting, then back to orbit.
    if (driveRaidWaveBreakout(input, ship, npc)) return true;

    const { maxR, fireRange } = getOrbitRadii(npc);
    // Story 3 approachLimit = maxR + 12 (not fireRange+40 / tower approach)
    const approachLimit = AUTO.modeOrbit ? maxR + 12 : fireRange;
    const execFluid = isRaidExecutionerRound();

    if (npc.dist > approachLimit) {
      // A: move every tick from first engage — NPC-radial approach (Story 3 getOrbitApproachPoint)
      // mac46: approach = gameplay hold click; escape breakout stays on minimap.
      if (AUTO.modeOrbit || execFluid) {
        const ap = getOrbitApproachPoint(npc);
        setMoveTargetDirect(input, ap.x, ap.y);
        AUTO.lastMinimapTarget = { x: ap.x, y: ap.y };
        AUTO.lastMinimapMoveAt = Date.now();
        AUTO.lastRaidOrbitMoveAt = Date.now();
      } else if (shouldChaseCombatTarget(npc, fireRange)) {
        setMoveTargetDirect(input, npc.x, npc.y);
      } else {
        clearCombatMoveTarget(input);
      }
      engageNpc(npc.id);
      setStatus(
        AUTO.modeOrbit || execFluid
          ? `Raid orbita: ${npc.name} (${Math.round(npc.dist)}m)`
          : `Raid: avvicino ${npc.name} (${Math.round(npc.dist)}m)`
      );
      return true;
    }

    engageNpc(npc.id);
    sustainRaidAttack(input);

    if (AUTO.modeOrbit || execFluid) {
      // A: orbit tick every combat cycle once in band (Story 3 applyCombatOrbit).
      // Executioner / config-2 path: force continuous kite even if Orbit UI is off —
      // never clearMoveTarget / stand still (Executioners catch up and shred).
      applyCombatOrbit(npc, execFluid && !AUTO.modeOrbit ? { force: true } : undefined);
      engageNpc(npc.id);
      sustainRaidAttack(input);
      setStatus(`Raid orbita ${npc.name}: ${Math.round(npc.dist)}m`);
    } else {
      clearRaidHealMovement(input);
      if (shouldChaseCombatTarget(npc, fireRange)) {
        setMoveTargetDirect(input, npc.x, npc.y);
        setStatus(`Raid: inseguo ${npc.name} (${Math.round(npc.dist)}m)`);
      } else {
        clearCombatMoveTarget(input);
        setStatus(`Raid: attacco ${npc.name} (${Math.round(npc.dist)}m)`);
      }
    }

    if (hasAnyCollectMode()) {
      tryOpportunisticCollect(npc);
      engageNpc(npc.id);
      sustainRaidAttack(input);
    }
    return true;
  }

  function driveCombatEngage(npc) {
    const input = getInputSystem();
    if (!input || !npc) return false;

    if (abandonForeignLockedTarget()) return true;

    const focusId = npc.id;
    npc = getNpcEntry(focusId) || getStickyCombatNpcEntry(focusId);
    if (!npc) {
      // Brief invalid / alive flicker — keep firing until confirmed gone.
      if (
        !isCombatTargetConfirmedGone(focusId) ||
        getNpcSprite(focusId)?.alive
      ) {
        clearFalsePendingCargoForLivingTarget(focusId);
        sustainCombatOnStickyId(focusId);
        return true;
      }
      // Confirmed gone: arm post-kill cargo BEFORE clearing sticky so portal-drift
      // heal cannot win the same gap (clearTaskIfDone may already have run).
      if (AUTO.collectCargo && AUTO.combatActive) {
        notePendingCombatCargo(focusId, getNpcLastPosition(focusId));
      }
      AUTO.combatTargetGoneAt = 0;
      AUTO.combatFocusId = null;
      AUTO.combatTargetId = null;
      clearCurrentTask();
      if (AUTO.pendingCombatCargo) {
        pauseCombatForPostKillCargo(focusId);
        setStatus("status.cargo_wait");
      } else {
        setStatus("NPC di un altro giocatore — cerco altro bersaglio");
      }
      return true;
    }

    AUTO.combatTargetGoneAt = 0;
    clearFalsePendingCargoForLivingTarget(npc.id);

    const ship = getShipPosition();
    if (ship && !isRaidHealActive() && maintainRaidSupportDuringCombat(input, ship)) {
      return true;
    }

    ensureActiveConfig(AUTO.attackConfig);

    AUTO.combatTargetId = npc.id;
    AUTO.combatFocusId = npc.id;
    syncMinimapSoftMoveSticky(npc.id);
    trackNpcPosition(npc);
    noteCombatEngageStart(npc.id);
    updateCombatOrbitEngagement(npc);
    applySmartCombatAmmo(npc.id);
    const game = getGame();
    if (game?.isPaused) game.resume();

    setLockedTarget(npc.id);
    // Fire first — portal drift must not leave an unhit sticky.
    engageNpc(npc.id);
    input.syncAttackSession?.();

    // Standard maps: encircle / corner trap breakout (light reuse of raid pattern).
    if (!isInRaidMap() && ship && driveStandardOrbitBreakout(input, ship, npc)) {
      return true;
    }

    // Portal drift owns movement while far from portal (interrupt orbit / approach).
    // Gated on first sticky hit / timeout inside drivePortalDriftRetreat.
    if (!isInRaidMap() && ship && drivePortalDriftRetreat(ship, npc)) {
      engageNpc(npc.id);
      input.syncAttackSession?.();
      return true;
    }

    if (!isInRaidMap()) updateStdCombatHitTracker();

    const { maxR, preferred, fireRange } = getOrbitRadii(npc);
    const holdOrbit = shouldHoldOrbitDistance(npc);
    // Orbit ON → approach to outer stand-off (maxR). Orbit OFF → only when out of laser.
    const approachLimit = holdOrbit ? maxR + 12 : fireRange;

    if (npc.dist > approachLimit) {
      // Standard: never dive into NPC body — approach outer stand-off (preferred/maxR).
      // Prefer continuous setMoveTarget (mouse-hold) over minimap click spam.
      const ap = getOrbitApproachPoint(npc);
      let tx = ap.x;
      let ty = ap.y;
      if (
        ship &&
        shouldSuppressStdInwardAfterHit(ship, npc, ap.x, ap.y)
      ) {
        const soft = softenStdOrbitPointAfterHit(ship, npc, ap.x, ap.y);
        tx = soft.x;
        ty = soft.y;
        noteStdOrbitRadialSign(ship, npc, tx, ty);
      } else if (
        ship &&
        holdOrbit &&
        isStdCombatRecentlyDamaged() &&
        npc.dist <= fireRange
      ) {
        const soft = softenStdOrbitPointAfterHit(ship, npc, ap.x, ap.y);
        tx = soft.x;
        ty = soft.y;
        noteStdOrbitRadialSign(ship, npc, tx, ty);
      } else if (holdOrbit || shouldChaseCombatTarget(npc, fireRange)) {
        if (ship) noteStdOrbitRadialSign(ship, npc, ap.x, ap.y);
      } else {
        clearCombatMoveTarget(input);
        input.pendingAttackOnLock = npc.id;
        setStatus(
          holdOrbit
            ? `Orbita: mi posiziono a ~${Math.round(maxR)}m (laser ~${Math.round(fireRange)}m)`
            : `Avvicino ${npc.name} (${Math.round(npc.dist)}m → ~${Math.round(preferred)}m)`
        );
        return true;
      }
      const held = AUTO.lastMinimapTarget;
      const heldAge = Date.now() - (AUTO.lastMinimapMoveAt || 0);
      if (
        held &&
        heldAge < 520 &&
        shouldKeepExistingMoveTarget({ moveTarget: held }, tx, ty)
      ) {
        setMoveTargetDirect(input, held.x, held.y);
      } else {
        setMoveTargetDirect(input, tx, ty);
        AUTO.lastMinimapTarget = { x: tx, y: ty };
        AUTO.lastMinimapMoveAt = Date.now();
      }
      input.pendingAttackOnLock = npc.id;
      setStatus(
        holdOrbit
          ? `Orbita: mi posiziono a ~${Math.round(maxR)}m (laser ~${Math.round(fireRange)}m)`
          : `Avvicino ${npc.name} (${Math.round(npc.dist)}m → ~${Math.round(preferred)}m)`
      );
      return true;
    }

    engageNpc(npc.id);
    input.syncAttackSession?.();
    updateCombatOrbitEngagement(npc);

    if (shouldHoldOrbitDistance(npc)) {
      applyCombatOrbit(npc);
      engageNpc(npc.id);
      input.syncAttackSession?.();
    } else {
      // In fire range, orbit off: hold / slight kite — never setMoveTargetDirect(npc).
      clearCombatMoveTarget(input);
    }

    if (hasAnyCollectMode()) {
      tryOpportunisticCollect(npc);
      engageNpc(npc.id);
      input.syncAttackSession?.();
    }

    if (shouldHoldOrbitDistance(npc)) {
      const orbit = getOrbitRadii(npc);
      setStatus(
        `Orbita ${npc.name}: ${Math.round(npc.dist)}m (band ${Math.round(orbit.minR)}-${Math.round(orbit.maxR)}m, laser ${Math.round(orbit.fireRange)}m)`
      );
    } else {
      setStatus(`In combattimento: ${npc.name} (${Math.round(npc.dist)}m)`);
    }
    return true;
  }

  function refreshNpcListUI() {
    installGameHooks();
    updateNpcListVisuals();
  }

  function nearestNpcOfType(typeKey) {
    const npcs = listNpcsByType(typeKey, 0);
    return npcs.length ? npcs[0] : null;
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function ensureUiLoop() {
    if (AUTO.uiLoopId) return;
    AUTO.uiLoopId = window.setInterval(() => {
      installGameHooks();
      noteLoginFormCredentials();
      tryCoffeeReloginTick();
      updateNpcListVisuals();
      updateGeneralPanel();
      updateStatisticsPanel();
      updateAttackAmmoButtons();
      syncSecurityPanelFromAuto();
      maybeDiscordNotifyStatsTick();
      if (AUTO.licenseKey && !isAppLicensed()) enforceLicenseGate();
      else updateLicenseLock();
      if (AUTO.raidGateId && isInRaidMap()) syncRaidNpcSelectionFromMap();
    }, AUTO.uiRefreshMs);
  }

  function getMinimapCanvas() {
    return document.querySelector("canvas.mm-canvas");
  }

  function ensureMarker() {
    if (document.getElementById(MARKER_ID)) return;
    const style = document.createElement("style");
    style.textContent = `
      #${MARKER_ID} {
        position: fixed;
        width: 12px;
        height: 12px;
        margin-left: -6px;
        margin-top: -6px;
        border-radius: 50%;
        background: rgba(255, 80, 80, 0.95);
        border: 2px solid #fff;
        box-shadow: 0 0 10px rgba(255, 80, 80, 0.9);
        z-index: 100001;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.15s ease;
      }
      #${MARKER_ID}.show { opacity: 1; }
    `;
    document.head.appendChild(style);
    const marker = document.createElement("div");
    marker.id = MARKER_ID;
    document.body.appendChild(marker);
  }

  function flashMinimapClick(clientX, clientY) {
    ensureMarker();
    const marker = document.getElementById(MARKER_ID);
    if (!marker) return;
    marker.style.left = `${clientX}px`;
    marker.style.top = `${clientY}px`;
    marker.classList.add("show");
    window.setTimeout(() => marker.classList.remove("show"), 450);
  }

  function dispatchMinimapPointer(canvas, clientX, clientY) {
    const common = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX,
      clientY,
      button: 0,
      pointerId: 42,
      pointerType: "mouse",
      isPrimary: true,
      view: window,
    };
    canvas.dispatchEvent(new PointerEvent("pointerdown", { ...common, buttons: 1 }));
    canvas.dispatchEvent(new PointerEvent("pointerup", { ...common, buttons: 0 }));
    flashMinimapClick(clientX, clientY);
  }

  function rememberMapDims(mapWidth, mapHeight) {
    if (mapWidth > 0 && mapHeight > 0) {
      AUTO.lastMapDims = { w: mapWidth, h: mapHeight };
    }
  }

  function syncMapDimsFromWindow() {
    const w = window.__RG_MAP_W__;
    const h = window.__RG_MAP_H__;
    if (w > 0 && h > 0) rememberMapDims(w, h);
  }

  function hookMinimap(minimap) {
    if (!minimap || minimap.__rgHooked) return;
    const original = minimap.onMapClick;
    minimap.onMapClick = function (worldX, worldY) {
      if (AUTO.lastMapDims) {
        rememberMapDims(AUTO.lastMapDims.w, AUTO.lastMapDims.h);
      }
      if (typeof original === "function") original(worldX, worldY);
    };
    minimap.__rgHooked = true;
  }

  function clickMinimapAtClient(clientX, clientY) {
    const canvas = getMinimapCanvas();
    if (!canvas) return false;
    dispatchMinimapPointer(canvas, clientX, clientY);
    return true;
  }

  function clickMinimapRandom() {
    const minimap = getMinimap();
    hookMinimap(minimap);
    syncMapDimsFromWindow();

    // Full-minimap random wander (map-wide). Do NOT bias to ship-relative nearby points.
    const canvas = getMinimapCanvas();
    if (canvas) {
      const rect = canvas.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) return false;
      const margin = 0.14;
      const rx = margin + Math.random() * (1 - margin * 2);
      const ry = margin + Math.random() * (1 - margin * 2);
      const clientX = rect.left + rect.width * rx;
      const clientY = rect.top + rect.height * ry;
      const ok = clickMinimapAtClient(clientX, clientY);
      if (ok) {
        const { w, h } = getMapBounds();
        if (w > 0 && h > 0) {
          AUTO.lastMinimapTarget = {
            x: clamp(w * rx, AUTO.mapSafeMargin || 100, w - (AUTO.mapSafeMargin || 100)),
            y: clamp(h * ry, AUTO.mapSafeMargin || 100, h - (AUTO.mapSafeMargin || 100)),
          };
          AUTO.lastMinimapMoveAt = Date.now();
        }
      }
      return ok;
    }

    if (minimap?.onMapClick && AUTO.lastMapDims) {
      const wx = AUTO.lastMapDims.w * (0.12 + Math.random() * 0.76);
      const wy = AUTO.lastMapDims.h * (0.12 + Math.random() * 0.76);
      const safe = clampToPlayArea(wx, wy);
      minimap.onMapClick(safe.x, safe.y);
      AUTO.lastMinimapTarget = safe;
      AUTO.lastMinimapMoveAt = Date.now();
      return true;
    }

    const { w, h } = getMapBounds();
    if (w > 0 && h > 0) {
      const safe = clampToPlayArea(
        w * (0.12 + Math.random() * 0.76),
        h * (0.12 + Math.random() * 0.76)
      );
      return moveViaMinimap(safe.x, safe.y);
    }

    return false;
  }

  function worldToClient(worldX, worldY) {
    const scene = getGameScene();
    const canvas = getCanvas();
    if (!scene || !canvas) return null;
    const camera = scene.cameras.main;
    const rect = canvas.getBoundingClientRect();
    let screenX = 0;
    let screenY = 0;

    if (camera && typeof camera.getScreenPoint === "function") {
      const out = camera.getScreenPoint(worldX, worldY);
      screenX = out.x;
      screenY = out.y;
    } else if (camera) {
      const zoom = camera.zoom || 1;
      screenX = (worldX - camera.scrollX) * zoom + camera.width * 0.5;
      screenY = (worldY - camera.scrollY) * zoom + camera.height * 0.5;
    } else {
      return null;
    }

    const scaleX = rect.width / (scene.scale.width || rect.width);
    const scaleY = rect.height / (scene.scale.height || rect.height);
    return {
      clientX: rect.left + screenX * scaleX,
      clientY: rect.top + screenY * scaleY,
    };
  }

  function worldToPhaserPointer(worldX, worldY) {
    const scene = getGameScene();
    if (!scene?.cameras?.main) return null;
    const camera = scene.cameras.main;
    let x = 0;
    let y = 0;
    if (typeof camera.getScreenPoint === "function") {
      const out = camera.getScreenPoint(worldX, worldY);
      x = out.x;
      y = out.y;
    } else {
      const zoom = camera.zoom || 1;
      x = (worldX - camera.scrollX) * zoom + camera.width * 0.5;
      y = (worldY - camera.scrollY) * zoom + camera.height * 0.5;
    }
    return {
      x,
      y,
      leftButtonDown: () => true,
      rightButtonDown: () => false,
      event: { target: scene.game?.canvas ?? getCanvas() },
    };
  }

  function approachPoint(box) {
    // Il client di gioco usa W3=95: moveTarget = (loot.x, loot.y - 95)
    return {
      x: box.x,
      y: box.y - AUTO.collectApproachOffset,
    };
  }

  function getCollectTriggerDistance(_item) {
    // Il client di gioco usa K3=15 sulla distanza dal punto di approach (loot.y - 95)
    return 15;
  }

  function clickLootViaInput(worldX, worldY) {
    const input = getInputSystem();
    const ptr = worldToPhaserPointer(worldX, worldY);
    if (!input || !ptr) return false;
    input.onPointerDown(ptr);
    return true;
  }

  /**
   * Path nativo di raccolta (come un click sul loot):
   * Imposta K.cargoTargetId → il client mostra cerchio/raggio, va a (x, y-95)
   * e quando dist < 15 fa sendCollect da solo.
   * NON usare setMoveTargetDirect/minimappa e NON chiamare sendCollect a mano.
   */
  function armNativeCollect(lootId, opts = {}) {
    if (!isBotLive()) return false;
    if (!lootId || isCargoCollectAlreadyDone(lootId)) return false;
    const K = getGameState();
    const input = getInputSystem();
    if (!K) return false;

    // Serve in K.loots: altrimenti il client azzera subito cargoTargetId
    if (!K.loots?.has?.(lootId)) return false;

    const sprite = getLootSprite(lootId);
    const lootType = getLootTypeFromId(lootId, sprite);
    const isCargo = lootType === "CARGO";
    const isBooty = lootType === "BOOTY_BOX";

    // mac32: never set cargoTargetId for cargo while sticky living in raid —
    // native client walks to (x, y-95) and collapses combat orbit stand-off.
    if (isCargo && isInRaidMap() && hasLivingStickyCombat()) return false;

    if (isCargo) {
      if (isCargoHoldFull()) return false;
      if (isForeignOwnedLoot(lootId, sprite)) return false;
      if (
        !isAllowedCombatCargo(lootId, sprite) &&
        !(AUTO.currentTask === "collect" && AUTO.taskTargetId === lootId)
      ) {
        return false;
      }
    } else if (isBooty) {
      if (!canCollectBootyNow()) return false;
    } else if (isForeignOwnedLoot(lootId, sprite)) {
      return false;
    }

    // Baule già in channel: non ri-cliccare / non muovere
    if (isBooty && K.bootyTargetId === lootId) return true;

    if (input && !opts.keepAttack) {
      input.attackMode = false;
      input.pendingAttackOnLock = null;
    }

    // Come un click umano: bonus, cargo e bauli usano tutti cargoTargetId
    K.cargoTargetId = lootId;
    AUTO.pendingCollectId = lootId;
    AUTO.chasingBonusId = lootId;
    AUTO.pendingBonusIds.add(lootId);
    AUTO.lastCollectSendAt = Date.now();
    if (isCargo || AUTO.pendingCombatCargo) {
      AUTO.cargoCollectInFlightId = lootId;
      AUTO.lastCargoCollectAttempt = {
        id: lootId,
        x: sprite?.x ?? AUTO.pendingCombatCargo?.x ?? K.loots?.get?.(lootId)?.x,
        y: sprite?.y ?? AUTO.pendingCombatCargo?.y ?? K.loots?.get?.(lootId)?.y,
        at: Date.now(),
      };
    }
    return true;
  }

  function forceCollect(lootId, opts = {}) {
    // Compat: opportunistic collect → path nativo (animazione + collect automatico)
    return armNativeCollect(lootId, opts);
  }

  function collectKindLabel(kind) {
    if (kind === "booty") return "baule";
    if (kind === "cargo") return "cargo";
    return "bonus";
  }

  function beginCollect(item) {
    armNativeCollect(item.id);
    AUTO.collectArriveAt = 0;
  }

  function driveCollect(item) {
    const input = getInputSystem();
    const ship = getShipPosition();
    const K = getGameState();
    if (!input || !ship || !item || !K) return;

    if (item.kind === "cargo") {
      // Living sticky kite owns stand-off — never dive/clear/arm mid-fight.
      if (isInRaidMap() && hasLivingStickyCombat()) {
        releaseRaidCargoClearForCombat();
        return;
      }
      if (abortCargoCollectIfHoldFull()) return;
      if (isForeignOwnedLoot(item.id, getLootSprite(item.id))) {
        finishCombatCargoCollect(item.id, { count: false });
        setStatus("status.honor_cargo");
        return;
      }
      if (!canCollectCargoNow()) {
        finishCombatCargoCollect(item.id, { count: false });
        return;
      }
      if (isCargoCollectAlreadyDone(item.id)) {
        finishCombatCargoCollect(item.id);
        return;
      }
      // Raid Gate: surrounded OR NPCs on cargo → breakout/clear before diving.
      // Critical: never sit still mid-pack with "raccolgo cargo" on a far drop.
      // Exception: already on the cargo entity → scoop immediately (contact rule).
      if (
        isInRaidMap() &&
        (isRaidShipThreatenedForCargo(ship) || isRaidCargoApproachUnsafe(item, ship))
      ) {
        if (isRaidCargoInContactRange(item, ship)) {
          armNativeCollect(item.id, { keepAttack: true });
          // Fall through to normal collect drive (do not clear→orbit away).
        } else {
          armRaidCargoClear(item, { fromBlockedScoop: true });
          clearCollectMovement(item.id);
          if (AUTO.currentTask === "collect" && AUTO.taskTargetId === item.id) {
            // Keep task id in raidCargoClear; clear native path so breakout owns movement.
            const Kclear = getGameState();
            if (Kclear?.cargoTargetId === item.id) Kclear.cargoTargetId = null;
          }
          if (AUTO.raidCargoClear) {
            driveRaidCargoClearMovement(input, ship, AUTO.raidCargoClear);
          }
          return;
        }
      }
      const cargoWaitStarted =
        AUTO.pendingCombatCargo?.at || AUTO.lastCargoCollectAttempt?.at || 0;
      if (cargoWaitStarted && Date.now() - cargoWaitStarted > POST_KILL_CARGO_WAIT_MS) {
        // Raid sweep scoops are not bound to the short post-kill wait window.
        // Golden rule: if cargo is still visible/allowed, keep scooping.
        if (!isInRaidMap() || AUTO.pendingCombatCargo) {
          const stillVisible =
            getGameState()?.loots?.has?.(item.id) || Boolean(getLootSprite(item.id));
          if (!stillVisible) {
            finishCombatCargoCollect(item.id, { count: false });
            return;
          }
          if (AUTO.pendingCombatCargo) {
            AUTO.pendingCombatCargo.at =
              Date.now() - Math.floor(POST_KILL_CARGO_WAIT_MS * 0.55);
          }
        }
      }
    }

    // Baule in channel (barra progresso): resta fermo, non ri-armare
    if (item.kind === "booty" && K.bootyTargetId && (K.bootyTargetId === item.id || K.bootyTargetId === AUTO.taskTargetId)) {
      if (input.moveTarget) input.moveTarget = null;
      if (K.cargoTargetId === item.id) K.cargoTargetId = null;
      setStatus("Raccolta baule...");
      return;
    }

    ensureActiveConfig(AUTO.roamConfig);
    input.attackMode = false;

    // Mantieni il target nativo: è lui che muove e raccoglie (con animazione)
    if (K.cargoTargetId !== item.id) {
      beginCollect(item);
    }

    const loot = K.loots?.get?.(item.id);
    const lx = loot?.x ?? item.x;
    const ly = loot?.y ?? item.y;
    const ap = { x: lx, y: ly - AUTO.collectApproachOffset };
    const distAp = distance(ship.x, ship.y, ap.x, ap.y);
    const trigger = getCollectTriggerDistance(item);

    // Raid cargo far away: native path can stall under fire — reinforce with minimap.
    if (
      item.kind === "cargo" &&
      isInRaidMap() &&
      distAp > trigger + 80 &&
      !isRaidShipThreatenedForCargo(ship)
    ) {
      moveViaMinimap(ap.x, ap.y);
    }

    if (distAp > trigger) {
      if (item.kind === "cargo" && isInRaidMap()) {
        setStatus("status.raid_cargo_sweep", { dist: Math.round(distAp) });
      } else {
        setStatus(`Raccolta ${collectKindLabel(item.kind)} (${Math.round(distAp)}m)`);
      }
    } else {
      setStatus(`Raccolta ${collectKindLabel(item.kind)}...`);
    }

    // Se qualcosa ha cancellato il target (ESC, altro click) ripristina dopo un attimo
    // (non per bauli già in channel)
    if (
      K.bootyTargetId !== item.id &&
      K.cargoTargetId !== item.id &&
      Date.now() - AUTO.lastCollectSendAt > 400
    ) {
      armNativeCollect(item.id);
    }
  }

  function driveBonusCollect(box) {
    driveCollect(box);
  }

  function runCurrentTask() {
    if (AUTO.currentTask === "combat") {
      // Heal-flee must own the tick — do not fall through to Story 3 orbit.
      if (isRaidHealActive()) {
        const input = getInputSystem();
        const ship = getShipPosition();
        if (input && ship) return driveRaidHealTick(input, ship);
        return true;
      }
      // Standard maps: never engage another NPC while post-kill scoop is open.
      // (drivePending runs first; this is a belt-and-suspenders guard.)
      // Only after the current kill is confirmed gone — never mid-fight.
      if (
        AUTO.pendingCombatCargo &&
        canCollectCargoNow() &&
        !isInRaidMap()
      ) {
        const combatId = AUTO.taskTargetId;
        clearFalsePendingCargoForLivingTarget(combatId);
        if (
          !combatId ||
          (!isNpcStillFightable(combatId) && isCombatTargetConfirmedGone(combatId))
        ) {
          pauseCombatForPostKillCargo(combatId || AUTO.pendingCombatCargo?.npcId);
          return false;
        }
      }
      const npc =
        getNpcEntry(AUTO.taskTargetId) || getStickyCombatNpcEntry(AUTO.taskTargetId);
      if (!npc) {
        if (
          AUTO.taskTargetId &&
          (!isCombatTargetConfirmedGone(AUTO.taskTargetId) ||
            getNpcSprite(AUTO.taskTargetId)?.alive)
        ) {
          clearFalsePendingCargoForLivingTarget(AUTO.taskTargetId);
          sustainCombatOnStickyId(AUTO.taskTargetId);
          return true;
        }
        return false;
      }
      AUTO.combatTargetGoneAt = 0;
      if (isInRaidMap()) {
        driveRaidCombatEngage(npc);
      } else {
        driveCombatEngage(npc);
      }
      return true;
    }

    if (AUTO.currentTask === "collect") {
      const item = getCollectibleById(AUTO.taskTargetId);
      // Raid sticky fight: never let cargo collect/clear own movement mid-kite.
      if (
        isInRaidMap() &&
        hasLivingStickyCombat() &&
        item?.kind === "cargo"
      ) {
        releaseRaidCargoClearForCombat();
        const npc =
          getNpcEntry(AUTO.taskTargetId) ||
          getStickyCombatNpcEntry(AUTO.combatFocusId || AUTO.combatTargetId);
        if (npc) {
          driveRaidCombatEngage(npc);
          return true;
        }
        return Boolean(AUTO.currentTask === "combat");
      }
      if (!item) {
        const lootId = AUTO.taskTargetId;
        // Sprite momentaneamente assente ma loot ancora in stato gioco → tieni path nativo
        if (lootId && getGameState()?.loots?.has?.(lootId)) {
          armNativeCollect(lootId);
          return true;
        }
        // Loot sparito: chiudi senza contare di nuovo (lootRemove/collectSuccess già contano)
        if (AUTO.pendingCombatCargo || AUTO.cargoCollectInFlightId || isCargoCollectAlreadyDone(lootId)) {
          finishCombatCargoCollect(lootId, { count: false });
          return false;
        }
        clearCurrentTask();
        return false;
      }
      driveCollect(item);
      return true;
    }

    return false;
  }

  function clickWorld(worldX, worldY) {
    const point = worldToClient(worldX, worldY);
    const canvas = getCanvas();
    if (!point || !canvas) return false;
    const opts = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: point.clientX,
      clientY: point.clientY,
      button: 0,
      pointerId: 77,
      pointerType: "mouse",
      isPrimary: true,
      view: window,
    };
    canvas.dispatchEvent(new PointerEvent("pointerdown", { ...opts, buttons: 1 }));
    canvas.dispatchEvent(new PointerEvent("pointerup", { ...opts, buttons: 0 }));
    return true;
  }

  function installKeepAlive() {
    if (AUTO.keepAliveId) return;

    try {
      Object.defineProperty(document, "hidden", { get: () => false, configurable: true });
      Object.defineProperty(document, "visibilityState", { get: () => "visible", configurable: true });
    } catch (_) {}

    AUTO.keepAliveId = window.setInterval(() => {
      if (!AUTO.active) return;
      const game = getGame();
      if (game?.isPaused) game.resume();
      const input = getInputSystem();
      if (input?.netTick) input.netTick();
      // Post-kill scoop owns movement — do not re-sync attack.
      if (AUTO.pendingCombatCargo && AUTO.collectCargo && canCollectCargoNow()) {
        // Wide cargo clear is combat reposition — keep laser up (not a scoop pause).
        if (
          AUTO.raidCargoClear?.phase === "CLEARING" ||
          AUTO.raidCargoClear?.phase === "BREAKOUT" ||
          AUTO.raidCargoClear?.phase === "APPROACH"
        ) {
          if (AUTO.combatActive && !isRaidHealActive()) {
            sustainRaidCargoClearAttack(input);
          }
        }
        return;
      }
      if (
        AUTO.raidCargoClear?.phase === "CLEARING" ||
        AUTO.raidCargoClear?.phase === "BREAKOUT" ||
        AUTO.raidCargoClear?.phase === "APPROACH"
      ) {
        if (AUTO.combatActive && !isRaidHealActive()) {
          sustainRaidCargoClearAttack(input);
        }
        return;
      }
      // Orbit / moveViaMinimap stay on mainTick only (no keepAlive orbit spam).
      if (AUTO.combatActive && !isRaidHealActive() && input?.syncAttackSession) {
        if (isInRaidMap() && isCombatEngaged()) {
          sustainRaidAttack(input);
        } else if (input.attackMode) {
          input.syncAttackSession();
        }
      }
    }, 100);
  }

  function uninstallKeepAlive() {
    if (!AUTO.keepAliveId) return;
    clearInterval(AUTO.keepAliveId);
    AUTO.keepAliveId = null;
  }

  function debugSnapshot() {
    const scene = getGameScene();
    const minimap = getMinimap();
    const ship = getShipPosition();
    const bonuses = listBonusBoxes(AUTO.bonusRadius);
    return {
      game: !!getGame(),
      scene: !!scene,
      minimap: !!minimap,
      minimapCanvas: !!getMinimapCanvas(),
      ship: !!ship,
      bonusVisible: bonuses.length,
      onMapClick: typeof minimap?.onMapClick === "function",
    };
  }

  function setStatus(textOrKey, params, options = {}) {
    const el = document.getElementById("rg-story-status");
    if (!el) return;
    const bundle = window.RG_STORY_I18N?.strings?.[AUTO.locale] || window.RG_STORY_I18N?.strings?.en;
    let text = textOrKey;
    if (typeof textOrKey === "string" && bundle?.[textOrKey]) {
      AUTO.lastStatusKey = { key: textOrKey, params: params || {} };
      text = t(textOrKey, params);
      el.textContent = text;
    } else {
      AUTO.lastStatusKey = null;
      el.textContent = textOrKey;
      text = String(textOrKey || "");
    }
    if (!options.skipDiscord) maybeDiscordNotifyStatus(text);
  }

  function isValidDiscordWebhookUrl(url) {
    const u = String(url || "").trim();
    if (!u) return false;
    try {
      const parsed = new URL(u);
      if (parsed.protocol !== "https:") return false;
      const host = parsed.hostname.toLowerCase();
      if (host !== "discord.com" && host !== "discordapp.com") return false;
      return /\/api\/webhooks\/\d+\/[\w-]+/i.test(parsed.pathname);
    } catch (_) {
      return false;
    }
  }

  function loadDiscordWebhookPrefs() {
    try {
      const raw = localStorage.getItem(DISCORD_WEBHOOK_STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      AUTO.discordWebhookEnabled = Boolean(data.enabled);
      AUTO.discordWebhookUrl = String(data.url || "");
      {
        const parsed = Number(data.intervalMin);
        AUTO.discordWebhookIntervalMin = clamp(
          Math.round(Number.isFinite(parsed) ? parsed : 5),
          0,
          180
        );
      }
      AUTO.discordNotifyStatus = data.notifyStatus !== false;
    } catch (_) {}
  }

  function saveDiscordWebhookPrefs() {
    try {
      localStorage.setItem(
        DISCORD_WEBHOOK_STORAGE_KEY,
        JSON.stringify({
          enabled: Boolean(AUTO.discordWebhookEnabled),
          url: String(AUTO.discordWebhookUrl || ""),
          intervalMin: (() => {
            const parsed = Number(AUTO.discordWebhookIntervalMin);
            return clamp(Math.round(Number.isFinite(parsed) ? parsed : 5), 0, 180);
          })(),
          notifyStatus: AUTO.discordNotifyStatus !== false,
        })
      );
    } catch (_) {}
  }

  function getPortalHoldDiscordInfo() {
    if (!(AUTO.coffeeBreakUntil && Date.now() < AUTO.coffeeBreakUntil)) return null;
    const isAdmin = AUTO.portalHoldReason === "admin";
    const remaining = formatCountdownSec(secondsUntil(AUTO.coffeeBreakUntil));
    return {
      reason: isAdmin ? "admin" : "coffee",
      remaining,
      adminName: AUTO.adminPauseName || "",
      label: isAdmin
        ? t("discord.admin_pause", {
            name: AUTO.adminPauseName || "?",
            time: remaining,
          })
        : t("discord.coffee_pause", { time: remaining }),
    };
  }

  function getDiscordActivitySnapshot() {
    const statusEl = document.getElementById("rg-story-status");
    const status = statusEl?.textContent?.trim() || "—";
    const modes = [];
    if (AUTO.modeAttack) modes.push("Attacco");
    if (AUTO.modeOrbit) modes.push("Orbita");
    if (AUTO.orbitPortalDrift) modes.push("Deriva");
    if (AUTO.collectBonus) modes.push("Bonus");
    if (AUTO.collectCargo) modes.push("Cargo");
    if (AUTO.collectBooty) modes.push("Bauli");
    const gains = getSessionGains();
    const player = getLocalPlayer();
    const hp = getPlayerHpSnapshot();
    const sh = getPlayerShieldSnapshot();
    const inRaid = isInRaidMap();
    const hasRaidProgress =
      AUTO.raidCurrentStage > 0 || AUTO.raidCurrentWave > 0 || AUTO.raidTotalStages > 0;
    const showRaid = inRaid || (Boolean(AUTO.raidGateId) && hasRaidProgress);
    const raidProgress = showRaid
      ? formatRaidWaveProgressText({
          kills: gains?.npcKills ?? 0,
          force: !inRaid && hasRaidProgress,
        }) || "—"
      : "—";
    const hold = getPortalHoldDiscordInfo();
    return {
      status,
      map: formatMapLabel(getCurrentMapId()) || getCurrentMapId() || "—",
      modes: modes.length ? modes.join(" + ") : "—",
      play: AUTO.active ? (AUTO.paused ? "Pausa" : "Play") : "Stop",
      deaths: AUTO.deathCount || 0,
      sticky: AUTO.combatFocusId || AUTO.taskTargetId || "—",
      task: AUTO.currentTask || "—",
      hp: `${Math.round(hp.percent)}%`,
      shield: `${Math.round(sh.percent)}%`,
      gains,
      playerName: player?.username || player?.name || "—",
      version: BASTION_APP_VERSION,
      inRaid: showRaid,
      raidProgress,
      hold,
    };
  }

  function buildDiscordWebhookPayload(kind, note) {
    const snap = getDiscordActivitySnapshot();
    const g = snap.gains || {};
    const title =
      kind === "stats"
        ? "Bastion — statistiche sessione"
        : kind === "test"
          ? "Bastion — test webhook"
          : kind === "admin_alert"
            ? "Alert admin"
            : "Bastion — attività";
    const description =
      note ||
      (kind === "stats"
        ? `Report periodico (${AUTO.discordWebhookIntervalMin || 0} min)`
        : kind === "admin_alert"
          ? "Evento admin"
          : snap.status);
    const fields = [
      { name: "Stato", value: String(snap.play), inline: true },
      { name: "Mappa", value: String(snap.map).slice(0, 80), inline: true },
      { name: "Modi", value: String(snap.modes).slice(0, 80), inline: true },
      { name: "HP / Scudo", value: `${snap.hp} / ${snap.shield}`, inline: true },
      { name: "Task", value: String(snap.task), inline: true },
      { name: "Morti", value: String(snap.deaths), inline: true },
    ];
    if (snap.inRaid) {
      fields.push({
        name: t("discord.raid_field"),
        value: String(snap.raidProgress || "—").slice(0, 120),
        inline: false,
      });
    }
    if (snap.hold) {
      fields.push({
        name: t("discord.hold_field"),
        value: String(snap.hold.label || "—").slice(0, 160),
        inline: false,
      });
    }
    if (kind === "admin_alert" && AUTO.adminPauseName) {
      fields.push({
        name: "Admin",
        value: String(AUTO.adminPauseName).slice(0, 80),
        inline: true,
      });
    }
    fields.push(
      {
        name: "Sessione",
        value: [
          `NPC ${g.npcKills || 0}`,
          `Bonus ${g.bonus || 0}`,
          `Cargo ${g.cargo || 0}`,
          `Bauli ${g.booty || 0}`,
          `XP ${g.xp || 0}`,
          `Honor ${g.honor || 0}`,
          `Credits ${g.credits || 0}`,
          `RM ${g.redMatter || 0}`,
        ].join(" · "),
      },
      { name: "Attività", value: String(snap.status).slice(0, 200) }
    );
    const color =
      kind === "stats"
        ? 0x3b82f6
        : kind === "test"
          ? 0x22c55e
          : kind === "admin_alert"
            ? 0xef4444
            : 0xf59e0b;
    return {
      username: "Bastion",
      embeds: [
        {
          title,
          description: String(description).slice(0, 400),
          color,
          fields,
          footer: { text: `Bastion ${snap.version} · ${snap.playerName}` },
          timestamp: new Date().toISOString(),
        },
      ],
    };
  }

  async function sendDiscordWebhook(kind, note) {
    if (!AUTO.discordWebhookEnabled && kind !== "test") return { ok: false, error: "off" };
    const url = String(AUTO.discordWebhookUrl || "").trim();
    if (!isValidDiscordWebhookUrl(url)) return { ok: false, error: "url" };
    if (AUTO.discordWebhookBusy) return { ok: false, error: "busy" };
    AUTO.discordWebhookBusy = true;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildDiscordWebhookPayload(kind, note)),
      });
      if (!res.ok) return { ok: false, error: `http_${res.status}` };
      return { ok: true };
    } catch (_) {
      return { ok: false, error: "network" };
    } finally {
      AUTO.discordWebhookBusy = false;
    }
  }

  /**
   * Distinct admin Discord alerts (red "Alert admin" embed).
   * Throttles duplicate type+identity pairs (~45s) without collapsing different event types.
   */
  function sendDiscordAdminAlert(eventType, summary, extra = {}) {
    if (!AUTO.discordWebhookEnabled) return;
    const identity = String(extra.name || extra.id || extra.nick || "").trim();
    const throttleKey = `${eventType}:${identity || "_"}`;
    const now = Date.now();
    const last = AUTO.adminAlertLastAt[throttleKey] || 0;
    if (now - last < 45000) return;
    AUTO.adminAlertLastAt[throttleKey] = now;
    if (identity) rememberAdminName(identity);
    const note = String(summary || eventType).trim();
    if (!note) return;
    sendDiscordWebhook("admin_alert", note);
  }

  function rememberAdminName(name) {
    const nick = String(name || "").trim();
    if (!nick || nick === "?") return;
    AUTO.adminKnownNames.add(nick);
  }

  function maybeDiscordNotifyStatus(text) {
    if (!AUTO.discordWebhookEnabled || AUTO.discordNotifyStatus === false) return;
    if (!AUTO.active) return;
    const cleaned = String(text || "").trim();
    if (!cleaned || cleaned === AUTO.discordLastStatusText) return;
    const now = Date.now();
    // Throttle: avoid spamming Discord on every tick.
    if (now - (AUTO.discordLastStatusSentAt || 0) < 20000) return;
    AUTO.discordLastStatusText = cleaned;
    AUTO.discordLastStatusSentAt = now;
    sendDiscordWebhook("status", cleaned);
  }

  /** Bypass status throttle — used for admin/coffee hold start (must reach Discord). */
  function forceDiscordNotifyStatus(text) {
    if (!AUTO.discordWebhookEnabled || AUTO.discordNotifyStatus === false) return;
    if (!AUTO.active) return;
    const cleaned = String(text || "").trim();
    if (!cleaned) return;
    const now = Date.now();
    AUTO.discordLastStatusText = cleaned;
    AUTO.discordLastStatusSentAt = now;
    AUTO.discordLastHoldSentAt = now;
    sendDiscordWebhook("status", cleaned);
  }

  /**
   * While coffee/admin portal hold is active, refresh Discord with reason + remaining
   * (~90s) so the user knows why the app is stopped.
   */
  function maybeDiscordNotifyPortalHoldTick() {
    if (!AUTO.discordWebhookEnabled || AUTO.discordNotifyStatus === false) return;
    if (!AUTO.active) return;
    const hold = getPortalHoldDiscordInfo();
    if (!hold) return;
    const now = Date.now();
    if (now - (AUTO.discordLastHoldSentAt || 0) < 90000) return;
    AUTO.discordLastHoldSentAt = now;
    AUTO.discordLastStatusText = hold.label;
    AUTO.discordLastStatusSentAt = now;
    sendDiscordWebhook("status", hold.label);
  }

  function maybeDiscordNotifyStatsTick() {
    if (!AUTO.discordWebhookEnabled || !AUTO.active || AUTO.paused) return;
    const mins = Number(AUTO.discordWebhookIntervalMin);
    if (!(mins > 0)) return;
    const now = Date.now();
    const intervalMs = mins * 60 * 1000;
    if (now - (AUTO.discordLastStatsSentAt || 0) < intervalMs) return;
    AUTO.discordLastStatsSentAt = now;
    sendDiscordWebhook("stats");
  }

  function syncDiscordWebhookUi() {
    const enabled = document.getElementById("rg-discord-enabled");
    const url = document.getElementById("rg-discord-webhook-url");
    const interval = document.getElementById("rg-discord-interval");
    const statusNotify = document.getElementById("rg-discord-status-notify");
    if (enabled) enabled.classList.toggle("selected", Boolean(AUTO.discordWebhookEnabled));
    if (statusNotify) statusNotify.classList.toggle("selected", AUTO.discordNotifyStatus !== false);
    if (url && document.activeElement !== url) url.value = AUTO.discordWebhookUrl || "";
    if (interval && document.activeElement !== interval) {
      interval.value = String(AUTO.discordWebhookIntervalMin ?? 5);
    }
  }

  function setDiscordWebhookStatus(msg) {
    const el = document.getElementById("rg-discord-webhook-status");
    if (el) el.textContent = msg || "";
  }

  async function testDiscordWebhook() {
    saveDiscordWebhookPrefs();
    if (!isValidDiscordWebhookUrl(AUTO.discordWebhookUrl)) {
      setDiscordWebhookStatus(t("ui.settings.discord_invalid"));
      return;
    }
    setDiscordWebhookStatus(t("ui.settings.discord_sending"));
    const wasEnabled = AUTO.discordWebhookEnabled;
    AUTO.discordWebhookEnabled = true;
    const result = await sendDiscordWebhook("test", t("ui.settings.discord_test_body"));
    AUTO.discordWebhookEnabled = wasEnabled;
    setDiscordWebhookStatus(
      result.ok ? t("ui.settings.discord_ok") : t("ui.settings.discord_fail", { error: result.error || "?" })
    );
  }

  function initDiscordWebhookControls() {
    loadDiscordWebhookPrefs();
    syncDiscordWebhookUi();
    const enabled = document.getElementById("rg-discord-enabled");
    const statusNotify = document.getElementById("rg-discord-status-notify");
    const url = document.getElementById("rg-discord-webhook-url");
    const interval = document.getElementById("rg-discord-interval");
    const testBtn = document.getElementById("rg-discord-test");
    const pasteBtn = document.getElementById("rg-discord-webhook-paste");
    if (enabled && enabled.dataset.bound !== "1") {
      enabled.dataset.bound = "1";
      enabled.addEventListener("click", () => {
        AUTO.discordWebhookEnabled = !AUTO.discordWebhookEnabled;
        saveDiscordWebhookPrefs();
        syncDiscordWebhookUi();
        setStatus(
          AUTO.discordWebhookEnabled ? "status.discord_on" : "status.discord_off"
        );
      });
    }
    if (statusNotify && statusNotify.dataset.bound !== "1") {
      statusNotify.dataset.bound = "1";
      statusNotify.addEventListener("click", () => {
        AUTO.discordNotifyStatus = !AUTO.discordNotifyStatus;
        saveDiscordWebhookPrefs();
        syncDiscordWebhookUi();
      });
    }
    if (url && url.dataset.bound !== "1") {
      url.dataset.bound = "1";
      bindDiscordWebhookInputInteractions();
      const persist = () => {
        AUTO.discordWebhookUrl = String(url.value || "").trim();
        saveDiscordWebhookPrefs();
      };
      url.addEventListener("change", persist);
      url.addEventListener("blur", persist);
    }
    if (pasteBtn && pasteBtn.dataset.bound !== "1") {
      pasteBtn.dataset.bound = "1";
      pasteBtn.addEventListener("click", () => {
        pasteDiscordWebhookFromClipboard();
      });
    }
    if (interval && interval.dataset.bound !== "1") {
      interval.dataset.bound = "1";
      bindPanelFormInput(interval);
      const persist = () => {
        AUTO.discordWebhookIntervalMin = clamp(Math.round(Number(interval.value) || 0), 0, 180);
        interval.value = String(AUTO.discordWebhookIntervalMin);
        saveDiscordWebhookPrefs();
      };
      interval.addEventListener("change", persist);
      interval.addEventListener("blur", persist);
    }
    if (testBtn && testBtn.dataset.bound !== "1") {
      testBtn.dataset.bound = "1";
      testBtn.addEventListener("click", () => testDiscordWebhook());
    }
  }

  function t(key, params) {
    const bundle =
      window.RG_STORY_I18N?.strings?.[AUTO.locale] || window.RG_STORY_I18N?.strings?.en || {};
    let str = bundle[key] ?? window.RG_STORY_I18N?.strings?.en?.[key] ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        str = str.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
      }
    }
    return str;
  }

  function refreshStatusI18n() {
    if (AUTO.lastStatusKey) setStatus(AUTO.lastStatusKey.key, AUTO.lastStatusKey.params);
  }

  function loadStoredLocale() {
    try {
      const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
      if (stored && window.RG_STORY_I18N?.strings?.[stored]) AUTO.locale = stored;
      else AUTO.locale = window.RG_STORY_I18N?.defaultLocale || "en";
    } catch (_) {
      AUTO.locale = "en";
    }
  }

  function setLocale(code) {
    if (!window.RG_STORY_I18N?.strings?.[code]) code = "en";
    AUTO.locale = code;
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, code);
    } catch (_) {}
    const sel = document.getElementById("rg-locale-select");
    if (sel) sel.value = code;
    applyI18n();
    updateStatisticsPanel();
    updateGeneralPanel();
    const loc = window.RG_STORY_I18N?.locales?.find((entry) => entry.code === code);
    setStatus("status.language_changed", { lang: loc?.label || code });
  }

  function buildLocaleSelect() {
    const sel = document.getElementById("rg-locale-select");
    if (!sel || sel.dataset.built === "1") return;
    sel.dataset.built = "1";
    const locales = window.RG_STORY_I18N?.locales || [{ code: "en", label: "English" }];
    sel.innerHTML = locales
      .map((entry) => `<option value="${entry.code}">${entry.flag || ""} ${entry.label}</option>`)
      .join("");
    sel.value = AUTO.locale || "en";
    sel.addEventListener("change", () => setLocale(sel.value || "en"));
  }

  async function sha256Hex(input) {
    if (!globalThis.crypto?.subtle) {
      let h = 0;
      for (let i = 0; i < input.length; i += 1) h = (h * 31 + input.charCodeAt(i)) >>> 0;
      return h.toString(16).padStart(16, "0") + h.toString(16).padStart(16, "0").slice(0, 16);
    }
    const enc = new TextEncoder();
    const buf = await crypto.subtle.digest("SHA-256", enc.encode(input));
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async function ensureDeviceId() {
    if (AUTO.deviceId) return AUTO.deviceId;
    try {
      const stored = localStorage.getItem(DEVICE_ID_STORAGE_KEY);
      if (stored && /^RGD-[a-f0-9]{16}$/i.test(stored)) {
        AUTO.deviceId = stored.toUpperCase();
        return AUTO.deviceId;
      }
    } catch (_) {}
    const seed = [
      navigator.userAgent || "",
      navigator.language || "",
      screen.width,
      screen.height,
      screen.colorDepth,
      navigator.hardwareConcurrency || 0,
      Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    ].join("|");
    const hash = await sha256Hex(seed);
    AUTO.deviceId = `RGD-${hash.slice(0, 16).toUpperCase()}`;
    try {
      localStorage.setItem(DEVICE_ID_STORAGE_KEY, AUTO.deviceId);
    } catch (_) {}
    return AUTO.deviceId;
  }

  function applyI18n() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    panel.querySelectorAll("[data-i18n]").forEach((el) => {
      if (el.id === "rg-story-status" || el.id === "rg-license-status") return;
      const params = {};
      if (el.dataset.i18nCount != null) params.count = el.dataset.i18nCount;
      if (el.dataset.i18nThreshold != null) params.threshold = el.dataset.i18nThreshold;
      el.textContent = t(el.dataset.i18n, params);
    });
    panel.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
      el.placeholder = t(el.dataset.i18nPlaceholder);
    });
    panel.querySelectorAll("[data-i18n-title]").forEach((el) => {
      el.title = t(el.dataset.i18nTitle);
    });

    const ORE_I18N = {
      TITANIUM: "ui.ore.titanium",
      PLUTONIUM: "ui.ore.plutonium",
      ANTIMATTER: "ui.ore.antimatter",
      URANIUM: "ui.ore.uranium",
      TRITIUM: "ui.ore.tritium",
    };
    panel.querySelectorAll("[data-refinery-ore]").forEach((btn) => {
      const key = ORE_I18N[btn.dataset.refineryOre];
      if (key) btn.textContent = t(key);
    });

    panel.querySelectorAll("[data-combat-ammo-buy]").forEach((btn) => {
      const qty = Number(btn.dataset.combatAmmoBuy) || 0;
      btn.textContent = qty === 0 ? t("ui.off") : String(qty);
    });

    const textById = {
      "rg-story-head-title": "app.title",
      "rg-story-play-main": "ui.play",
      "rg-story-stop": "ui.stop",
      "rg-license-paste": "ui.paste",
      "rg-discord-webhook-paste": "ui.paste",
      "rg-license-apply": "ui.activate",
      "rg-device-copy": "ui.copy",
      "rg-npc-select-all": "ui.all",
      "rg-npc-clear": "ui.none",
      "rg-mode-collect-bonus": "ui.collect_bonus",
      "rg-mode-collect-cargo": "ui.collect_cargo",
      "rg-mode-collect-booty": "ui.collect_booty",
      "rg-refinery-sell": "ui.refinery_sell",
      "rg-refinery-antimatter": "ui.refinery_antimatter",
      "rg-refinery-refine": "ui.refinery_refine",
      "rg-refinery-enhance": "ui.refinery_enhance",
      "rg-mode-attack": "ui.attack_npc",
      "rg-mode-orbit": "ui.orbit",
      "rg-mode-portal-drift": "ui.orbit_portal_drift",
      "rg-sec-flee-enemies": "ui.sec.flee_enemies",
      "rg-sec-flee-cloak": "ui.sec.flee_cloak",
      "rg-sec-flee-sap": "ui.sec.flee_sap",
      "rg-sec-pause-admin": "ui.sec.pause_on_admin",
      "rg-sec-auto-booty-key": "ui.sec.auto_booty_key",
    };
    for (const [id, key] of Object.entries(textById)) {
      const el = document.getElementById(id);
      if (el) el.textContent = t(key);
    }

    document.querySelectorAll(`#${PANEL_ID} .rg-tab`).forEach((btn) => {
      const map = {
        general: "ui.tab.general",
        collect: "ui.tab.collect",
        attack: "ui.tab.attack",
        security: "ui.tab.security",
        settings: "ui.tab.settings",
      };
      const key = map[btn.dataset.tab];
      if (key) btn.textContent = t(key);
    });

    const npcCount = document.getElementById("rg-npc-count")?.textContent || "0";
    const npcTypesLbl = document.getElementById("rg-npc-types-label");
    if (npcTypesLbl) npcTypesLbl.textContent = t("ui.npc_types", { count: npcCount });

    const ammoHint = document.getElementById("rg-ammo-autobuy-hint");
    if (ammoHint) ammoHint.textContent = t("ui.ammo_autobuy_hint", { threshold: COMBAT_AMMO_LOW_THRESHOLD });

    const pauseBtn = document.getElementById("rg-story-pause");
    if (pauseBtn) pauseBtn.textContent = t("ui.pause");

    const orbPause = document.getElementById("rg-orb-pause");
    if (orbPause) {
      orbPause.title = t("ui.pause");
      orbPause.setAttribute("aria-label", t("ui.pause"));
    }
    const orbPlay = document.getElementById("rg-orb-play");
    if (orbPlay) {
      orbPlay.title = t("ui.play");
      orbPlay.setAttribute("aria-label", t("ui.play"));
    }
    const orbStop = document.getElementById("rg-orb-stop");
    if (orbStop) {
      orbStop.title = t("ui.stop");
      orbStop.setAttribute("aria-label", t("ui.stop"));
    }

    const lockEl = document.getElementById("rg-license-lock");
    if (lockEl) lockEl.textContent = t("ui.license.lock");

    refreshBastionVersionLabel();
    updateLicenseUI();
    refreshStatusI18n();
  }

  function updateBonusCounter() {
    const el = document.getElementById("rg-stat-bonus");
    if (el) el.textContent = String(AUTO.bonusCollected);
    const legacy = document.getElementById("rg-story-bonus-count");
    if (legacy) legacy.textContent = String(AUTO.bonusCollected);
    updateStatisticsPanel();
  }

  function getNpcKillTotal() {
    return Object.values(AUTO.npcKillsByType).reduce((sum, count) => sum + count, 0);
  }

  function updateNpcKillCounter() {
    const total = getNpcKillTotal();
    const totalEl = document.getElementById("rg-stat-npc-kills");
    if (totalEl) totalEl.textContent = String(total);
    const legacyTotal = document.getElementById("rg-story-npc-kills-total");
    if (legacyTotal) legacyTotal.textContent = String(total);

    updateStatisticsPanel();
    updateNpcListVisuals();
  }

  function updateStatisticsPanel() {
    const npcTable = document.getElementById("rg-stat-npc-table");
    const summaryTable = document.getElementById("rg-stat-summary-table");
    if (!npcTable && !summaryTable) return;

    const selectedCount = AUTO.selectedNpcTypes?.size || 0;
    const countEl = document.getElementById("rg-stat-npc-selected-count");
    if (countEl) countEl.textContent = String(selectedCount);

    // List only NPCs with kills > 0 (avoid long zero-kill lists).
    const keys = Object.keys(AUTO.npcKillsByType)
      .filter((k) => (AUTO.npcKillsByType[k] || 0) > 0)
      .sort((a, b) => {
        const diff = (AUTO.npcKillsByType[b] || 0) - (AUTO.npcKillsByType[a] || 0);
        return diff !== 0 ? diff : a.localeCompare(b);
      });

    if (npcTable) {
      if (!keys.length) {
        npcTable.innerHTML = "";
      } else {
        npcTable.innerHTML = keys
          .map(
            (key) => `
          <tr>
            <td>${escapeHtml(getNpcTypeLabel(key))}</td>
            <td class="rg-stat-num">${AUTO.npcKillsByType[key] || 0}</td>
          </tr>`
          )
          .join("");
      }
    }

    if (summaryTable) {
      const gains = getSessionGains();
      const live = Boolean(AUTO.sessionStatsBaseline);
      const val = (n) => (live ? `+${formatGain(n)}` : "—");
      summaryTable.innerHTML = `
        <tr><td>${escapeHtml(t("ui.stat.bonus_box"))}</td><td class="rg-stat-num">${live ? `+${gains.bonus}` : "—"}</td></tr>
        <tr><td>${escapeHtml(t("ui.stat.cargo"))}</td><td class="rg-stat-num">${live ? `+${gains.cargo}` : "—"}</td></tr>
        <tr><td>${escapeHtml(t("ui.stat.booty"))}</td><td class="rg-stat-num">${live ? `+${gains.booty}` : "—"}</td></tr>
        <tr><td>XP</td><td class="rg-stat-num">${val(gains.xp)}</td></tr>
        <tr><td>HNR</td><td class="rg-stat-num">${val(gains.honor)}</td></tr>
        <tr><td>CR</td><td class="rg-stat-num">${val(gains.credits)}</td></tr>
        <tr><td>RM</td><td class="rg-stat-num">${val(gains.redMatter)}</td></tr>
        <tr><td>${escapeHtml(t("ui.stat.npc_killed"))}</td><td class="rg-stat-num">${live ? `+${gains.npcKills}` : "—"}</td></tr>
        <tr><td>${escapeHtml(t("ui.stat.session_deaths"))}</td><td class="rg-stat-num">${live ? AUTO.deathCount : "—"}</td></tr>`;
    }
  }

  function updateMapConfigUI() {
    const workingSelect = document.getElementById("rg-working-map");
    const raidSelect = document.getElementById("rg-raid-target");
    const raidActive = Boolean(AUTO.raidGateId);
    if (workingSelect) {
      workingSelect.disabled = raidActive;
      workingSelect.title = raidActive ? t("ui.working_map_disabled") : t("ui.working_map_title");
    }
    if (raidSelect && AUTO.raidGateId) {
      raidSelect.value = AUTO.raidGateId;
    }
  }

  function updateGeneralPanel() {
    const currentEl = document.getElementById("rg-current-map");
    const portalsEl = document.getElementById("rg-portals-list");
    const mapId = getCurrentMapId();

    if (currentEl) {
      currentEl.textContent = mapId ? formatMapLabel(mapId) : "—";
    }

    if (portalsEl) {
      const portals = listRuntimePortals();
      if (!portals.length) {
        portalsEl.innerHTML = `<div class="rg-portal-empty">${escapeHtml(t("ui.portal_empty"))}</div>`;
      } else {
        portalsEl.innerHTML = portals
          .slice(0, 8)
          .map(
            (p) => `
          <div class="rg-portal-row">
            <span>${escapeHtml(p.label)}${p.isRaid ? " (raid)" : ""}</span>
            <span class="rg-portal-dist">${Math.round(p.dist)}m</span>
          </div>`
          )
          .join("");
      }
    }

    const workingSelect = document.getElementById("rg-working-map");
    if (workingSelect && !workingSelect.dataset.ready) {
      workingSelect.dataset.ready = "1";
      const maps = listKnownMaps();
      workingSelect.innerHTML =
        `<option value="">${escapeHtml(t("ui.none_option"))}</option>` +
        maps
          .map(
            (m) =>
              `<option value="${m.id}">${escapeHtml(m.short || m.name)} — ${escapeHtml(m.name)}</option>`
          )
          .join("");
    }
    if (workingSelect && AUTO.workingMapId && !AUTO.raidGateId) {
      workingSelect.value = AUTO.workingMapId;
    }
    updateMapConfigUI();
  }

  function getPlayerHpSnapshot() {
    const player = getLocalPlayer();
    if (!player) {
      return { percent: 100, effective: 0, totalMax: 0, baseMax: 0, extra: 0, hp: 0, isFull: true };
    }

    const baseMax = player.max_hp || player.maxHp || 0;
    const extra = Math.max(0, player.extra_hp ?? player.extraHp ?? 0);
    const hp = Math.max(0, player.hp ?? 0);
    const totalMax = baseMax + extra;
    const effective = hp + extra;

    if (totalMax <= 0) {
      return { percent: 100, effective, totalMax, baseMax, extra, hp, isFull: true };
    }

    const percent = (effective / totalMax) * 100;
    return {
      percent,
      effective,
      totalMax,
      baseMax,
      extra,
      hp,
      isFull: percent >= 99.5,
    };
  }

  function getPlayerShieldSnapshot() {
    const player = getLocalPlayer();
    if (!player) {
      return { percent: 100, current: 0, max: 0, isFull: true };
    }

    const max = Number(player.max_shield ?? player.maxShield) || 0;
    const current = Math.max(
      0,
      Number(player.current_shield ?? player.shield ?? player.currentShield) || 0
    );
    // No shield generator equipped → treat as full so recover is not blocked forever.
    if (max <= 0.5) {
      return { percent: 100, current, max, isFull: true };
    }

    const percent = (current / max) * 100;
    return {
      percent,
      current,
      max,
      isFull: percent >= 99.5,
    };
  }

  function getPlayerHpPercent() {
    return getPlayerHpSnapshot().percent;
  }

  function isPlayerHpFull() {
    return getPlayerHpSnapshot().isFull;
  }

  function isPlayerShieldFull() {
    return getPlayerShieldSnapshot().isFull;
  }

  /** Current active config: both hull and shield at (or effectively) full. */
  function isPlayerFullyHealed() {
    return isPlayerHpFull() && isPlayerShieldFull();
  }

  function shouldFleeByHp() {
    if (AUTO.fleeHpPercent <= 0) return false;
    if (AUTO.postDeathRecover) return false;
    if (AUTO.portalWaitUntil && Date.now() < AUTO.portalWaitUntil) return false;
    // Post-kill cargo owns the tick — but never block HP flee while sticky still living
    // (mac34: pendingCombatCargo must not freeze the ship under fire).
    if (hasOpenPostKillCargoLifecycle() && !hasLivingStickyCombat()) return false;
    // Mid play-travel / map hop: HP can briefly read wrong after portal/config switch.
    if (NAV.active && (NAV.playAfterArrival || NAV.kind === "map" || NAV.kind === "raid")) {
      return false;
    }
    // Grace blocks map→base HP flee only; raid in-map heal flee stays allowed.
    if (isPostArrivalSecurityGraceActive() && !isInRaidMap()) return false;
    const hp = getPlayerHpSnapshot().percent;
    const thr = AUTO.fleeHpPercent;
    const tol = getFleeHpTolerance();
    // mac46: Raid must respect the Flee HP % setting exactly (no early +tol band).
    // Soft ±tol is standard-map only (finish sticky / early between targets).
    if (isInRaidMap()) {
      if (hasLivingStickyCombat()) return hp <= Math.max(1, thr - tol);
      return hp <= thr;
    }
    // Soft band (standard): finish sticky kill down to thr−tol; between targets heal early at thr+tol.
    if (hasLivingStickyCombat()) {
      return hp <= thr - tol;
    }
    return hp <= thr + tol;
  }

  /** Fixed soft-band half-width around Flee HP % (default 5). Standard maps only. */
  function getFleeHpTolerance() {
    const raw = Number(AUTO.fleeHpTolerance);
    return Number.isFinite(raw) && raw >= 0 ? raw : 5;
  }

  /**
   * Between targets (standard maps): already in early-heal soft band → do not start a fresh NPC.
   * Mid-sticky fights are allowed so we can finish the kill down to thr−tol.
   * mac46: never apply on raid — that looked like fleeing with plenty of HP left.
   */
  function shouldBlockNewEngageForHealBand() {
    if (isInRaidMap()) return false;
    if (AUTO.fleeHpPercent <= 0) return false;
    if (hasLivingStickyCombat()) return false;
    return getPlayerHpSnapshot().percent <= AUTO.fleeHpPercent + getFleeHpTolerance();
  }

  function shouldResumeAfterRaidHeal() {
    // Mirror Play heal completeness for the active config (HP + shield).
    // Dual-config switching is reserved for base/Play recover — avoid thrashing raid orbit.
    return isPlayerFullyHealed();
  }

  function mustHealBeforeRaidAdvance() {
    return isInRaidMap() && !isPlayerFullyHealed();
  }

  function getNearestNpcDistance(x, y, maxRadius = 0) {
    let best = Infinity;
    for (const npc of listNpcs(maxRadius)) {
      best = Math.min(best, distance(x, y, npc.x, npc.y));
    }
    return best;
  }

  function scoreRaidPathPoint(x, y, preferredR, center) {
    const threat = getNearestNpcDistance(x, y);
    const r = distance(x, y, center.x, center.y);
    const ringPenalty = Math.abs(r - preferredR) * 0.35;
    return threat - ringPenalty;
  }

  function getRaidSafeReturnWaypoint(ship) {
    const center = getRaidCenter();
    const turretR = getRaidTurretRange() * 0.68;
    const shipAngle = Math.atan2(ship.y - center.y, ship.x - center.x);
    const shipR = Math.hypot(ship.x - center.x, ship.y - center.y) || turretR + 200;
    const nearest = listNpcs(0)[0] || null;
    const all = listNpcs(0);
    const swarm = getRaidSwarmCentroid(all.length ? all : null);

    // Direzione di evasione: allontanarsi dal NPC più vicino, non puntare al centro
    let avoidAngle = shipAngle;
    if (nearest) {
      const away = Math.atan2(ship.y - nearest.y, ship.x - nearest.x);
      // Blend: resta laterale rispetto al centro + fuga dal NPC
      avoidAngle = Math.atan2(
        Math.sin(shipAngle) * 0.45 + Math.sin(away) * 0.55,
        Math.cos(shipAngle) * 0.45 + Math.cos(away) * 0.55
      );
    }

    const candidates = [];
    for (const dir of [-1, 1]) {
      for (let step = 1; step <= 5; step++) {
        const ang = shipAngle + dir * step * 0.32;
        // Prima laterale a raggio alto, poi solo gradualmente verso il ring torre
        const outerR = Math.max(shipR * 0.94, turretR + 160);
        const midR = Math.max((shipR * 0.72 + turretR * 0.28), turretR + 40);
        const innerR = Math.max(turretR, shipR - step * 90);
        for (const radius of [outerR, midR, innerR]) {
          const x = center.x + Math.cos(ang) * radius;
          const y = center.y + Math.sin(ang) * radius;
          const pt = clampToPlayArea(x, y);
          const score = scoreRaidPathPoint(pt.x, pt.y, turretR, center);
          // Bonus se va nella direzione di evasione
          const angDiff = Math.abs(Math.atan2(Math.sin(ang - avoidAngle), Math.cos(ang - avoidAngle)));
          const towardSwarm =
            (pt.x - ship.x) * (swarm.x - ship.x) + (pt.y - ship.y) * (swarm.y - ship.y);
          const chordCut = raidHealPathCrossesSwarm(ship, pt, 560);
          candidates.push({
            x: pt.x,
            y: pt.y,
            score:
              score -
              angDiff * 80 -
              (chordCut ? 520 : 0) -
              (towardSwarm > 0 ? 180 : 0),
            threat: getNearestNpcDistance(pt.x, pt.y),
            radius,
          });
        }
      }
    }

    // Punto sul ring torre sull'angolo più sicuro (rientro finale)
    for (let i = 0; i < 12; i++) {
      const ang = shipAngle + (i / 12) * Math.PI * 2;
      const pt = clampToPlayArea(
        center.x + Math.cos(ang) * turretR,
        center.y + Math.sin(ang) * turretR
      );
      const chordCut = raidHealPathCrossesSwarm(ship, pt, 560);
      candidates.push({
        x: pt.x,
        y: pt.y,
        score: scoreRaidPathPoint(pt.x, pt.y, turretR, center) - 40 - (chordCut ? 520 : 0),
        threat: getNearestNpcDistance(pt.x, pt.y),
        radius: turretR,
      });
    }

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (!best) return getRaidSupportPoint(ship, 0.68);

    // Passo corto: non saltare dritti al centro, avanza verso il punto migliore
    const dist = distance(ship.x, ship.y, best.x, best.y);
    if (dist <= RAID_SAFE_RETURN_STEP) return { x: best.x, y: best.y };

    const t = RAID_SAFE_RETURN_STEP / dist;
    return clampToPlayArea(ship.x + (best.x - ship.x) * t, ship.y + (best.y - ship.y) * t);
  }

  function isInsideRaidTurretSupport(ship, fraction = 0.72) {
    if (!ship) return false;
    const center = getRaidCenter();
    const maxR = getRaidTurretRange() * fraction;
    return distance(ship.x, ship.y, center.x, center.y) <= maxR;
  }

  function driveRaidSafeReturnTick(input, ship) {
    if (!input || !ship) return false;

    ensureActiveConfig(getRaidFleeConfig());
    input.attackMode = false;
    input.pendingAttackOnLock = null;
    clearLockedTarget();
    // Never let cargo-clear / combat orbit steal the lateral return.
    clearRaidCargoClearState();

    const center = getRaidCenter();
    const turretR = getRaidTurretRange() * 0.68;
    const distCenter = distance(ship.x, ship.y, center.x, center.y);
    const threatNear = getNearestNpcDistance(ship.x, ship.y);
    const now = Date.now();

    // Arrivati nel range torre → riprendi combat (senza aver tagliato l'orda di lato)
    if (distCenter <= turretR + RAID_SAFE_RETURN_ARRIVE) {
      clearRaidFleeState();
      if (resumeCombatAfterFlee()) {
        setStatus("Raid: rientro sicuro, riprendo attacco");
      } else if (AUTO.modeAttack && AUTO.combatActive) {
        setStatus("Raid: rientro sicuro, riprendo attacco");
      } else {
        setStatus("Raid: rientro in range torre");
      }
      return false;
    }

    // Hold current return step briefly — retarget spam causes chord thrash through pack.
    if (
      AUTO.raidHealPhase === "return" &&
      AUTO.raidFleeTarget &&
      AUTO.raidFleeTargetAt &&
      now - AUTO.raidFleeTargetAt < RAID_HEAL_EVADE_HOLD_MS &&
      AUTO.lastMinimapTarget &&
      shouldKeepExistingMoveTarget(
        { moveTarget: AUTO.lastMinimapTarget },
        AUTO.lastMinimapTarget.x,
        AUTO.lastMinimapTarget.y
      )
    ) {
      setStatus(
        `Raid: rientro laterale al range torre (${Math.round(distCenter)}m → ~${Math.round(turretR)}m)`
      );
      return true;
    }

    let waypoint = getRaidSafeReturnWaypoint(ship);

    // Se un NPC è troppo vicino, spingi lateralmente via da lui (mai verso il centro pack)
    if (threatNear <= 520) {
      const npcs = listNpcs(700);
      if (npcs.length) {
        const threat = npcs[0];
        const away = Math.atan2(ship.y - threat.y, ship.x - threat.x);
        const escape = clampToPlayArea(
          ship.x + Math.cos(away) * 420,
          ship.y + Math.sin(away) * 420
        );
        // Preferisci resta esterno rispetto al centro
        const escR = distance(escape.x, escape.y, center.x, center.y);
        if (escR < turretR + 80) {
          const ang = Math.atan2(escape.y - center.y, escape.x - center.x);
          waypoint = clampToPlayArea(
            center.x + Math.cos(ang) * Math.max(escR, turretR + 180),
            center.y + Math.sin(ang) * Math.max(escR, turretR + 180)
          );
        } else {
          waypoint = escape;
        }
        setStatus(`Raid: evado NPC in rientro (${Math.round(threatNear)}m)`);
      }
    }

    // Hard reject: never drive a chord through the swarm centroid.
    if (raidHealPathCrossesSwarm(ship, waypoint, 560)) {
      waypoint = getRaidHealEvasionWaypoint(ship);
      setStatus(`Raid: scarto l'orda in rientro (${Math.round(distCenter)}m)`);
    }

    AUTO.raidFleeTarget = waypoint;
    AUTO.raidFleeTargetAt = now;
    AUTO.raidHealPhase = "return";
    setMoveTargetDirect(input, waypoint.x, waypoint.y);
    setStatus(
      `Raid: rientro laterale al range torre (${Math.round(distCenter)}m → ~${Math.round(turretR)}m)`
    );
    return true;
  }

  function listRaidHealSidePoints(ship) {
    const { w, h } = getMapBounds();
    const margin = (AUTO.mapSafeMargin || 100) + RAID_HEAL_SIDE_INSET;
    const center = getRaidCenter();
    const candidates = [
      { idx: 0, name: "nord", x: center.x, y: margin },
      { idx: 1, name: "est", x: w - margin, y: center.y },
      { idx: 2, name: "sud", x: center.x, y: h - margin },
      { idx: 3, name: "ovest", x: margin, y: center.y },
    ].map((side) => {
      const point = clampToPlayArea(side.x, side.y);
      const threatDist = getNearestNpcDistance(point.x, point.y);
      const shipDist = distance(ship.x, ship.y, point.x, point.y);
      return { ...side, x: point.x, y: point.y, threatDist, shipDist };
    });

    return candidates.sort((a, b) => {
      if (b.threatDist !== a.threatDist) return b.threatDist - a.threatDist;
      return a.shipDist - b.shipDist;
    });
  }

  function assignRaidHealSide(ship, excludeSide = -1) {
    const sides = listRaidHealSidePoints(ship);
    const pick = sides.find((side) => side.idx !== excludeSide) || sides[0];
    if (!pick) return false;

    AUTO.raidHealSide = pick.idx;
    AUTO.raidFleeTarget = { x: pick.x, y: pick.y };
    AUTO.raidFleeTargetAt = Date.now();
    AUTO.raidHealPhase = "travel";
    return true;
  }

  /**
   * True when a straight ship→target chord would cut near the NPC swarm centroid.
   * Used to force lateral heal/flee steps instead of crossing the pack.
   */
  function raidHealPathCrossesSwarm(ship, target, clearance = 560) {
    if (!ship || !target) return false;
    const all = listNpcs(0);
    if (!all.length) return false;
    const swarm = getRaidSwarmCentroid(all);
    const dx = target.x - ship.x;
    const dy = target.y - ship.y;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1) return false;
    const t = Math.max(0, Math.min(1, ((swarm.x - ship.x) * dx + (swarm.y - ship.y) * dy) / len2));
    const px = ship.x + dx * t;
    const py = ship.y + dy * t;
    if (distance(px, py, swarm.x, swarm.y) <= clearance) return true;
    const towardSwarm = dx * (swarm.x - ship.x) + dy * (swarm.y - ship.y);
    if (towardSwarm <= 0) return false;
    return getNearestNpcDistance(px, py) <= clearance * 0.85;
  }

  /**
   * Lateral heal/evade waypoint: arc around the horde toward a safe ring near turret.
   * Never aims through the swarm centroid.
   */
  function getRaidHealEvasionWaypoint(ship) {
    const center = getRaidCenter();
    const all = listNpcs(0);
    const swarm = getRaidSwarmCentroid(all.length ? all : null);
    const turretR = getRaidTurretRange() * 0.72;
    const fireRange = getPlayerFireRange();
    const shipAngle = Math.atan2(ship.y - center.y, ship.x - center.x);
    const shipR = Math.hypot(ship.x - center.x, ship.y - center.y) || turretR + 200;

    let away = Math.atan2(ship.y - swarm.y, ship.x - swarm.x);
    if (!Number.isFinite(away)) away = shipAngle || 0;
    const side = AUTO.raidHealSide >= 0 ? (AUTO.raidHealSide % 2 === 0 ? 1 : -1) : AUTO.raidWaveEscapeDir || 1;

    const candidates = [];
    for (const dir of [side, -side]) {
      for (let step = 1; step <= 6; step++) {
        const ang = away + dir * step * 0.28;
        const outerR = Math.max(shipR * 0.96, turretR + 140, fireRange * 0.85);
        const midR = Math.max(turretR + 40, (shipR + turretR) * 0.55);
        const nearTurret = Math.max(turretR * 0.88, fireRange * 0.55);
        for (const radius of [outerR, midR, nearTurret]) {
          const pt = clampToPlayArea(center.x + Math.cos(ang) * radius, center.y + Math.sin(ang) * radius);
          const threat = getNearestNpcDistance(pt.x, pt.y);
          const towardSwarm =
            (pt.x - ship.x) * (swarm.x - ship.x) + (pt.y - ship.y) * (swarm.y - ship.y);
          const ringPenalty = Math.abs(distance(pt.x, pt.y, center.x, center.y) - turretR) * 0.2;
          candidates.push({
            x: pt.x,
            y: pt.y,
            score: threat - ringPenalty - (towardSwarm > 0 ? 160 : 0) + step * 8,
            threat,
          });
        }
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (!best) {
      return clampToPlayArea(
        ship.x + Math.cos(away + side * 0.7) * RAID_HEAL_STEP,
        ship.y + Math.sin(away + side * 0.7) * RAID_HEAL_STEP
      );
    }

    const dist = distance(ship.x, ship.y, best.x, best.y);
    if (dist <= RAID_HEAL_STEP) return { x: best.x, y: best.y };
    const t = RAID_HEAL_STEP / dist;
    return clampToPlayArea(ship.x + (best.x - ship.x) * t, ship.y + (best.y - ship.y) * t);
  }

  function sustainRaidHealAttack(input, ship) {
    if (!input || !ship) return false;
    // Keep shooting edge targets while evading — never dive into the pack for a shot
    if (isRaidShipEncircled(ship)) return false;
    const stickyId =
      AUTO.combatFocusId || AUTO.taskTargetId || AUTO.combatTargetId || null;
    const fireRange = getPlayerFireRange();
    const stickyNpc =
      stickyId && isNpcAllowedForCombat(stickyId)
        ? getStickyCombatNpcEntry(stickyId) || getNpcEntry(stickyId)
        : null;

    // Prefer sticky if still in fire band; otherwise temporary nearest for heal shots only.
    let shootNpc =
      stickyNpc && stickyNpc.dist <= fireRange + 50 ? stickyNpc : null;
    if (!shootNpc) {
      shootNpc = resolveRaidCombatTarget(null);
      if (!shootNpc || shootNpc.dist > fireRange + 50) return false;
    }

    // Skip if the target is deep inside the swarm relative to us
    const all = listNpcs(0);
    if (all.length >= 3) {
      const swarm = getRaidSwarmCentroid(all);
      const shipFromSwarm = distance(ship.x, ship.y, swarm.x, swarm.y);
      const npcFromSwarm = distance(shootNpc.x, shootNpc.y, swarm.x, swarm.y);
      if (npcFromSwarm + 80 < shipFromSwarm && shootNpc.dist < fireRange * 0.55) {
        return false;
      }
    }

    // Never overwrite living sticky with a temporary heal shoot id.
    if (!(stickyId && isLivingStickyCombatId(stickyId))) {
      AUTO.taskTargetId = shootNpc.id;
      AUTO.combatTargetId = shootNpc.id;
      AUTO.combatFocusId = shootNpc.id;
    }

    if (getGameState()?.lockedTargetId !== shootNpc.id) {
      setLockedTarget(shootNpc.id);
      input.notifyPlayerLocked?.(shootNpc.id);
    }
    engageNpc(shootNpc.id);
    sustainRaidAttack(input);
    return true;
  }

  function clearRaidHealMovement(input) {
    if (!input) return;
    input.clearMoveTarget?.();
    input.moveTarget = null;
    AUTO.lastMinimapTarget = null;
  }

  function clearRaidFleeState() {
    AUTO.raidHealMode = false;
    AUTO.raidFleeTarget = null;
    AUTO.raidFleeTargetAt = 0;
    AUTO.raidHealSide = -1;
    AUTO.raidHealPhase = null;
    if (AUTO.fleeMode === "raid") {
      AUTO.fleeActive = false;
      AUTO.fleeMode = null;
    }
    clearRaidHealMovement(getInputSystem());
  }

  function clearRaidFleeStateIfRecovered() {
    if (!shouldResumeAfterRaidHeal()) return;
    // Durante il rientro laterale non interrompere: finisce driveRaidSafeReturnTick
    if (AUTO.raidHealPhase === "return" || AUTO.raidHealMode) return;
    clearRaidFleeState();
  }

  function isRaidHealActive() {
    return AUTO.raidHealMode || (AUTO.fleeActive && AUTO.fleeMode === "raid");
  }

  function isInRaidMap() {
    const K = getGameState();
    if (K?.inRaid) return true;
    const mapId = getCurrentMapId();
    if (String(mapId || "").startsWith("RAID_")) return true;
    if (AUTO.raidGateId && isAtRaidWorkMap(AUTO.raidGateId)) return true;
    return false;
  }

  function isAtHomeMap() {
    const home = getFactionHomeMapId();
    return home && getCurrentMapId() === home;
  }

  function isInSafeZone() {
    return Boolean(getLocalPlayer()?.in_safe_zone);
  }

  /** Portal drift arrived/hold on a standard map (allied portal ring ~560m). */
  function isPortalDriftHoldPosition() {
    return Boolean(AUTO.orbitPortalDrift && AUTO.portalDriftArrived && !isInRaidMap());
  }

  /** Within allied portal regen disk (center), not the 560m combat drift ring. */
  const PORTAL_HEAL_CENTER_DIST = 120;

  /**
   * True when ship is at allied portal center for local regen.
   * Game `in_safe_zone` is often false here — distance is the reliable signal.
   */
  function isAtFriendlyPortalHealCenter(ship = getShipPosition()) {
    if (isInRaidMap() || !ship) return false;
    const portal = findNearestFriendlyPortal({ preferSafeBase: false });
    if (!portal || !Number.isFinite(portal.x) || !Number.isFinite(portal.y)) return false;
    const dist = Number.isFinite(portal.dist)
      ? portal.dist
      : distance(ship.x, ship.y, portal.x, portal.y);
    return dist <= PORTAL_HEAL_CENTER_DIST;
  }

  /**
   * Hold-still heal without hub travel: real safe zone, raid, or portal center.
   * Portal-drift "arrived" is now safe/center (same as heal). Older builds used the
   * ~560m outer ring — that left the ship outside regen; do not revive that arrive.
   */
  function isHealHoldInPlace() {
    return isInSafeZone() || isInRaidMap() || isAtFriendlyPortalHealCenter();
  }

  /**
   * HARD PRODUCT RULE (collectCargo ON): after an own NPC kill, cargo must be
   * scooped (or the drop truly gone after the full WAIT_MS window). Never abandon
   * for portal post-kill heal, heal-at-portal, next-NPC search, bonus, or orbit.
   * Priority: (1) wait/scoop kill cargo → (2) only then heal / search / next NPC.
   *
   * mac40: also treat a fresh recentCargoKillSite as open so portal-drift cold
   * heal cannot arm in the gap after pending was phantom-cleared.
   * mac41: mandatoryPostKillCargo phase is the ownership source of truth — heal
   * literally cannot start while it is open.
   */
  function hasOpenPostKillCargoLifecycle() {
    if (!AUTO.collectCargo) return false;
    if (isMandatoryPostKillCargoPhaseOpen()) return true;
    if (AUTO.pendingCombatCargo) return true;
    if (AUTO.cargoCollectInFlightId) return true;
    if (AUTO.currentTask === "collect") {
      const tid = AUTO.taskTargetId;
      if (tid && (isCargoLoot(getLootSprite(tid), tid) || AUTO.cargoCollectInFlightId === tid)) {
        return true;
      }
    }
    pruneRecentCargoKillSites();
    const now = Date.now();
    for (const site of AUTO.recentCargoKillSites || []) {
      if (!site || now - site.at > POST_KILL_CARGO_WAIT_MS) continue;
      if (site.npcId && isCargoSettledForNpc(site.npcId)) continue;
      // mac41: do not treat brief fightable flicker as "closed" for counted kills.
      if (
        site.npcId &&
        isNpcStillFightable(site.npcId) &&
        !AUTO.countedNpcKillIds.has(site.npcId)
      ) {
        continue;
      }
      return true;
    }
    return false;
  }

  /**
   * Any non-death heal/recover must yield the tick while post-kill cargo is open.
   * Death recover stays absolute (player died — scoop N/A). Hold-full is handled by
   * abortCargoCollectIfHoldFull clearing the lifecycle, not by "skip for heal".
   */
  function shouldDeferHealForPostKillCargo() {
    if (!AUTO.postDeathRecover) return false;
    if (AUTO.preObjectiveHealKind === "death") return false;
    return hasOpenPostKillCargoLifecycle();
  }

  /**
   * Portal drift + arrived: after a kill AND after cargo settles, heal Attack
   * config in place via beginPreObjectiveHeal(cold) before the next NPC search.
   * Hard rule: never arms while post-kill cargo lifecycle is open
   * (mandatory phase / pending / in-flight / fresh kill site within WAIT_MS).
   */
  function maybeBeginPortalDriftPostKillHeal() {
    if (!isPortalDriftHoldPosition()) return false;
    if (!AUTO.active || AUTO.paused || AUTO.postDeathRecover) return false;
    if (!AUTO.modeAttack || !AUTO.combatActive) return false;
    if (isPlayerFullyHealed()) return false;
    // HARD RULE: cargo first — never arm heal during mandatory wait/scoop.
    rearmPendingCombatCargoFromRecentKillSite();
    if (hasOpenPostKillCargoLifecycle()) return false;
    if (hasLivingStickyCombat()) return false;
    beginPreObjectiveHeal({ armBaseWait: false, kind: "cold" });
    return true;
  }

  function listFactionSafeBases() {
    const K = getGameState();
    const mapId = getCurrentMapId();
    const faction = String(getLocalPlayer()?.faction || "").toUpperCase();
    const live = Array.isArray(K?.bases) ? K.bases : [];
    const fallback = FALLBACK_SAFE_BASES[mapId];
    const bases = live.length
      ? live
      : fallback
        ? [fallback]
        : [];

    return bases
      .filter((b) => b && Number.isFinite(b.x) && Number.isFinite(b.y))
      .filter((b) => {
        const bf = String(b.faction || "").toUpperCase();
        if (!faction || !bf) return true;
        return bf === faction;
      })
      .map((b) => ({
        x: b.x,
        y: b.y,
        radius: Math.max(200, Number(b.safeZoneRadius) || 1024),
        faction: String(b.faction || faction || "").toUpperCase(),
      }));
  }

  /** Nearest faction base/safe-zone center on the current map, or null. */
  function getNearestFactionSafeBase(ship = getShipPosition()) {
    const bases = listFactionSafeBases();
    let best = null;
    for (const b of bases) {
      const dist = ship ? distance(ship.x, ship.y, b.x, b.y) : 0;
      if (!best || dist < best.dist) best = { ...b, dist };
    }
    return best;
  }

  /**
   * While pre-objective heal needs regen and we are not holding in a safe spot:
   * - portal drift OR cold Play: walk to allied portal CENTER on this map
   * - else: walk to local faction base, or (death only) multi-map to a hub
   * Cold Play ("cold"): LOCAL walk only — never leave the current map
   * (Stop→Play was yanking O-2/O-3 → O-1 then HP-flee to hub).
   * Returns true while travel owns the tick.
   */
  function driveHealSafeZoneTravelTick(input = getInputSystem()) {
    if (isInSafeZone() || isInRaidMap() || isAtFriendlyPortalHealCenter()) {
      AUTO.healSafeTravel = false;
      return false;
    }

    const ship = getShipPosition();
    const coldPlay = AUTO.preObjectiveHealKind === "cold";
    // Keep the recover-pending config (Attack on cold). Switching to run/roam
    // made activeNum !== pending[0] next tick → holdStillAtBase cancelled the walk.
    const healMoveConfig =
      AUTO.preObjectiveHealKind === "cold"
        ? AUTO.attackConfig
        : AUTO.runConfig || AUTO.roamConfig;

    // Portal-center heal (drift post-kill, or cold Play with no local base):
    // Always walk to allied portal center / safe (≤PORTAL_HEAL_CENTER_DIST).
    // Cold Play uses the same local walk so we never force-skip into HP-flee→X-1.
    if ((AUTO.orbitPortalDrift || coldPlay) && ship) {
      const portal = findNearestFriendlyPortal({ preferSafeBase: false });
      if (portal && Number.isFinite(portal.x) && Number.isFinite(portal.y)) {
        if (NAV.active && NAV.forHeal) stopNavigation();
        if (healMoveConfig) ensureActiveConfig(healMoveConfig);
        const dist = Number.isFinite(portal.dist)
          ? portal.dist
          : distance(ship.x, ship.y, portal.x, portal.y);
        if (dist <= PORTAL_HEAL_CENTER_DIST) {
          if (input) {
            input.clearMoveTarget?.();
            input.moveTarget = null;
          }
          AUTO.lastMinimapTarget = null;
          AUTO.healSafeTravel = false;
          setStatus("status.heal_portal_center_wait");
          return false;
        }
        if (input) setMoveTargetDirect(input, portal.x, portal.y);
        AUTO.healSafeTravel = true;
        setStatus("status.heal_portal_center_walk", { dist: Math.round(dist) });
        return true;
      }
    }

    const base = getNearestFactionSafeBase(ship);

    // Local walk into the safe circle when a base exists on this map.
    if (base && ship) {
      if (NAV.active && NAV.forHeal) stopNavigation();

      const arriveR = Math.max(140, base.radius * 0.4);
      const dist = distance(ship.x, ship.y, base.x, base.y);
      if (healMoveConfig) ensureActiveConfig(healMoveConfig);

      if (dist <= arriveR) {
        if (input) {
          input.clearMoveTarget?.();
          input.moveTarget = null;
        }
        AUTO.lastMinimapTarget = null;
        AUTO.healSafeTravel = false;
        setStatus("status.heal_safe_wait");
        return false;
      }

      if (input) setMoveTargetDirect(input, base.x, base.y);
      AUTO.healSafeTravel = true;
      setStatus("status.heal_safe_walk", { dist: Math.round(dist) });
      return true;
    }

    // Cold Play / Stop→Play: never multi-hop to X-1/X-7 just for pre-heal.
    // Stay on map (hold still via recover tick) — death recover may hub below.
    if (coldPlay) {
      if (NAV.active && NAV.forHeal) stopNavigation();
      AUTO.healSafeTravel = false;
      setStatus("status.heal_safe_hold_map");
      return false;
    }

    // Multi-hop / in-flight heal travel toward a safe map (death recover only).
    if (NAV.active && NAV.forHeal) {
      AUTO.healSafeTravel = true;
      setStatus("status.heal_safe_travel", {
        map: formatMapLabel(NAV.destinationId || pickHealSafeDestination()),
      });
      return true;
    }

    const healDest = pickHealSafeDestination();
    if (!healDest) {
      setStatus("status.heal_safe_none");
      return false;
    }

    if (getCurrentMapId() === healDest) {
      // Destination map but bases not loaded yet — hold briefly for map sync.
      setStatus("status.heal_safe_wait");
      return true;
    }

    AUTO.healSafeTravel = true;
    if (startMapNavigation(healDest, { forHeal: true })) {
      setStatus(`heal driveHealSafeZoneTravelTick→${formatMapLabel(healDest)}`);
      return true;
    }

    // Fallback: one-hop to nearest friendly non-hub portal.
    if (startMapFlee({ reason: "heal" })) {
      NAV.forHeal = true;
      setStatus(`heal startMapFlee→${formatMapLabel(healDest)}`);
      return true;
    }

    AUTO.healSafeTravel = false;
    setStatus("status.heal_safe_none");
    return false;
  }

  /**
   * Roll a wait duration around the configured seconds (±jitterSec, min 0).
   * Stores AUTO.lastRolledWaitSec for status/UI.
   */
  function rollWaitSec(baseSec, jitterSec = 2) {
    const base = Math.max(0, Number(baseSec) || 0);
    if (base <= 0) {
      AUTO.lastRolledWaitSec = 0;
      return 0;
    }
    const jit = Math.max(0, Number(jitterSec) || 0);
    const lo = Math.max(0, base - jit);
    const hi = base + jit;
    const rolled = Math.round(randBetween(lo, hi) * 10) / 10;
    AUTO.lastRolledWaitSec = rolled;
    return rolled;
  }

  function armPortalWait() {
    if (isInRaidMap()) {
      AUTO.portalWaitUntil = 0;
      AUTO.lastRolledWaitSec = 0;
      return;
    }
    if (AUTO.portalWaitSec > 0) {
      const sec = rollWaitSec(AUTO.portalWaitSec, 2);
      AUTO.portalWaitUntil = Date.now() + sec * 1000;
    } else {
      AUTO.portalWaitUntil = 0;
      AUTO.lastRolledWaitSec = 0;
    }
  }

  /**
   * Hold still while post-portal wait is active (non-raid).
   * Used by both mainTick security gates and the dedicated navigation timer.
   */
  function holdForPortalWait() {
    if (!AUTO.portalWaitUntil) return false;
    if (Date.now() >= AUTO.portalWaitUntil) {
      AUTO.portalWaitUntil = 0;
      return false;
    }
    if (isInRaidMap()) {
      AUTO.portalWaitUntil = 0;
      return false;
    }
    const input = getInputSystem();
    if (input) {
      input.clearMoveTarget?.();
      input.moveTarget = null;
    }
    AUTO.lastMinimapTarget = null;
    setStatus("status.portal_wait", {
      sec: Math.ceil((AUTO.portalWaitUntil - Date.now()) / 1000),
    });
    return true;
  }

  function registerPlayerDeath(source = "combat") {
    if (AUTO.wasDead) return false;
    AUTO.wasDead = true;
    AUTO.repairSentThisDeath = false;
    AUTO.deathSignalSince = 0;
    clearPostDeathRecoverState();
    AUTO.deathCount += 1;

    const limitPart = AUTO.deathLimit > 0 ? `/${AUTO.deathLimit}` : "";
    if (AUTO.deathLimit > 0 && AUTO.deathCount >= AUTO.deathLimit) {
      setStatus("status.death_pause", { count: AUTO.deathCount, limit: AUTO.deathLimit });
      syncSecurityPanelFromAuto();
      updateStatisticsPanel();
      stopPlay();
      setStatus("status.death_pause", { count: AUTO.deathCount, limit: AUTO.deathLimit });
      return true;
    }

    const countLabel =
      String(AUTO.deathCount) + (source === "raid" ? " · raid" : "");
    setStatus("status.death_counted", { count: countLabel, limit: limitPart });

    syncSecurityPanelFromAuto();
    updateStatisticsPanel();
    return true;
  }

  function getActiveHangarIndex() {
    const K = getGameState();
    if (Number.isFinite(K?.active_hangar_index)) return Number(K.active_hangar_index);
    const player = getLocalPlayer();
    if (Number.isFinite(player?.active_hangar_index)) return Number(player.active_hangar_index);
    return 0;
  }

  function armPostArrivalSecurityGrace(ms = POST_ARRIVAL_SECURITY_GRACE_MS) {
    const until = Date.now() + Math.max(0, Number(ms) || 0);
    if (until > (AUTO.postArrivalSecurityGraceUntil || 0)) {
      AUTO.postArrivalSecurityGraceUntil = until;
    }
  }

  function isPostArrivalSecurityGraceActive() {
    return AUTO.postArrivalSecurityGraceUntil > 0 && Date.now() < AUTO.postArrivalSecurityGraceUntil;
  }

  function clearObjectiveArrivalTransientState() {
    AUTO.fleeActive = false;
    AUTO.fleeMode = null;
    AUTO.deathSignalSince = 0;
    clearRaidFleeState();
    clearPostDeathRecoverState();
    armPostArrivalSecurityGrace();
  }

  function isDeathProfileMenuOpen() {
    try {
      const menu = getGameScene()?.ui?.mainMenu;
      if (menu?.isOpen?.()) return true;
    } catch (_) {
      /* ignore */
    }
    try {
      const panel = document.getElementById("main-menu");
      if (panel?.classList?.contains("mp-panel--open")) return true;
    } catch (_) {
      /* ignore */
    }
    return false;
  }

  function isEscPauseMenuOpen() {
    try {
      const esc = getGameScene()?.ui?.escMenu;
      if (esc?.isOpen?.()) return true;
    } catch (_) {
      /* ignore */
    }
    return Boolean(document.querySelector(".esc-overlay"));
  }

  /** Dismiss the Esc pause overlay (TORNA AL LOGIN / CHIUDI GIOCO / ANNULLA). */
  function dismissEscPauseMenu() {
    try {
      const esc = getGameScene()?.ui?.escMenu;
      if (esc?.isOpen?.() && typeof esc.close === "function") {
        esc.close();
        return true;
      }
    } catch (_) {
      /* fall through */
    }
    try {
      const cancel =
        document.querySelector('.esc-overlay [data-action="cancel"]') ||
        document.querySelector(".esc-overlay .esc-btn--cancel");
      if (cancel) {
        cancel.click();
        return true;
      }
    } catch (_) {
      /* ignore */
    }
    return false;
  }

  /**
   * Close the death/profile main menu so the user can see the game after auto-repair.
   * Prefer MainMenu.hide() / panel minimize. Escape at most once, and only when the
   * profile is still open and the Esc pause menu is not already open.
   * @param {{ allowEscape?: boolean }} [options]
   */
  function dismissDeathProfileMenu(options = {}) {
    const allowEscape = options.allowEscape === true;

    try {
      document.querySelector(".pf-repair-section")?.remove();
    } catch (_) {
      /* ignore */
    }

    // If a prior Esc opened the pause MENU, cancel it so Play is not stuck.
    if (isEscPauseMenuOpen()) {
      dismissEscPauseMenu();
    }

    try {
      const menu = getGameScene()?.ui?.mainMenu;
      if (menu?.isOpen?.()) {
        if (typeof menu.hide === "function") {
          menu.hide();
          return true;
        }
        if (typeof menu.toggle === "function") {
          menu.toggle();
          return true;
        }
      }
    } catch (_) {
      /* fall through */
    }

    try {
      const panel = document.getElementById("main-menu");
      if (panel?.classList?.contains("mp-panel--open")) {
        const closeBtn =
          panel.querySelector(".mp-minimize") || panel.querySelector(".mp-title-icon");
        if (closeBtn) {
          closeBtn.click();
          return true;
        }
      }
    } catch (_) {
      /* fall through */
    }

    try {
      // Modal overlay click → pe.closeAllModals via game UI manager.
      const overlay =
        document.querySelector("#ui-overlay [style*='z-index:150']") ||
        document.querySelector("#ui-overlay > div[style*='rgba(0, 0, 0']");
      if (overlay && overlay.style?.display !== "none") {
        overlay.click();
        return true;
      }
    } catch (_) {
      /* fall through */
    }

    // Last resort: a single Escape, never if pause MENU is already open.
    if (
      allowEscape &&
      isDeathProfileMenuOpen() &&
      !isEscPauseMenuOpen()
    ) {
      try {
        document.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            code: "Escape",
            keyCode: 27,
            which: 27,
            bubbles: true,
            cancelable: true,
          })
        );
      } catch (_) {
        /* ignore */
      }
      // If Escape opened the pause overlay instead, cancel it immediately.
      if (isEscPauseMenuOpen()) dismissEscPauseMenu();
    }
    return false;
  }

  function tryAutoRepairAfterDeath() {
    if (!AUTO.active || AUTO.paused) return false;
    if (AUTO.repairSentThisDeath) {
      // No success/fail ack → retry while still dead (B13 never got stuck silently).
      if (!AUTO.repairSentAt || Date.now() - AUTO.repairSentAt < REPAIR_RETRY_MS) {
        return false;
      }
      AUTO.repairSentThisDeath = false;
    }
    // Repair on real death: isDead, deathInfo, hangar destroyed, repair UI, or
    // already-registered death still showing dead (weak alive/hp after count).
    // Do NOT gate on deathLimit here — registerPlayerDeath owns stopPlay; callers
    // repair before register so the limiting death still gets a repair attempt.
    if (
      !getGameState()?.isDead &&
      !AUTO.deathInfoReceived &&
      !isHangarDestroyed() &&
      !hasStrongDeathUiSignal() &&
      !(AUTO.wasDead && isPlayerActuallyDead())
    ) {
      return false;
    }

    const hangarIndex = getActiveHangarIndex();
    const net = window.__RG_NET__;
    let repaired = false;
    if (typeof net?.sendRepairShip === "function") {
      try {
        net.sendRepairShip(hangarIndex);
        repaired = true;
      } catch (_) {
        /* fall through to button click */
      }
    }

    if (!repaired) {
      const btn = document.getElementById("pf-repair-btn");
      if (btn && !btn.disabled) {
        try {
          btn.click();
          repaired = true;
        } catch (_) {
          return false;
        }
      }
    }

    if (!repaired) return false;

    // Repair and death count must stay tied: never repair without registering.
    if (!AUTO.wasDead) {
      registerPlayerDeath(isInRaidMap() ? "raid" : "combat");
    }
    AUTO.repairSentThisDeath = true;
    AUTO.repairSentAt = Date.now();
    setStatus("status.auto_repair");
    // Close profile/death UI now; retries are hide-only (never Escape again).
    dismissDeathProfileMenu({ allowEscape: true });
    window.setTimeout(() => dismissDeathProfileMenu({ allowEscape: false }), 400);
    window.setTimeout(() => dismissDeathProfileMenu({ allowEscape: false }), 1200);
    return true;
  }

  function getPostDeathRecoverConfigNums() {
    // Cold Play: only the Attack config must be full. Requiring Roam too caused
    // Stop→Play to switch config, false-not-full, travel to X-1, then return to
    // workingMap — while the ship was already combat-ready on Attack.
    if (AUTO.preObjectiveHealKind === "cold") {
      const n = clamp(Math.round(Number(AUTO.attackConfig) || 1), 1, 2);
      return [n];
    }
    const nums = new Set();
    for (const raw of [AUTO.attackConfig, AUTO.roamConfig]) {
      const n = clamp(Math.round(Number(raw) || 1), 1, 2);
      nums.add(n);
    }
    if (!nums.size) nums.add(1);
    return [...nums].sort((a, b) => a - b);
  }

  function clearPostDeathRecoverState() {
    AUTO.postDeathRecover = false;
    AUTO.preObjectiveHealKind = null;
    AUTO.postDeathRecoverVerified = null;
    AUTO.postDeathRecoverSince = 0;
    AUTO.postDeathRecoverSwitchAt = 0;
    AUTO.baseWaitUntil = 0;
    AUTO.resumeTravelAfterBaseWait = false;
    AUTO.healSafeTravel = false;
    clearSafeZoneMicroFidget();
  }

  function clearSafeZoneMicroFidget() {
    AUTO.safeFidgetNextAt = 0;
    AUTO.safeFidgetHoldUntil = 0;
    AUTO.safeFidgetTarget = null;
  }

  /**
   * Tiny random safe-zone micro-moves ONLY after HP/shield are full (post-heal delay).
   * Never while regenerating — movement cancels heal. Sometimes none (idle still).
   * Returns true when a fidget waypoint is active this tick.
   */
  function maybeDriveSafeZoneMicroFidget(input = getInputSystem()) {
    if (isInRaidMap()) return false;
    if (!isPlayerFullyHealed()) {
      clearSafeZoneMicroFidget();
      return false;
    }
    // Only fidget inside a real safe / portal-center hold.
    const ship = getShipPosition();
    if (!ship) return false;
    if (!(isInSafeZone() || isAtFriendlyPortalHealCenter(ship))) return false;

    const now = Date.now();
    // Finish current micro-hold: clear target and schedule next (or skip).
    if (AUTO.safeFidgetHoldUntil && now < AUTO.safeFidgetHoldUntil) {
      const tgt = AUTO.safeFidgetTarget;
      if (tgt && input) {
        const rem = distance(ship.x, ship.y, tgt.x, tgt.y);
        if (rem > 28) {
          setMoveTargetDirect(input, tgt.x, tgt.y);
          setStatus("status.safe_fidget");
          return true;
        }
      }
      // Arrived early — sit still for the rest of the hold.
      if (input) {
        input.clearMoveTarget?.();
        input.moveTarget = null;
      }
      AUTO.lastMinimapTarget = null;
      return false;
    }

    if (AUTO.safeFidgetHoldUntil && now >= AUTO.safeFidgetHoldUntil) {
      AUTO.safeFidgetHoldUntil = 0;
      AUTO.safeFidgetTarget = null;
      if (input) {
        input.clearMoveTarget?.();
        input.moveTarget = null;
      }
      AUTO.lastMinimapTarget = null;
      // Schedule next opportunity (sometimes a long idle = no fidget).
      AUTO.safeFidgetNextAt = now + randBetween(900, 2800);
    }

    if (!AUTO.safeFidgetNextAt) {
      // First entry into post-heal window: often idle first, sometimes fidget soon.
      AUTO.safeFidgetNextAt = now + (Math.random() < 0.45 ? randBetween(400, 1200) : randBetween(1800, 4200));
      return false;
    }
    if (now < AUTO.safeFidgetNextAt) return false;

    // ~40% chance to skip this slot entirely (human: sometimes stay still).
    if (Math.random() < 0.4) {
      AUTO.safeFidgetNextAt = now + randBetween(1200, 3600);
      return false;
    }

    const ang = Math.random() * Math.PI * 2;
    const r = randBetween(28, 95);
    const pt = clampToPlayArea(ship.x + Math.cos(ang) * r, ship.y + Math.sin(ang) * r);
    // Keep fidget inside safe if we have a base radius.
    const base = getNearestFactionSafeBase(ship);
    let tx = pt.x;
    let ty = pt.y;
    if (base && base.radius > 80) {
      const dBase = distance(base.x, base.y, tx, ty);
      const maxR = Math.max(120, base.radius * 0.55);
      if (dBase > maxR) {
        const a = Math.atan2(ty - base.y, tx - base.x);
        tx = base.x + Math.cos(a) * maxR * 0.7;
        ty = base.y + Math.sin(a) * maxR * 0.7;
      }
    }
    AUTO.safeFidgetTarget = { x: tx, y: ty };
    AUTO.safeFidgetHoldUntil = now + randBetween(700, 1600);
    AUTO.safeFidgetNextAt = AUTO.safeFidgetHoldUntil + randBetween(800, 2600);
    if (input) setMoveTargetDirect(input, tx, ty);
    AUTO.lastMinimapTarget = { x: tx, y: ty };
    setStatus("status.safe_fidget");
    return true;
  }

  function holdStillAtBase(input = getInputSystem()) {
    // Do not cancel in-flight heal→safe-zone portal travel.
    if (!(NAV.active && (NAV.forHeal || AUTO.healSafeTravel))) {
      stopNavigation();
    }
    clearRaidFleeState();
    AUTO.fleeActive = false;
    AUTO.fleeMode = null;
    clearCurrentTask();
    if (input) {
      input.attackMode = false;
      input.pendingAttackOnLock = null;
      clearRaidHealMovement(input);
      input.clearMoveTarget?.();
      input.moveTarget = null;
    }
    AUTO.lastMinimapTarget = null;
  }

  /**
   * Stay still until required configs are full (and optional baseWaitSec).
   * Cold Play ("cold"): Attack config only — no X-1 round-trip just to verify Roam.
   * Death/flee ("death"): Attack+Roam; may travel to faction safe hub if needed.
   * @param {{ armBaseWait?: boolean, kind?: "cold"|"death" }} [options]
   */
  function beginPreObjectiveHeal(options = {}) {
    const armBaseWait = options.armBaseWait === true;
    const kind = options.kind === "death" || armBaseWait ? "death" : "cold";
    // HARD RULE: never arm cold heal (portal post-kill / Stop→Play cold) while
    // post-kill cargo wait/scoop is open — cargo must finish first.
    if (kind !== "death" && hasOpenPostKillCargoLifecycle()) {
      return;
    }
    holdStillAtBase();
    clearSafeZoneMicroFidget();
    AUTO.postDeathRecover = true;
    AUTO.preObjectiveHealKind = kind;
    AUTO.postDeathRecoverVerified = new Set();
    AUTO.postDeathRecoverSince = Date.now();
    AUTO.postDeathRecoverSwitchAt = 0;
    AUTO.resumeTravelAfterBaseWait = false;
    AUTO.deathSignalSince = 0;
    AUTO.healSafeTravel = false;
    if (armBaseWait && AUTO.baseWaitSec > 0) {
      const sec = rollWaitSec(AUTO.baseWaitSec, 2);
      AUTO.baseWaitUntil = Date.now() + sec * 1000;
    } else {
      AUTO.baseWaitUntil = 0;
      AUTO.lastRolledWaitSec = 0;
    }
    if (isPlayerFullyHealed() || isHealHoldInPlace() || isInRaidMap()) {
      setStatus("status.base_heal_wait");
    } else if (kind === "cold" || AUTO.orbitPortalDrift) {
      // Honest status: cold/drift heal stays on this map (portal center / local base).
      setStatus("status.heal_local_arm");
    } else {
      setStatus("status.heal_safe_travel", {
        map: formatMapLabel(pickHealSafeDestination() || getFactionHomeMapId()),
      });
    }
  }

  function beginPostDeathRecover() {
    beginPreObjectiveHeal({ armBaseWait: true, kind: "death" });
  }

  function finishPostDeathRecoverAndResume() {
    // HARD RULE: never resume search/combat while post-kill cargo is still open.
    if (hasOpenPostKillCargoLifecycle()) {
      AUTO.postDeathRecover = true;
      AUTO.healSafeTravel = false;
      return false;
    }
    // Capture before clear — cold vs death decides whether workingMap travel is allowed.
    const wasCold = AUTO.preObjectiveHealKind === "cold";
    // Clear recover flag so maybeResumeObjectiveAfterDeath is allowed to run.
    AUTO.postDeathRecover = false;
    AUTO.baseWaitUntil = 0;
    AUTO.resumeTravelAfterBaseWait = false;
    AUTO.healSafeTravel = false;

    // Cold Play (Stop→Play): stay on the map Play started on unless the user
    // explicitly changed workingMapId while stopped (want !== stayId).
    // Root cause of X-1 yank: stale workingMapId (often hub) + beginPlayTravel.
    // mac42: if current map ≠ workingMapId after flee/heal, NEVER pin the wrong
    // map via syncWorkingMapToCurrentMap — travel back instead.
    if (wasCold && !AUTO.raidGateId) {
      const currentId = getCurrentMapId();
      const stayId = AUTO.coldPlayStayMapId || currentId;
      const want = AUTO.workingMapId || "";
      if (want && currentId && want !== currentId) {
        // Off working map (unintended flee jump, or intentional objective change).
        setStatus(`Play travel cold→beginPlayTravel workingMapId→${formatMapLabel(want)}`);
      } else if (!want || want === currentId || (want === stayId && currentId === stayId)) {
        syncWorkingMapToCurrentMap("cold-stay");
        AUTO.coldPlayStayMapId = "";
        clearPostDeathRecoverState();
        armPostArrivalSecurityGrace();
        if (AUTO.combatSuspendedForFlee) resumeCombatAfterFlee();
        setStatus(
          `Cura ok — resto su ${formatMapLabel(currentId || stayId)} (cold-stay, no beginPlayTravel)`
        );
        return true;
      } else {
        // Intentional objective change while stopped → travel after local heal.
        setStatus(`Play travel cold→beginPlayTravel workingMapId→${formatMapLabel(want)}`);
      }
    }

    const needsTravel = needsTravelBeforeWork();
    const ok = maybeResumeObjectiveAfterDeath();
    AUTO.coldPlayStayMapId = "";
    if (ok || !needsTravel) {
      clearPostDeathRecoverState();
      // Block false death/HP-flee while travel starts or objective work resumes.
      armPostArrivalSecurityGrace();
      if (AUTO.combatSuspendedForFlee) resumeCombatAfterFlee();
      if (ok && needsTravel) {
        /* beginPlayTravel / maybeResume already set a diagnostic status */
      } else {
        setStatus("status.base_heal_done");
      }
      return ok;
    }
    // Travel could not start yet (e.g. raid portal not ready) — stay still and retry.
    AUTO.postDeathRecover = true;
    setStatus("status.resume_after_death");
    return false;
  }

  /**
   * Pre-objective heal: stay still until Attack (+ Roam on death) configs report full
   * HP/shield, and any armed baseWaitUntil has elapsed, then resume objective.
   * Outside raid: if a config still needs heal and we are not hold-in-place,
   * travel locally (portal center / base) or — death only — to a safe hub.
   * Returns true while recover owns the tick (blocks flee/wander/combat).
   */
  function drivePostDeathRecoverTick() {
    if (!AUTO.active || AUTO.paused || !AUTO.postDeathRecover) return false;
    // HARD RULE: cargo scoop owns the tick over cold heal — never walk away / finish recover.
    if (shouldDeferHealForPostKillCargo()) {
      AUTO.healSafeTravel = false;
      return false;
    }
    if (AUTO.deathLimit > 0 && AUTO.deathCount >= AUTO.deathLimit) {
      clearPostDeathRecoverState();
      return false;
    }

    const configs = getPostDeathRecoverConfigNums();
    const verified = AUTO.postDeathRecoverVerified || (AUTO.postDeathRecoverVerified = new Set());
    const activeNum = getActiveConfigIndex() + 1;
    const now = Date.now();

    // Give the game a moment after a config switch before trusting HP/shield.
    const switchCooling =
      AUTO.postDeathRecoverSwitchAt > 0 && now - AUTO.postDeathRecoverSwitchAt < 1700;

    const pending = configs.filter((n) => !verified.has(n));

    // Need heal and not hold-in-place → local portal/base travel first (blocks HP-flee).
    // Do NOT require activeNum === pending[0]: travel must keep owning movement even
    // while we switch configs; otherwise holdStillAtBase cancels the portal walk.
    // Never force-verify cold while damaged — that ended recover and let HP-flee → X-1.
    if (
      pending.length &&
      !isInRaidMap() &&
      !isHealHoldInPlace() &&
      !switchCooling &&
      !isPlayerFullyHealed()
    ) {
      const input = getInputSystem();
      if (input) {
        input.attackMode = false;
        input.pendingAttackOnLock = null;
      }
      clearLockedTarget();
      clearSafeZoneMicroFidget();
      if (driveHealSafeZoneTravelTick(input)) return true;
      // Travel unavailable this tick (no portal yet): hold still; keep recover armed
      // so shouldFleeByHp cannot yank the ship to a hub via startMapFlee.
    }

    if (!switchCooling && isPlayerFullyHealed()) {
      verified.add(activeNum);
    }

    const stillPending = configs.filter((n) => !verified.has(n));
    if (!stillPending.length) {
      // Both configs full — also respect configured base wait (parallel / whichever longer).
      // HP/shield already full: hold still during regen is done; allow occasional micro-fidget.
      if (AUTO.baseWaitUntil && now < AUTO.baseWaitUntil) {
        const input = getInputSystem();
        if (!maybeDriveSafeZoneMicroFidget(input)) {
          if (input) {
            input.clearMoveTarget?.();
            input.moveTarget = null;
          }
          AUTO.lastMinimapTarget = null;
        }
        const left = Math.ceil((AUTO.baseWaitUntil - now) / 1000);
        const rolled = AUTO.lastRolledWaitSec > 0 ? AUTO.lastRolledWaitSec : left;
        setStatus("status.base_wait", { sec: left, rolled });
        return true;
      }
      AUTO.baseWaitUntil = 0;
      clearSafeZoneMicroFidget();
      // Prefer attack config before leaving base.
      ensureActiveConfig(AUTO.attackConfig || configs[0]);
      finishPostDeathRecoverAndResume();
      return true;
    }

    // Still regenerating: hold perfectly still (movement cancels heal).
    holdStillAtBase();
    clearSafeZoneMicroFidget();

    const need = stillPending[0];
    if (activeNum !== need) {
      if (ensureActiveConfig(need)) {
        // Already on target (race) — wait for heal read next tick.
      } else {
        AUTO.postDeathRecoverSwitchAt = Date.now();
      }
      setStatus("status.base_heal_config", { n: need });
      return true;
    }

    const hp = getPlayerHpSnapshot();
    const sh = getPlayerShieldSnapshot();
    setStatus("status.base_heal_wait_detail", {
      n: activeNum,
      hp: Math.round(hp.percent),
      sh: Math.round(sh.percent),
    });
    return true;
  }

  function maybeResumeObjectiveAfterDeath() {
    if (!AUTO.active || AUTO.paused) return false;
    if (AUTO.deathLimit > 0 && AUTO.deathCount >= AUTO.deathLimit) return false;
    if (AUTO.postDeathRecover) return false;
    if (NAV.active) return false;
    if (!needsTravelBeforeWork()) {
      // Already on objective map — just continue Play tick work.
      armPostArrivalSecurityGrace();
      setStatus("status.base_heal_done");
      return true;
    }
    const ok = beginPlayTravel();
    if (ok) {
      armPostArrivalSecurityGrace();
      // Keep beginPlayTravel diagnostic status (workingMapId / raid) when travel starts.
      if (!AUTO.raidGateId && AUTO.workingMapId && getCurrentMapId() !== AUTO.workingMapId) {
        /* status already set inside beginPlayTravel */
      } else if (AUTO.raidGateId) {
        /* status already set inside beginPlayTravel */
      } else {
        setStatus("status.resume_after_death");
      }
    }
    return ok;
  }

  /** True when the death/repair screen is actually shown (strong signal). */
  function hasStrongDeathUiSignal() {
    try {
      const section = document.querySelector(".pf-repair-section");
      if (section) {
        const style = window.getComputedStyle?.(section);
        if (!style || (style.display !== "none" && style.visibility !== "hidden")) return true;
      }
    } catch (_) {
      /* ignore */
    }
    try {
      const btn = document.getElementById("pf-repair-btn");
      if (btn && !btn.disabled) {
        // offsetParent null when display:none or not in tree; still accept if in open menu
        if (btn.offsetParent != null) return true;
        const menu = document.getElementById("main-menu");
        if (menu?.classList?.contains("mp-panel--open")) return true;
      }
    } catch (_) {
      /* ignore */
    }
    return false;
  }

  function isHangarDestroyed() {
    try {
      const player = getLocalPlayer();
      const hangars = player?.hangars;
      if (!hangars) return false;
      const idx = getActiveHangarIndex();
      const hangar = Array.isArray(hangars) ? hangars[idx] : hangars?.[idx];
      return Boolean(hangar?.destroyed);
    } catch (_) {
      return false;
    }
  }

  /**
   * Match game death gating, plus sticky deathInfo / repair UI.
   * Cause-agnostic: player / NPC / radiation all count when the ship is actually dead.
   * alive===false is sticky death (hp sync may lag); hp<=0 + hangar destroyed also counts.
   */
  function isPlayerActuallyDead() {
    if (AUTO.deathInfoReceived) return true;
    const K = getGameState();
    if (K?.isDead) return true;
    if (hasStrongDeathUiSignal()) return true;
    const player = getLocalPlayer();
    if (!player) return false;
    const hp = Number(player.hp) || 0;
    // alive=false is definitive even if HP packet lags (mirror NPC sticky fix).
    if (player.alive === false) return true;
    if (hp <= 0 && isHangarDestroyed()) return true;
    if (isHangarDestroyed() && hp <= 0) return true;
    return false;
  }

  function shouldIgnoreDeathSignal() {
    // Real death signals always win — never suppress NPC / radiation / PvP deaths.
    if (AUTO.deathInfoReceived || hasStrongDeathUiSignal()) return false;
    if (getGameState()?.isDead) return false;
    const player = getLocalPlayer();
    const hp = Number(player?.hp) || 0;
    if (player && player.alive === false) return false;
    if (isHangarDestroyed() && player && (player.alive === false || hp <= 0)) return false;

    if (AUTO.postDeathRecover) return true;
    if (isPostArrivalSecurityGraceActive()) return true;
    if (AUTO.portalWaitUntil && Date.now() < AUTO.portalWaitUntil) return true;
    // Portal hops / map loads often flicker alive/isDead — never count those as deaths.
    if (NAV.active && (NAV.kind === "map" || NAV.kind === "raid" || NAV.kind === "flee" || NAV.playAfterArrival)) {
      return true;
    }
    return false;
  }

  function checkPlayerDeathState() {
    const dead = isPlayerActuallyDead();
    const strong =
      AUTO.deathInfoReceived ||
      hasStrongDeathUiSignal() ||
      Boolean(getGameState()?.isDead) ||
      (getLocalPlayer()?.alive === false &&
        (Number(getLocalPlayer()?.hp) || 0) <= 0);

    if (dead) {
      if (shouldIgnoreDeathSignal()) {
        AUTO.deathSignalSince = 0;
        return;
      }
      const now = Date.now();
      // Strong / definitive deaths: register immediately so repair cannot race ahead
      // of deathCount / wasDead (that left Play stuck at base with no recover).
      // Weak signals keep a short debounce against map-sync flicker.
      const debounceMs = strong ? 0 : DEATH_SIGNAL_DEBOUNCE_MS;
      if (!AUTO.deathSignalSince) {
        AUTO.deathSignalSince = now;
        // Restore B13: repair ASAP on first strong sight (idempotent via repairSent).
        if (strong && AUTO.active) tryAutoRepairAfterDeath();
        if (!strong) return;
      }
      if (now - AUTO.deathSignalSince < debounceMs) return;

      // Repair before register so death-limit stopPlay cannot block auto-repair.
      if (AUTO.active) tryAutoRepairAfterDeath();
      registerPlayerDeath(isInRaidMap() ? "raid" : "combat");
      AUTO.deathSignalSince = 0;
      if (AUTO.active) tryAutoRepairAfterDeath();
      return;
    }

    AUTO.deathSignalSince = 0;

    // Still look dead via hangar/UI even if alive/hp flickered — keep repairing, do not recover.
    if (AUTO.wasDead && (hasStrongDeathUiSignal() || isHangarDestroyed() || getGameState()?.isDead)) {
      if (AUTO.active) tryAutoRepairAfterDeath();
      return;
    }

    // Only clear sticky deathInfo when clearly alive again.
    const player = getLocalPlayer();
    const hp = Number(player?.hp) || 0;
    const clearlyAlive =
      player &&
      player.alive !== false &&
      hp > 0 &&
      !getGameState()?.isDead &&
      !hasStrongDeathUiSignal();
    if (clearlyAlive) AUTO.deathInfoReceived = false;

    if (!AUTO.wasDead) return;
    if (!clearlyAlive) {
      // Flicker out of dead without a real revive — keep wasDead and retry repair.
      if (AUTO.active) tryAutoRepairAfterDeath();
      return;
    }
    AUTO.wasDead = false;
    AUTO.repairSentThisDeath = false;
    AUTO.repairSentAt = 0;
    dismissDeathProfileMenu({ allowEscape: false });

    if (AUTO.deathLimit > 0 && AUTO.deathCount >= AUTO.deathLimit) return;

    // Respawned: freeze at base and wait for full heal on both combat configs.
    // Do NOT start a short timer then wander/flee to a map edge.
    // Tied to wasDead from registerPlayerDeath (always set before successful repair).
    beginPostDeathRecover();
  }

  function isFriendlyMap(mapId) {
    const player = getLocalPlayer();
    const faction = String(player?.faction || "").toUpperCase();
    if (!faction || !mapId) return false;
    const node = getMapNode(mapId);
    if (node?.faction && String(node.faction).toUpperCase() === faction) return true;
    return mapId === getFactionHomeMapId();
  }

  function findNearestPortal(options = {}) {
    const ship = getShipPosition();
    const portals = getGameState()?.portals || [];
    const preferSafeBase = options.preferSafeBase === true;
    const avoidHubs = options.avoidHubs !== false; // default: never flee into Sector X
    const avoidTargetId = options.avoidTargetId || null;
    let best = null;

    for (const p of portals) {
      const targetRaw = String(p.target_map || p.targetMap || "");
      if (targetRaw === "next_stage" || targetRaw === "exit") continue;

      const targetId = normalizePortalTarget(targetRaw);
      if (options.friendlyOnly && targetId && !isFriendlyMap(targetId)) continue;
      if (avoidHubs && isNavHubMap(targetId)) continue;
      if (avoidTargetId && targetId === avoidTargetId) continue;

      const dist = ship ? distance(ship.x, ship.y, p.x, p.y) : 0;
      // Prefer maps with known safe bases (X-7 / home) over O-5 when scoring is close.
      const safeBonus = preferSafeBase && mapHasKnownSafeBase(targetId) ? -5000 : 0;
      const score = dist + safeBonus;
      if (!best || score < best.score) {
        best = {
          ...p,
          dist,
          score,
          targetId,
          label: formatMapLabel(targetId || targetRaw),
        };
      }
    }

    return best;
  }

  function findNearestFriendlyPortal(options = {}) {
    return findNearestPortal({
      friendlyOnly: true,
      avoidHubs: true,
      preferSafeBase: true,
      ...options,
    });
  }

  function formatDurationMinutes(totalMin) {
    const mins = Math.max(0, Math.ceil(totalMin));
    if (mins >= 60) {
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      return m ? `${h}h ${m}m` : `${h}h`;
    }
    return `${mins}m`;
  }

  /** Whole seconds remaining until `untilMs` (0 if inactive/expired). */
  function secondsUntil(untilMs) {
    if (!untilMs || untilMs <= 0) return 0;
    return Math.max(0, Math.ceil((untilMs - Date.now()) / 1000));
  }

  /** Compact display: `7s` under 90s, else `m:ss`. */
  function formatCountdownSec(totalSec) {
    const sec = Math.max(0, Math.ceil(Number(totalSec) || 0));
    if (sec < 90) return `${sec}s`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  /**
   * Highest-priority active user-facing wait.
   * Returns { key, sec, until } or null.
   */
  function getActiveTimerCountdown() {
    const now = Date.now();

    if (AUTO.coffeeBreakUntil && now < AUTO.coffeeBreakUntil) {
      return {
        key: AUTO.portalHoldReason === "admin" ? "admin" : "coffee",
        sec: Math.ceil((AUTO.coffeeBreakUntil - now) / 1000),
        until: AUTO.coffeeBreakUntil,
      };
    }
    if (AUTO.portalWaitUntil && now < AUTO.portalWaitUntil) {
      return {
        key: "portal",
        sec: Math.ceil((AUTO.portalWaitUntil - now) / 1000),
        until: AUTO.portalWaitUntil,
      };
    }
    if (AUTO.baseWaitUntil && now < AUTO.baseWaitUntil) {
      return {
        key: "base",
        sec: Math.ceil((AUTO.baseWaitUntil - now) / 1000),
        until: AUTO.baseWaitUntil,
      };
    }
    if (AUTO.active && AUTO.sessionLimitMin > 0 && AUTO.sessionStartedAt > 0) {
      const until = AUTO.sessionStartedAt + AUTO.sessionLimitMin * 60000;
      if (now < until) {
        return {
          key: "stop",
          sec: Math.ceil((until - now) / 1000),
          until,
        };
      }
    }
    if (
      AUTO.active &&
      AUTO.coffeeBreakIntervalMin > 0 &&
      AUTO.nextCoffeeBreakAt > 0 &&
      now < AUTO.nextCoffeeBreakAt &&
      !AUTO.coffeeBreakActive &&
      NAV.kind !== "coffee"
    ) {
      return {
        key: "coffee_next",
        sec: Math.ceil((AUTO.nextCoffeeBreakAt - now) / 1000),
        until: AUTO.nextCoffeeBreakAt,
      };
    }
    return null;
  }

  function syncTimerCountdownUi() {
    const el = document.getElementById("rg-timer-countdown");
    if (!el) return;
    const active = getActiveTimerCountdown();
    if (!active || active.sec <= 0) {
      el.hidden = true;
      el.textContent = "";
      el.removeAttribute("data-timer");
      return;
    }
    const label = t(`ui.timer.${active.key}`);
    el.hidden = false;
    el.dataset.timer = active.key;
    el.textContent = `${label} ${formatCountdownSec(active.sec)}`;
  }

  function getSessionRemainingMin() {
    if (!AUTO.sessionLimitMin || !AUTO.sessionStartedAt) return null;
    const leftMs = AUTO.sessionLimitMin * 60000 - (Date.now() - AUTO.sessionStartedAt);
    return Math.max(0, leftMs / 60000);
  }

  function scheduleNextCoffeeBreak() {
    if (AUTO.coffeeBreakIntervalMin <= 0) {
      AUTO.nextCoffeeBreakAt = 0;
      return;
    }
    const base = Number(AUTO.coffeeBreakIntervalMin) || 0;
    const tol = getCoffeeToleranceMin();
    const pctJitter = base * 0.15;
    const jitter = tol > 0 ? Math.max(tol, pctJitter * 0.25) : pctJitter;
    const lo = Math.max(0.5, base - jitter);
    const hi = Math.max(lo, base + jitter);
    const mins = randBetween(lo, hi);
    AUTO.nextCoffeeBreakAt = Date.now() + mins * 60000;
  }

  /** ± minutes for coffee/admin hold (and interval) humanization. */
  function getCoffeeToleranceMin() {
    const raw = Number(AUTO.coffeeBreakToleranceMin);
    if (Number.isFinite(raw) && raw >= 0) return raw;
    const dur = Number(AUTO.coffeeBreakDurationMin) || 0;
    return dur > 0 ? 2 : 0;
  }

  /** Configured hold minutes (no jitter) — fallback 5 if unset. */
  function getCoffeeHoldDurationMin() {
    const mins = Number(AUTO.coffeeBreakDurationMin) || 0;
    return mins > 0 ? mins : 5;
  }

  /**
   * Humanized hold: uniform in [max(0.5, set−tol), set+tol].
   * Same formula for coffee breaks and admin pause.
   */
  function rollCoffeeHoldDurationMin() {
    const base = getCoffeeHoldDurationMin();
    const tol = getCoffeeToleranceMin();
    const lo = Math.max(0.5, base - tol);
    const hi = Math.max(lo, base + tol);
    return randBetween(lo, hi);
  }

  /** Display rolled minutes as m:ss (e.g. 3.45 → "3:27"). */
  function formatHoldDurationLabel(totalMin) {
    const sec = Math.max(0, Math.round(Number(totalMin) * 60));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function finishCoffeeBreak() {
    const wasAdmin = AUTO.portalHoldReason === "admin";
    const adminName = AUTO.adminPauseName || "";
    AUTO.coffeeBreakUntil = 0;
    AUTO.coffeeBreakActive = false;
    AUTO.portalHoldReason = null;
    AUTO.adminPauseLatched = false;
    AUTO.adminPauseName = "";
    AUTO.coffeeHoldRolledMin = 0;
    scheduleNextCoffeeBreak();
    if (wasAdmin) {
      sendDiscordAdminAlert(
        "admin_resume",
        t("discord.admin_alert.resume", { name: adminName || "?" }),
        { name: adminName }
      );
    }
    if (isGameLoginScreenVisible() || !getLocalPlayer()) {
      beginCoffeeReloginPoll();
      return;
    }
    resumeCombatAfterFlee();
    setStatus(wasAdmin ? "status.admin_pause_done" : "status.coffee_done");
  }

  function getGameSavedAccounts() {
    try {
      const raw = localStorage.getItem(GAME_SAVED_ACCOUNTS_KEY);
      const list = JSON.parse(raw || "[]");
      return Array.isArray(list) ? list : [];
    } catch (_) {
      return [];
    }
  }

  function decodeSavedAccountPassword(encoded) {
    if (!encoded) return "";
    try {
      return decodeURIComponent(escape(atob(encoded)));
    } catch (_) {
      try {
        return atob(encoded);
      } catch {
        return "";
      }
    }
  }

  function noteLoginFormCredentials() {
    const userEl = document.querySelector("#ls-username");
    const user = userEl?.value?.trim();
    if (user && user.length >= 3) {
      AUTO.playSessionUsername = user;
    }
  }

  function capturePlayLoginIdentity() {
    noteLoginFormCredentials();
    if (AUTO.playSessionUsername) return;
    const accounts = getGameSavedAccounts();
    if (accounts[0]?.username) {
      AUTO.playSessionUsername = String(accounts[0].username);
    }
  }

  function resolveCoffeeLoginCredentials() {
    noteLoginFormCredentials();
    let username = (AUTO.playSessionUsername || "").trim();
    const accounts = getGameSavedAccounts();
    if (!username && accounts[0]?.username) username = String(accounts[0].username);

    const passField = document.querySelector("#ls-password");
    let password = passField?.value || "";
    if (!password && username) {
      const match =
        accounts.find((a) => a && a.username === username) ||
        (accounts.length === 1 ? accounts[0] : null);
      if (match?.password) password = decodeSavedAccountPassword(match.password);
    }
    // Prefer filled form username if present (Remember me may already populate).
    const formUser = document.querySelector("#ls-username")?.value?.trim();
    if (formUser) username = formUser;
    if (!password && passField?.value) password = passField.value;

    return { username: username || "", password: password || "" };
  }

  function isGameLoginScreenVisible() {
    const btn = document.querySelector("#ls-login-btn");
    const user = document.querySelector("#ls-username");
    if (!btn || !user) return false;
    const style = window.getComputedStyle(btn);
    if (style.display === "none" || style.visibility === "hidden") return false;
    // Login root usually sits in .ls-panel — if button is in DOM and laid out, treat as visible.
    return btn.getClientRects().length > 0;
  }

  function beginCoffeeReloginPoll() {
    AUTO.coffeeReloginUntil = Date.now() + COFFEE_RELOGIN_WINDOW_MS;
    AUTO.coffeeReloginAttemptedAt = 0;
    setStatus("status.coffee_relogin");
    tryCoffeeReloginTick();
  }

  function tryCoffeeReloginTick() {
    if (!AUTO.coffeeReloginUntil) return false;
    if (Date.now() > AUTO.coffeeReloginUntil) {
      AUTO.coffeeReloginUntil = 0;
      if (isGameLoginScreenVisible()) {
        setStatus("status.coffee_relogin_need_manual");
      } else if (getLocalPlayer()) {
        resumeCombatAfterFlee();
        setStatus("status.coffee_done");
      } else {
        setStatus("status.coffee_relogin_need_manual");
      }
      return true;
    }

    // Already back in map after login.
    if (getLocalPlayer() && !isGameLoginScreenVisible()) {
      AUTO.coffeeReloginUntil = 0;
      resumeCombatAfterFlee();
      setStatus("status.coffee_done");
      return true;
    }

    if (!isGameLoginScreenVisible()) return false;
    if (
      AUTO.coffeeReloginAttemptedAt &&
      Date.now() - AUTO.coffeeReloginAttemptedAt < COFFEE_RELOGIN_RETRY_MS
    ) {
      return true;
    }

    const { username, password } = resolveCoffeeLoginCredentials();
    const userEl = document.querySelector("#ls-username");
    const passEl = document.querySelector("#ls-password");
    const loginBtn = document.querySelector("#ls-login-btn");
    if (!userEl || !passEl || !loginBtn) return true;

    if (!username || !password || password.length < 6) {
      AUTO.coffeeReloginUntil = 0;
      setStatus("status.coffee_relogin_need_manual");
      return true;
    }

    userEl.value = username;
    passEl.value = password;
    AUTO.playSessionUsername = username;
    AUTO.coffeeReloginAttemptedAt = Date.now();
    setStatus("status.coffee_relogin");
    try {
      loginBtn.click();
    } catch (_) {
      AUTO.coffeeReloginUntil = 0;
      setStatus("status.coffee_relogin_need_manual");
    }
    return true;
  }

  function startCoffeeBreakNavigation(options = {}) {
    if (AUTO.coffeeBreakActive || NAV.kind === "coffee") return false;
    if (isRaidHealActive() || AUTO.fleeActive) return false;
    if (AUTO.postDeathRecover) return false;
    if (AUTO.portalWaitUntil && Date.now() < AUTO.portalWaitUntil) return false;

    // Allied portal — walk to center/safe (NAV coffee tick), not any portal's outer ring.
    const portal =
      findNearestFriendlyPortal({ preferSafeBase: false }) || findNearestPortal();
    if (!portal) {
      if (options.reason !== "admin") scheduleNextCoffeeBreak();
      return false;
    }

    const reason = options.reason === "admin" ? "admin" : "coffee";
    AUTO.portalHoldReason = reason;
    if (reason === "admin" && options.adminName) {
      AUTO.adminPauseName = String(options.adminName);
    } else if (reason !== "admin") {
      AUTO.adminPauseName = "";
    }

    clearCurrentTask();
    suspendCombatForFlee();
    ensureActiveConfig(AUTO.roamConfig);
    ensureNavigationLoop();
    NAV.active = true;
    NAV.kind = "coffee";
    NAV.path = [portal];
    NAV.destinationId = portal.targetId || portal.target_map;
    NAV.phase = "move";
    NAV.moveStartedAt = Date.now();
    NAV.jumpStartedAt = 0;
    NAV.lastMapId = getCurrentMapId();
    updatePlayControls();
    if (reason === "admin") {
      setStatus("status.admin_to_safe", {
        name: AUTO.adminPauseName || "?",
        dist: Math.round(portal.dist),
      });
    } else {
      setStatus("status.coffee_to_safe", { dist: Math.round(portal.dist) });
    }
    return true;
  }

  function beginSessionTimers() {
    AUTO.sessionStartedAt = Date.now();
    scheduleNextCoffeeBreak();
  }

  function resetSessionTimers() {
    AUTO.sessionStartedAt = 0;
    AUTO.coffeeBreakActive = false;
    AUTO.coffeeBreakUntil = 0;
    AUTO.nextCoffeeBreakAt = 0;
    AUTO.coffeeHoldRolledMin = 0;
    AUTO.portalHoldReason = null;
    AUTO.adminPauseLatched = false;
    AUTO.adminPauseCooldownUntil = 0;
    AUTO.adminPauseName = "";
    AUTO.sectorZHoldActive = false;
  }

  function findRaidStagePortal(kind) {
    const portals = getGameState()?.portals || [];
    return portals.find((p) => String(p.target_map || p.targetMap || "") === kind) || null;
  }

  function getRaidTurretRange() {
    const level = Math.max(1, getGameState()?.raidTurretLevel || 1);
    return 700 + (level - 1) * 100;
  }

  function getRaidCenter() {
    const { w, h } = getMapBounds();
    return { x: (w || 0) * 0.5, y: (h || 0) * 0.5 };
  }

  function getRaidSupportPoint(ship, fraction = 0.68) {
    const center = getRaidCenter();
    const targetR = getRaidTurretRange() * fraction;
    const minR = targetR * 0.35;
    const dx = ship.x - center.x;
    const dy = ship.y - center.y;
    const dist = Math.hypot(dx, dy) || 1;
    const angle = Math.atan2(dy, dx);
    const radius = clamp(dist, minR, targetR);
    return clampToPlayArea(center.x + Math.cos(angle) * radius, center.y + Math.sin(angle) * radius);
  }

  function clampToRaidSupportZone(x, y) {
    // Story 3 (~3802): hard turret×0.78. Kept for non-combat callers.
    if (!isInRaidMap()) return clampToPlayArea(x, y);
    const center = getRaidCenter();
    const maxR = getRaidTurretRange() * 0.78;
    const dx = x - center.x;
    const dy = y - center.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= maxR) return clampToPlayArea(x, y);
    const angle = Math.atan2(dy, dx);
    return clampToPlayArea(center.x + Math.cos(angle) * maxR, center.y + Math.sin(angle) * maxR);
  }

  /**
   * Delta E: Story 3 support ring as preferred attractor, not hard slam wall.
   * Temporary exit OK; gentle pull back; hard only at softMax (~turret×0.98).
   */
  function softClampToRaidSupportZone(x, y) {
    if (!isInRaidMap()) return clampToPlayArea(x, y);
    const center = getRaidCenter();
    const supportMax = getRaidTurretRange() * 0.78;
    const softMax = getRaidTurretRange() * 0.98;
    const dx = x - center.x;
    const dy = y - center.y;
    const dist = Math.hypot(dx, dy) || 1;
    const angle = Math.atan2(dy, dx);
    if (dist <= supportMax) return clampToPlayArea(x, y);
    if (dist >= softMax) {
      return clampToPlayArea(
        center.x + Math.cos(angle) * softMax,
        center.y + Math.sin(angle) * softMax
      );
    }
    const overshoot = dist - supportMax;
    const pull = Math.min(overshoot, Math.max(22, overshoot * 0.28));
    const newR = dist - pull;
    return clampToPlayArea(
      center.x + Math.cos(angle) * newR,
      center.y + Math.sin(angle) * newR
    );
  }

  function maintainRaidSupportDuringCombat(input, ship) {
    // Story 3 (~3814): return toward tower only when no nearby NPCs
    if (!isInRaidMap() || !input || !ship || isRaidHealActive()) return false;

    const fireRange = getPlayerFireRange();
    if (listNpcs(fireRange + 120).length > 0) return false;

    const center = getRaidCenter();
    const dist = distance(ship.x, ship.y, center.x, center.y);
    const maxR = getRaidTurretRange() * 0.75;
    if (dist <= maxR) return false;

    const pt = getRaidSupportPoint(ship, 0.65);
    setMoveTargetDirect(input, pt.x, pt.y);
    setStatus(`Raid: rientro nel raggio torre (${Math.round(dist)}m)`);
    return true;
  }

  function getRaidRetreatPoint(ship) {
    return getRaidSupportPoint(ship, 0.58);
  }

  function startMapFlee(options = {}) {
    // Never interrupt an in-progress heal→safe-zone route with another flee hop
    // (that was O-5 ↔ Sector X: heal jumps to SX, HP flee returns to O-5).
    if (options.reason !== "heal" && isHealSafeTravelActive()) {
      return false;
    }

    // Oscillation guard: abort cycling and force heal dest with hub-free path.
    if (isNavMapOscillating()) {
      clearNavMapHistory();
      stopNavigation();
      const dest = pickHealSafeDestination();
      if (dest && getCurrentMapId() !== dest) {
        if (startMapNavigation(dest, { forHeal: true, _healRerouted: true })) {
          AUTO.fleeActive = false;
          AUTO.fleeMode = null;
          AUTO.healSafeTravel = true;
          setStatus("status.heal_safe_travel", { map: formatMapLabel(dest) });
          return true;
        }
      }
      setStatus("status.flee_loop_abort");
      return false;
    }

    const currentId = getCurrentMapId();
    const reason = options.reason || "map";
    // mac42: map/HP/heal flee holds at portal on this map (no jump). Enemy may jump.
    const localPortalHeal = reason === "map" || reason === "heal";
    // On a hub: prefer portal to a known safe-base map (X-7/home), not back to O-5.
    const avoidPrev =
      NAV.recentMaps && NAV.recentMaps.length >= 2
        ? NAV.recentMaps[NAV.recentMaps.length - 2]
        : null;
    let portal = null;
    if (localPortalHeal) {
      // Nearest allied portal on THIS map for sit-and-regen (not jump-to-safe-base scoring).
      portal = findNearestFriendlyPortal({ preferSafeBase: false });
    } else if (isNavHubMap(currentId)) {
      portal = findNearestFriendlyPortal({
        preferSafeBase: true,
        avoidTargetId: avoidPrev,
      });
    }
    if (!portal) {
      portal = findNearestFriendlyPortal({
        preferSafeBase: !localPortalHeal,
        avoidTargetId: isNavHubMap(currentId) ? avoidPrev : null,
      });
    }
    if (!portal) {
      setStatus("status.flee_no_portal");
      return false;
    }

    clearCurrentTask();
    suspendCombatForFlee();
    ensureActiveConfig(AUTO.runConfig);
    AUTO.fleeActive = true;
    AUTO.fleeMode = reason;
    AUTO.raidHealMode = false;
    noteNavMapVisit(currentId);
    // Flee must not inherit play-travel arrival → that re-ran objective resume / home hops.
    NAV.playAfterArrival = false;
    ensureNavigationLoop();
    NAV.active = true;
    NAV.kind = "flee";
    NAV.path = [portal];
    // Local heal: destination is current map. Enemy flee may jump to portal.targetId.
    NAV.destinationId = localPortalHeal ? currentId : portal.targetId;
    NAV.phase = "move";
    NAV.moveStartedAt = Date.now();
    NAV.jumpStartedAt = 0;
    NAV.lastMapId = currentId;
    NAV.forHeal = localPortalHeal;
    // Clear any leftover jump latch/attempts from a prior hop — heal flee must not tryJump.
    clearPortalJumpState();
    updatePlayControls();
    if (localPortalHeal) {
      setStatus("status.flee_heal_portal", {
        dist: Math.round(portal.dist),
        map: formatMapLabel(currentId),
      });
    } else {
      const fleeWhy = "startMapFlee enemy";
      setStatus(
        `${fleeWhy} → ${portal.label || formatMapLabel(portal.targetId)} (${Math.round(portal.dist)}m)`
      );
    }
    return true;
  }

  function startRaidStageContinue() {
    if (mustHealBeforeRaidAdvance()) {
      AUTO.raidHealMode = true;
      return false;
    }

    const portal = findRaidStagePortal("next_stage");
    if (!portal) return false;

    clearCurrentTask();
    const input = getInputSystem();
    if (input) {
      input.attackMode = false;
      input.pendingAttackOnLock = null;
      clearRaidHealMovement(input);
    }
    clearLockedTarget();
    ensureActiveConfig(AUTO.roamConfig);
    ensureNavigationLoop();
    NAV.active = true;
    NAV.kind = "raid_stage";
    NAV.path = [portal];
    NAV.destinationId = "next_stage";
    NAV.phase = "move";
    NAV.moveStartedAt = Date.now();
    NAV.jumpStartedAt = 0;
    updatePlayControls();
    setStatus("Raid: avanzo allo stage successivo...");
    return true;
  }

  function driveRaidHealTick(input, ship) {
    // mac34 restore: Bastion 14 / Story 3 travel→HOLD STILL + Bastion 2 lateral return.
    // Regression (mac25+): CRITICAL_THREAT(420) + EVADE_HOLD anti-thrash made the ship
    // sit in laser range without skirting, and over-skirt travel never reached the side.
    // Working recipe: decisive flee to map side → hold still to regen → lateral return
    // (driveRaidSafeReturnTick) when HP+shield full — never chord the pack.
    if (!input || !ship) return false;
    if (!AUTO.raidHealMode && !(AUTO.fleeActive && AUTO.fleeMode === "raid")) return false;

    // Suspend cargo-clear / combat orbit retargets for the whole heal ownership window.
    if (AUTO.raidCargoClear) clearRaidCargoClearState();

    if (isPlayerFullyHealed()) {
      // Only resume when already on the turret support ring. From a heal-side edge,
      // NPCs can look "far" while the straight path still cuts the horde — use lateral return.
      if (isInsideRaidTurretSupport(ship, 0.72)) {
        clearRaidFleeState();
        if (resumeCombatAfterFlee()) {
          setStatus("Raid: curato — riprendo attacco");
        } else if (AUTO.modeAttack && AUTO.combatActive) {
          setStatus("Raid: HP/scudo 100%, riprendo attacco");
        } else {
          setStatus("Raid: nave riparata");
        }
        return false;
      }
      AUTO.raidHealMode = true;
      AUTO.fleeActive = true;
      AUTO.fleeMode = "raid";
      if (AUTO.raidHealPhase !== "return") {
        AUTO.raidHealPhase = "return";
        AUTO.raidFleeTarget = null;
        AUTO.raidFleeTargetAt = 0;
      }
      return driveRaidSafeReturnTick(input, ship);
    }

    // HP dipped again during return → back to side hold (do not keep cutting inward).
    if (AUTO.raidHealPhase === "return") {
      AUTO.raidHealPhase = "travel";
      AUTO.raidFleeTarget = null;
      AUTO.raidFleeTargetAt = 0;
      AUTO.raidHealSide = -1;
    }

    ensureActiveConfig(getRaidFleeConfig());
    input.attackMode = false;
    input.pendingAttackOnLock = null;
    clearLockedTarget();

    const snap = getPlayerHpSnapshot();
    const sh = getPlayerShieldSnapshot();
    const threatNearShip = getNearestNpcDistance(ship.x, ship.y);

    if (!AUTO.raidFleeTarget || AUTO.raidHealSide < 0) {
      assignRaidHealSide(ship);
    }

    const target = AUTO.raidFleeTarget;
    const distToTarget = target
      ? distance(ship.x, ship.y, target.x, target.y)
      : Infinity;
    const arrived = distToTarget <= RAID_HEAL_ARRIVE_DIST;

    // Story 3 / Bastion 14: once at the safe side, HOLD STILL to regenerate.
    if (arrived || AUTO.raidHealPhase === "hold") {
      AUTO.raidHealPhase = "hold";
      clearRaidHealMovement(input);

      // Bastion 19 (not Bastion 14 side-switch): close pressure → same-side lateral skirt.
      // Opposite-edge switch while low HP cut through the pack (Bastion 14 thrash).
      if (
        threatNearShip <= RAID_HEAL_HOLD_THREAT ||
        isRaidShipEncircled(ship)
      ) {
        const evade = getRaidHealEvasionWaypoint(ship);
        AUTO.raidHealPhase = "evade";
        // Escape skirt: minimap (decisive), not soft gameplay hold.
        AUTO.lastMinimapMoveAt = 0;
        AUTO.lastMinimapTarget = null;
        moveViaMinimap(evade.x, evade.y);
        setStatus(
          `Raid: NPC vicino, resto sul lato (${Math.round(threatNearShip)}m)`
        );
        return true;
      }

      setStatus(
        `Raid: riparo fermo HP ${Math.round(snap.percent)}% · scudo ${Math.round(sh.percent)}%`
      );
      return true;
    }

    // Travel to assigned side. Skirt ONLY when the straight path cuts the pack
    // (Bastion 19 always-skirt on HOLD_THREAT prevented ever arriving — regression).
    if (target && raidHealPathCrossesSwarm(ship, target)) {
      const evade = getRaidHealEvasionWaypoint(ship);
      AUTO.raidHealPhase = "evade";
      AUTO.lastMinimapMoveAt = 0;
      AUTO.lastMinimapTarget = null;
      moveViaMinimap(evade.x, evade.y);
      setStatus(
        `Raid: scarto l'orda verso lato sicuro (${Math.round(distToTarget)}m)`
      );
      return true;
    }

    if (AUTO.raidHealPhase !== "travel") {
      AUTO.raidHealPhase = "travel";
    }

    const mt = input.moveTarget;
    const needsMove =
      !mt ||
      !target ||
      distance(mt.x, mt.y, target.x, target.y) > 50 ||
      distToTarget > RAID_HEAL_ARRIVE_DIST;
    if (needsMove && target) {
      // HP flee travel: minimap escape path.
      moveViaMinimap(target.x, target.y);
    }

    setStatus(`Raid: verso lato sicuro (${Math.round(distToTarget)}m)`);
    return true;
  }

  /**
   * Cloak flag from game state and/or player sprite (client keeps cloaked players
   * in K.players — same data the minimap already draws).
   */
  function isPlayerCloaked(sessionId, player) {
    if (player?.cloaked) return true;
    const sprite = getEntities()?.playerSprites?.get(sessionId);
    return !!(sprite?.cloaked);
  }

  /**
   * Admin / staff ship in client AOI (K.players — same pool as enemy detect).
   * Prefer game flags synced from playerMeta; fall back to rank / sprite / title.
   */
  function isAdminOrStaffPlayer(player, sessionId) {
    const K = getGameState();
    if (!player || player.alive === false) return false;
    if (!sessionId || sessionId === K?.mySessionId) return false;

    if (player.is_admin || player.is_game_mod || player.is_moderator) return true;

    const rank = String(player.rank || "").toUpperCase();
    if (rank === "ADMIN" || rank === "GAME_MOD" || rank === "MODERATOR") return true;

    const sprite = getEntities()?.playerSprites?.get(sessionId);
    if (sprite?.isAdminPlayer) return true;

    const title = String(player.active_title || "").trim().toLowerCase();
    if (title === "admin" || title === "administrator") return true;

    return false;
  }

  function findNearestAdminPlayer(maxRadius) {
    const K = getGameState();
    const ship = getShipPosition();
    if (!K?.players || !ship) return null;

    let best = null;
    for (const [sessionId, player] of K.players) {
      if (!isAdminOrStaffPlayer(player, sessionId)) continue;
      const pos = getPlayerWorldPosition(sessionId, player);
      if (!pos) continue;
      const dist = distance(ship.x, ship.y, pos.x, pos.y);
      if (maxRadius && dist > maxRadius) continue;
      if (!best || dist < best.dist) {
        best = {
          sessionId,
          x: pos.x,
          y: pos.y,
          dist,
          nickname: player.nickname,
          isAdmin: !!player.is_admin,
          isGameMod: !!player.is_game_mod,
          isModerator: !!player.is_moderator,
        };
      }
    }
    if (best?.nickname) rememberAdminName(best.nickname);
    return best;
  }

  function isKnownAdminNickname(nick) {
    const name = String(nick || "").trim();
    if (!name) return false;
    if (AUTO.adminKnownNames.has(name)) return true;
    const K = getGameState();
    if (!K?.players) return false;
    for (const [sessionId, player] of K.players) {
      if (String(player?.nickname || "") !== name) continue;
      if (isAdminOrStaffPlayer(player, sessionId)) {
        rememberAdminName(name);
        return true;
      }
    }
    return false;
  }

  function resolveGameApiUrl() {
    try {
      const id = String(localStorage.getItem("rg_selected_server") || "global");
      if (GAME_API_BY_SERVER[id]) return GAME_API_BY_SERVER[id];
    } catch (_) {}
    return GAME_API_BY_SERVER.global;
  }

  async function acceptGroupInviteFromAdmin(inviterNickname, reason) {
    if (AUTO.groupInviteAcceptBusy) return false;
    const token = getGameState()?.authToken;
    if (!token) return false;
    AUTO.groupInviteAcceptBusy = true;
    AUTO.lastGroupInviteNick = String(inviterNickname || "");
    try {
      const res = await fetch(`${resolveGameApiUrl()}/social/group/accept`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      if (!res.ok) return false;
      let data = null;
      try {
        data = await res.json();
      } catch (_) {}
      if (data && data.result && data.result !== "ok") return false;
      const name = AUTO.lastGroupInviteNick || "?";
      setStatus("status.admin_invite_accepted", { name });
      sendDiscordAdminAlert(
        "group_invite",
        t("discord.admin_alert.invite", { name, reason: reason || "admin" }),
        { name }
      );
      return true;
    } catch (_) {
      return false;
    } finally {
      AUTO.groupInviteAcceptBusy = false;
    }
  }

  function handleGroupInviteReceived(payload) {
    const nick = String(payload?.inviterNickname || payload?.nickname || "").trim();
    if (nick) AUTO.lastGroupInviteNick = nick;
    const onZ = isSectorZMap();
    const fromAdmin = nick ? isKnownAdminNickname(nick) : false;
    // Sector Z: accept any invite (admin often TPs here). Else accept known admin invites.
    if (onZ || fromAdmin) {
      acceptGroupInviteFromAdmin(nick || "?", onZ ? "sector_z" : "admin");
    }
  }

  function handleSocialChatAdminEvent(data) {
    if (!data || typeof data !== "object") return;
    const type = String(data.type || "");
    const role = String(data.senderRole || data.role || "").toLowerCase();
    const sender = String(data.sender || data.nickname || data.from || "").trim();
    const isAdminRole =
      role === "admin" ||
      role === "administrator" ||
      role === "gamemod" ||
      role === "game_mod" ||
      role === "moderator";
    const known = sender ? isKnownAdminNickname(sender) : false;
    if (!isAdminRole && !known) return;
    if (sender) rememberAdminName(sender);
    const text = String(data.text || data.message || "").slice(0, 120);
    if (type === "whisper" || type === "dm" || type === "dm_in") {
      const myId = String(getGameState()?.mySessionId || "");
      // Ignore echoes we sent.
      if (data.senderId && myId && String(data.senderId) === myId) return;
      sendDiscordAdminAlert(
        "admin_whisper",
        t("discord.admin_alert.message", {
          name: sender || "?",
          kind: "whisper",
          text: text || "…",
        }),
        { name: sender }
      );
      setStatus("status.admin_message", { name: sender || "?", kind: "whisper" });
      return;
    }
    if (type === "message" || type === "chat") {
      sendDiscordAdminAlert(
        "admin_chat",
        t("discord.admin_alert.message", {
          name: sender || "?",
          kind: "chat",
          text: text || "…",
        }),
        { name: sender }
      );
      setStatus("status.admin_message", { name: sender || "?", kind: "chat" });
    }
  }

  function installSocialChatAdminHook() {
    if (AUTO.socialChatHookInstalled) return;
    AUTO.socialChatHookInstalled = true;
    const OrigWS = window.WebSocket;
    if (!OrigWS) return;
    function PatchedWebSocket(url, protocols) {
      const ws =
        protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
      try {
        if (String(url || "").includes("/social/chat")) {
          ws.addEventListener("message", (ev) => {
            try {
              const data = JSON.parse(ev.data);
              handleSocialChatAdminEvent(data);
            } catch (_) {}
          });
        }
      } catch (_) {}
      return ws;
    }
    PatchedWebSocket.prototype = OrigWS.prototype;
    try {
      Object.assign(PatchedWebSocket, OrigWS);
    } catch (_) {}
    window.WebSocket = PatchedWebSocket;
  }

  /**
   * Sector Z (JAIL): freeze farm/collect/nav objectives — hold still.
   * Still accept admin group invites; Discord alert on enter.
   */
  function processSectorZSafeHold() {
    const onZ = isSectorZMap();
    if (!onZ) {
      if (AUTO.sectorZHoldActive) {
        AUTO.sectorZHoldActive = false;
        sendDiscordAdminAlert(
          "sector_z_leave",
          t("discord.admin_alert.sector_z_leave"),
          {}
        );
        setStatus("status.sector_z_leave");
      }
      return false;
    }

    if (!AUTO.sectorZHoldActive) {
      AUTO.sectorZHoldActive = true;
      clearCurrentTask();
      pauseCombatForFlee();
      if (NAV.active && NAV.kind !== "flee" && NAV.kind !== "coffee") {
        stopNavigation();
      }
      const admin = findNearestAdminPlayer(FLEE_ENEMY_DETECT_RADIUS);
      const name = admin?.nickname || AUTO.adminPauseName || "";
      if (name) AUTO.adminPauseName = name;
      setStatus("status.sector_z_hold", { name: name || "?" });
      sendDiscordAdminAlert(
        "sector_z",
        t("discord.admin_alert.sector_z", { name: name || "?" }),
        { name }
      );
    }

    const input = getInputSystem();
    if (input) {
      input.clearMoveTarget?.();
      input.moveTarget = null;
      input.attackMode = false;
      input.pendingAttackOnLock = null;
    }
    AUTO.lastMinimapTarget = null;
    clearLockedTarget();
    const admin = findNearestAdminPlayer(FLEE_ENEMY_DETECT_RADIUS);
    if (admin?.nickname) {
      AUTO.adminPauseName = admin.nickname;
      setStatus("status.sector_z_hold", { name: admin.nickname });
    } else {
      setStatus("status.sector_z_hold", { name: AUTO.adminPauseName || "?" });
    }
    return true;
  }

  function shouldPauseForAdmin() {
    if (!AUTO.pauseOnAdmin || !AUTO.active || AUTO.paused) return false;
    if (AUTO.adminPauseLatched) return false;
    if (AUTO.adminPauseCooldownUntil && Date.now() < AUTO.adminPauseCooldownUntil) return false;
    if (AUTO.coffeeBreakActive || NAV.kind === "coffee") return false;
    if (AUTO.coffeeBreakUntil && Date.now() < AUTO.coffeeBreakUntil) return false;
    if (isRaidHealActive() || AUTO.fleeActive || AUTO.postDeathRecover) return false;
    if (NAV.active) return false;
    if (AUTO.portalWaitUntil && Date.now() < AUTO.portalWaitUntil) return false;
    if (isSectorZMap()) return false;
    return !!findNearestAdminPlayer(FLEE_ENEMY_DETECT_RADIUS);
  }

  function startAdminPauseNavigation() {
    if (!shouldPauseForAdmin()) return false;
    const admin = findNearestAdminPlayer(FLEE_ENEMY_DETECT_RADIUS);
    if (!admin) return false;

    AUTO.adminPauseLatched = true;
    AUTO.adminPauseName = admin.nickname || "?";
    rememberAdminName(AUTO.adminPauseName);
    setStatus("status.admin_detected", { name: AUTO.adminPauseName });
    sendDiscordAdminAlert(
      "admin_detected",
      t("discord.admin_alert.detected", { name: AUTO.adminPauseName }),
      { name: AUTO.adminPauseName }
    );

    const ok = startCoffeeBreakNavigation({
      reason: "admin",
      adminName: AUTO.adminPauseName,
    });
    if (!ok) {
      AUTO.adminPauseLatched = false;
      AUTO.portalHoldReason = null;
      AUTO.adminPauseName = "";
      AUTO.adminPauseCooldownUntil = Date.now() + 8000;
      setStatus("status.admin_no_portal");
      sendDiscordAdminAlert(
        "admin_no_portal",
        t("discord.admin_alert.no_portal", { name: admin.nickname || "?" }),
        { name: admin.nickname || "" }
      );
    }
    return ok;
  }

  /**
   * Faction/clan hostility only. Cloaked hostiles are included by default so
   * flee-from-enemies matches minimap awareness (no fake radar — AOI only).
   */
  function isHostilePlayer(player, sessionId, options = {}) {
    const K = getGameState();
    if (!player || player.alive === false) return false;
    if (!sessionId || sessionId === K?.mySessionId) return false;
    // includeCloaked defaults true: cloaked ships remain in client AOI/minimap.
    if (options.includeCloaked === false && isPlayerCloaked(sessionId, player)) return false;
    if (player.nickname && K?.groupMemberNicknames?.has(player.nickname)) return false;

    const myFaction = String(K?.myFaction || getLocalPlayer()?.faction || "").toUpperCase();
    const playerFaction = String(player.faction || "").toUpperCase();
    if (!myFaction || !playerFaction) return false;
    if (playerFaction !== myFaction) return true;
    if (player.clan_tag && K?.clanDiplomacy?.get(player.clan_tag) === "war") return true;
    return false;
  }

  function getPlayerWorldPosition(sessionId, player) {
    const sprite = getEntities()?.playerSprites?.get(sessionId);
    if (sprite?.interp?.x != null && sprite.interp?.y != null) {
      return { x: sprite.interp.x, y: sprite.interp.y };
    }
    if (sprite?.x != null && sprite?.y != null) {
      return { x: sprite.x, y: sprite.y };
    }
    if (player?.x != null && player?.y != null) {
      return { x: player.x, y: player.y };
    }
    return null;
  }

  function findNearestHostilePlayer(maxRadius, options = {}) {
    const K = getGameState();
    const ship = getShipPosition();
    if (!K?.players || !ship) return null;

    let best = null;
    for (const [sessionId, player] of K.players) {
      if (!isHostilePlayer(player, sessionId, options)) continue;
      const pos = getPlayerWorldPosition(sessionId, player);
      if (!pos) continue;
      const dist = distance(ship.x, ship.y, pos.x, pos.y);
      if (maxRadius && dist > maxRadius) continue;
      const cloaked = isPlayerCloaked(sessionId, player);
      if (!best || dist < best.dist) {
        best = {
          sessionId,
          x: pos.x,
          y: pos.y,
          dist,
          nickname: player.nickname,
          faction: player.faction,
          cloaked,
        };
      }
    }
    return best;
  }

  function shouldFleeFromEnemyPlayers() {
    if (!AUTO.fleeEnemyPlayers || !AUTO.active || AUTO.paused) return false;
    if (isInRaidMap()) return false;
    const player = getLocalPlayer();
    if (player?.in_safe_zone) return false;
    return !!findNearestHostilePlayer(FLEE_ENEMY_DETECT_RADIUS);
  }

  /**
   * Surface cloaked hostiles in the status line (same AOI/minimap data — not a wallhack).
   * Throttled so it does not spam while farming.
   */
  function maybeNoticeCloakedHostile() {
    if (!AUTO.fleeEnemyPlayers || !AUTO.active || AUTO.paused) return;
    if (AUTO.fleeActive || isInRaidMap()) return;
    const player = getLocalPlayer();
    if (player?.in_safe_zone) return;
    if (AUTO.lastCloakHostileNoticeAt && Date.now() - AUTO.lastCloakHostileNoticeAt < 8000) return;

    const enemy = findNearestHostilePlayer(FLEE_ENEMY_DETECT_RADIUS);
    if (!enemy?.cloaked) return;
    AUTO.lastCloakHostileNoticeAt = Date.now();
    setStatus("status.cloak_hostile_near", {
      name: enemy.nickname || enemy.faction || "?",
      dist: Math.round(enemy.dist),
    });
  }

  /**
   * Continuously track HP/shield drops whenever PvP flee/SAP features are armed,
   * so a cloak-reveal shot is not lost when flee starts one tick later.
   */
  function updatePvpFleeHitTracker() {
    if (!(AUTO.fleeEnemyPlayers || AUTO.fleeUseSap || (AUTO.fleeActive && AUTO.fleeMode === "enemy"))) {
      return;
    }
    if (!AUTO.active || AUTO.paused) return;
    const hp = getPlayerHpSnapshot();
    const shield = getPlayerShieldSnapshot();
    const effective = (Number(hp.effective) || 0) + (Number(shield.current) || 0);
    const prev = AUTO.pvpFleeLastCombatEffective;
    AUTO.pvpFleeLastCombatEffective = effective;
    if (prev == null) return;
    if (effective < prev - 0.5) {
      AUTO.pvpFleeHitAt = Date.now();
    }
  }

  function seedPvpFleeUnderFire() {
    AUTO.pvpFleeHitAt = Date.now();
    // Keep baseline in sync so the next real drop still registers.
    const hp = getPlayerHpSnapshot();
    const shield = getPlayerShieldSnapshot();
    AUTO.pvpFleeLastCombatEffective =
      (Number(hp.effective) || 0) + (Number(shield.current) || 0);
    return true;
  }

  function playerLooksAttackingLocal(sessionId) {
    const K = getGameState();
    if (!K?.mySessionId || !sessionId) return false;

    const player = K.players?.get?.(sessionId);
    if (player?.is_attacking && player.attack_target_id === K.mySessionId) return true;

    const sprite = getEntities()?.playerSprites?.get(sessionId);
    if (sprite) {
      const targetId =
        sprite.attack_target_id ?? sprite.attackTargetId ?? sprite.lockTargetId ?? null;
      if (
        (sprite.is_attacking || sprite.attackMode || sprite.attacking) &&
        targetId === K.mySessionId
      ) {
        return true;
      }
    }
    return false;
  }

  function startEnemyPlayerFlee(options = {}) {
    const enemy = findNearestHostilePlayer(FLEE_ENEMY_DETECT_RADIUS);
    if (!enemy) return false;

    // Capture under-fire evidence BEFORE flee suspends combat / resets baselines.
    updatePvpFleeHitTracker();
    const recentHit =
      AUTO.pvpFleeHitAt && Date.now() - AUTO.pvpFleeHitAt < PVP_FLEE_HIT_WINDOW_MS;
    const attacking = playerLooksAttackingLocal(enemy.sessionId);

    if (startMapFlee({ reason: "enemy" })) {
      // Do NOT wipe hit tracker (old bug: reset erased the reveal-shot that triggered flee).
      // Seed SAP under-fire when pursuer is shooting, we just took damage, or HP-flee
      // raced ahead of the enemy-flee path (typical cloak-reveal volley).
      if (attacking || recentHit || options.fromHp) {
        seedPvpFleeUnderFire();
      }
      tryCloakForPvpFlee();
      const label = enemy.nickname || enemy.faction || "nemico";
      if (enemy.cloaked) {
        setStatus("status.flee_enemy_cloak", {
          name: label,
          dist: Math.round(enemy.dist),
        });
      } else {
        setStatus("status.flee_enemy", {
          name: label,
          dist: Math.round(enemy.dist),
        });
      }
      return true;
    }
    return false;
  }

  function canUseCloakNow() {
    const player = getLocalPlayer();
    if (!player || player.cloaked) return false;
    if ((Number(player.cloak_ammo) || 0) <= 0) return false;
    if (AUTO.lastCloakAt && Date.now() - AUTO.lastCloakAt < CLOAK_COOLDOWN_MS) return false;
    return typeof window.__RG_NET__?.sendUseCloak === "function";
  }

  function tryCloakForPvpFlee() {
    if (!AUTO.fleeUseCloak || !canUseCloakNow()) return false;
    try {
      const input = getInputSystem();
      if (input) {
        input.attackMode = false;
        input.pendingAttackOnLock = null;
      }
      clearLockedTarget();
      window.__RG_NET__.sendUseCloak();
      AUTO.lastCloakAt = Date.now();
      setStatus("status.cloak_flee");
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * True when this hostile player is actively shooting/hitting the local ship.
   * Uses is_attacking toward local, sprite attack flags, and recent HP/shield drops.
   */
  function isHostilePlayerFiringAtLocal(sessionId) {
    if (playerLooksAttackingLocal(sessionId)) return true;

    updatePvpFleeHitTracker();
    if (AUTO.pvpFleeHitAt && Date.now() - AUTO.pvpFleeHitAt < PVP_FLEE_HIT_WINDOW_MS) {
      return true;
    }
    return false;
  }

  /**
   * While fleeing hostile players: fire SAP at the chaser for shield regen help,
   * but ONLY when that pursuer is actually shooting/hitting us.
   * If not under fire: flee fast and silently (no SAP, no lock spam).
   * CRITICAL: never clear/redirect moveTarget or NAV flee path — ammo + lock only.
   */
  function trySapShieldDuringPvpFlee() {
    if (!AUTO.fleeUseSap) return false;
    if (!AUTO.fleeActive || NAV.kind !== "flee" || !NAV.active) return false;
    // Prefer enemy-mode flee; also allow map/heal flee if a hostile is shooting us
    // (HP-threshold flee often wins the race when a cloak reveal drops HP).
    if (AUTO.fleeMode !== "enemy" && AUTO.fleeMode !== "map" && AUTO.fleeMode !== "heal") {
      return false;
    }
    if (getPlayerAmmoCount("SAP") <= 0) return false;

    const enemy = findNearestHostilePlayer(FLEE_ENEMY_DETECT_RADIUS);
    if (!enemy) return false;
    // Map/heal flee: only engage SAP when flee-from-enemies is armed (PvP context).
    if (AUTO.fleeMode !== "enemy" && !AUTO.fleeEnemyPlayers) return false;

    updatePvpFleeHitTracker();
    if (!isHostilePlayerFiringAtLocal(enemy.sessionId)) {
      // Silent flee — drop any SAP lock/attack we may have started earlier.
      const inputQuiet = getInputSystem();
      const KQuiet = getGameState();
      if (inputQuiet) {
        inputQuiet.attackMode = false;
        inputQuiet.pendingAttackOnLock = null;
      }
      if (KQuiet?.lockedTargetId === enemy.sessionId) {
        clearLockedTarget();
      }
      return false;
    }

    // Promote map/heal flee to enemy mode so resume/cleanup stay on the PvP path.
    if (AUTO.fleeMode !== "enemy") {
      AUTO.fleeMode = "enemy";
    }

    const net = window.__RG_NET__;
    const K = getGameState();
    const input = getInputSystem();
    if (!net || !K || !input) return false;

    // Preserve current flee waypoint — do not touch input.moveTarget / NAV.path.
    const savedMove = input.moveTarget ? { ...input.moveTarget } : null;

    if (getActiveAmmoType() !== "SAP") {
      switchCombatAmmo("SAP");
    }

    if (K.lockedTargetId !== enemy.sessionId) {
      K.lockedTargetId = enemy.sessionId;
      K.lockTargetOwnedByOther = false;
      K.lockOwnerExpiresAt = 0;
      try {
        net.sendLockTarget?.(enemy.sessionId, "player");
      } catch (_) {}
      input.pendingAttackOnLock = enemy.sessionId;
      AUTO.lastFleeSapAt = Date.now();
    } else {
      input.attackMode = true;
      if (input.sentAttackTarget !== enemy.sessionId) {
        try {
          net.sendAttackStart?.({ targetId: enemy.sessionId, autoRocket: false });
          input.sentAttackTarget = enemy.sessionId;
        } catch (_) {}
      }
      AUTO.lastFleeSapAt = Date.now();
    }

    // Restore flee destination if anything above clobbered movement.
    if (savedMove && input.moveTarget !== savedMove) {
      const portal = NAV.path?.[0];
      if (portal) setMoveTargetDirect(input, portal.x, portal.y);
      else if (savedMove.x != null) setMoveTargetDirect(input, savedMove.x, savedMove.y);
    }
    return true;
  }

  function maybeAutoBuyBootyKey() {
    if (!AUTO.autoBuyBootyKeys || !AUTO.collectBooty) return false;
    if (!AUTO.active || AUTO.paused) return false;
    if (!isInSafeZone()) return false;
    if (getBootyKeyCount() > 0) {
      AUTO.bootyKeysBlocked = false;
      return false;
    }
    if (AUTO.bootyKeyBuyPending) return false;
    if ((AUTO.bootyKeyBuysThisSession || 0) >= BOOTY_KEY_BUY_SESSION_MAX) return false;
    if (AUTO.lastBootyKeyBuyAt && Date.now() - AUTO.lastBootyKeyBuyAt < BOOTY_KEY_BUY_COOLDOWN_MS) {
      return false;
    }
    const net = window.__RG_NET__;
    if (typeof net?.sendBuyBootyKey !== "function") return false;
    try {
      net.sendBuyBootyKey(1);
      AUTO.bootyKeyBuyPending = true;
      AUTO.lastBootyKeyBuyAt = Date.now();
      AUTO.bootyKeyBuysThisSession = (AUTO.bootyKeyBuysThisSession || 0) + 1;
      setStatus("status.booty_key_buy");
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Compact status when idle/waiting/traveling — real reason why the ship is still.
   * Returns true if a status was applied.
   */
  function explainIdleReason() {
    if (AUTO.postDeathRecover || AUTO.healSafeTravel) {
      if (AUTO.healSafeTravel || (!isInRaidMap() && !isHealHoldInPlace() && !isPlayerFullyHealed())) {
        setStatus("status.idle_heal_safe");
      } else {
        setStatus("status.idle_heal");
      }
      return true;
    }
    if (AUTO.fleeActive || AUTO.combatSuspendedForFlee) {
      setStatus("status.idle_flee");
      return true;
    }
    if (AUTO.pendingCombatCargo && canCollectCargoNow()) {
      clearPhantomPendingCargoBlockingCombat();
      // Mid-fight or phantom living kill: never show "Attendo cargo" / freeze.
      if (
        !AUTO.pendingCombatCargo ||
        hasLivingStickyCombat() ||
        isNpcStillFightable(AUTO.pendingCombatCargo.npcId) ||
        getNpcSprite(AUTO.pendingCombatCargo.npcId)?.alive
      ) {
        /* fall through */
      } else {
        setStatus("status.cargo_wait");
        return true;
      }
    }
    if (
      AUTO.collectBooty &&
      !AUTO.autoBuyBootyKeys &&
      (AUTO.bootyKeysBlocked || getBootyKeyCount() <= 0)
    ) {
      setStatus("status.idle_no_booty_keys");
      return true;
    }
    if (AUTO.combatActive && AUTO.modeAttack) {
      const labels = [...(AUTO.combatTargetTypes || [])].map(getNpcTypeLabel).join(", ");
      setStatus(labels ? "status.idle_no_npc" : "status.idle_explore", {
        types: labels,
      });
      return true;
    }
    if (hasAnyCollectMode()) {
      setStatus("status.idle_explore_loot");
      return true;
    }
    return false;
  }

  function processSecurityGates() {
    checkPlayerDeathState();
    scanWatchedNpcKills();
    pruneForeignNpcIds();

    if (AUTO.deathLimit > 0 && AUTO.deathCount >= AUTO.deathLimit) {
      if (AUTO.active) {
        stopPlay();
        setStatus(`Stop: limite morti (${AUTO.deathLimit}) raggiunto`);
      }
      return true;
    }

    // Sector Z (admin map): freeze all objectives — hold/safe mode.
    if (AUTO.active && !AUTO.paused && processSectorZSafeHold()) return true;

    // Post-death / pre-Play: stay still until configs are full HP+shield — blocks flee/wander.
    // HARD RULE: cold portal post-kill heal NEVER starves cargo — if scoop window is open,
    // defer recover so mainTick can drivePendingCombatCargoTick / collect first.
    if (AUTO.postDeathRecover) {
      if (shouldDeferHealForPostKillCargo()) {
        // Keep postDeathRecover armed — resume AFTER cargo collected / full WAIT_MS.
        AUTO.healSafeTravel = false;
      } else {
        return drivePostDeathRecoverTick();
      }
    }

    // Standalone base wait (legacy path; post-death now arms this inside pre-objective heal).
    if (AUTO.baseWaitUntil && Date.now() < AUTO.baseWaitUntil) {
      const input = getInputSystem();
      if (!maybeDriveSafeZoneMicroFidget(input)) {
        if (input) {
          input.clearMoveTarget?.();
          input.moveTarget = null;
        }
      }
      setStatus("status.base_wait", {
        sec: Math.ceil((AUTO.baseWaitUntil - Date.now()) / 1000),
        rolled: AUTO.lastRolledWaitSec || 0,
      });
      return true;
    }
    if (AUTO.baseWaitUntil) {
      AUTO.baseWaitUntil = 0;
      clearSafeZoneMicroFidget();
      if (AUTO.resumeTravelAfterBaseWait) {
        AUTO.resumeTravelAfterBaseWait = false;
        maybeResumeObjectiveAfterDeath();
      }
    }

    if (holdForPortalWait()) return true;

    if (AUTO.coffeeBreakUntil && Date.now() < AUTO.coffeeBreakUntil) {
      const input = getInputSystem();
      if (input) {
        input.clearMoveTarget?.();
        input.moveTarget = null;
        input.attackMode = false;
        input.pendingAttackOnLock = null;
      }
      AUTO.lastMinimapTarget = null;
      if (AUTO.portalHoldReason === "admin") {
        setStatus("status.admin_pause", {
          time: formatCountdownSec(secondsUntil(AUTO.coffeeBreakUntil)),
        });
      } else {
        setStatus("status.coffee_pause", {
          time: formatCountdownSec(secondsUntil(AUTO.coffeeBreakUntil)),
        });
      }
      maybeDiscordNotifyPortalHoldTick();
      return true;
    }
    if (AUTO.coffeeBreakUntil && Date.now() >= AUTO.coffeeBreakUntil) {
      finishCoffeeBreak();
    }
    if (tryCoffeeReloginTick()) return true;

    if (AUTO.active && AUTO.sessionLimitMin > 0 && AUTO.sessionStartedAt > 0) {
      const remaining = getSessionRemainingMin();
      if (remaining !== null && remaining <= 0) {
        setStatus("status.session_stop", { min: AUTO.sessionLimitMin });
        stopPlay();
        return true;
      }
    }

    if (
      AUTO.active &&
      !AUTO.paused &&
      AUTO.coffeeBreakIntervalMin > 0 &&
      !AUTO.coffeeBreakActive &&
      !NAV.active &&
      !isRaidHealActive() &&
      !AUTO.fleeActive &&
      !(AUTO.portalWaitUntil && Date.now() < AUTO.portalWaitUntil) &&
      AUTO.nextCoffeeBreakAt > 0 &&
      Date.now() >= AUTO.nextCoffeeBreakAt
    ) {
      startCoffeeBreakNavigation({ reason: "coffee" });
    }

    // Admin/staff in AOI → same portal hold as coffee (duration = coffee setting).
    // Checked after scheduled coffee start so an in-progress coffee hold is not double-armed;
    // if coffee did not start (interval off / busy), admin can still claim the tick.
    if (shouldPauseForAdmin()) {
      startAdminPauseNavigation();
    }

    // Keep PvP hit baseline warm so cloak-reveal damage is visible when flee starts.
    updatePvpFleeHitTracker();
    maybeNoticeCloakedHostile();

    if (shouldFleeByHp()) {
      // Heal travel already owns the route to a safe zone — do not HP-flee mid-path
      // (interrupting SX hops and bouncing back to O-5 caused the infinite loop).
      if (!AUTO.fleeActive && !AUTO.raidHealMode && !isHealSafeTravelActive()) {
        if (isInRaidMap()) {
          // Story 3 heal flee: leave combat, travel to a safe map side, hold to regen.
          // Do NOT keep orbiting/fighting with runConfig — that looked like "config changed but stayed".
          AUTO.raidHealMode = true;
          AUTO.fleeActive = true;
          AUTO.fleeMode = "raid";
          AUTO.raidFleeTarget = null;
          AUTO.raidHealSide = -1;
          AUTO.raidHealPhase = null;
          suspendCombatForFlee();
        } else if (
          AUTO.fleeEnemyPlayers &&
          !isPostArrivalSecurityGraceActive() &&
          findNearestHostilePlayer(FLEE_ENEMY_DETECT_RADIUS)
        ) {
          // HP drop from a PvP attacker (e.g. cloak reveal) must use enemy flee so SAP-on-flee can arm.
          startEnemyPlayerFlee({ fromHp: true });
        } else {
          startMapFlee();
        }
      }
    } else if (
      AUTO.fleeEnemyPlayers &&
      !isPostArrivalSecurityGraceActive() &&
      shouldFleeFromEnemyPlayers()
    ) {
      if (!AUTO.fleeActive && !AUTO.raidHealMode && !NAV.active) {
        startEnemyPlayerFlee();
      }
    } else if (AUTO.fleeActive && AUTO.fleeMode === "enemy" && !NAV.active) {
      AUTO.fleeActive = false;
      AUTO.fleeMode = null;
      resumeCombatAfterFlee();
    } else if (AUTO.fleeActive && (AUTO.fleeMode === "map" || AUTO.fleeMode === "heal") && !NAV.active) {
      AUTO.fleeActive = false;
      AUTO.fleeMode = null;
      // Map/heal flee: full heal (safe zone) before combat — do not leave early.
      if (!AUTO.postDeathRecover) beginPreObjectiveHeal({ armBaseWait: false });
    } else if (
      AUTO.active &&
      !shouldFleeByHp() &&
      !AUTO.fleeActive &&
      !isRaidHealActive() &&
      !NAV.active &&
      !AUTO.postDeathRecover
    ) {
      resumeCombatAfterFlee();
    }

    return false;
  }

  function processSecurityMovement(input, ship) {
    if (!AUTO.active || !input || !ship) return false;
    if (isRaidHealActive()) return driveRaidHealTick(input, ship);
    return false;
  }

  function maybeStopOnRaidGateComplete(reason = "complete") {
    if (!AUTO.active) return false;
    const K = getGameState();
    const explicit =
      reason === "exit" ||
      reason === "last_stage" ||
      Boolean(K?.raidIsLastStage && K?.raidStageClear);
    if (!explicit) return false;
    stopNavigation();
    stopPlay();
    setStatus("Raid completato — bot fermato");
    return true;
  }

  function driveRaidAutomation(input, ship) {
    const K = getGameState();
    if (!isInRaidMap() || !K) return false;

    if (driveRaidHealTick(input, ship)) return true;

    if (!K.raidStageClear) {
      AUTO.raidStageClearCargoUntil = 0;
      AUTO.raidStageClearCargoStartedAt = 0;
      return false;
    }

    // Stage clear: scoop post-kill cargo before portal / stop (time-boxed).
    // Does not change mid-fight combat/orbit — only delays the next-stage jump.
    if (maybeDriveRaidStageClearCargo(input, ship)) return true;

    // Entire gate finished (last stage) → stop Play
    if (K.raidIsLastStage) {
      maybeStopOnRaidGateComplete("last_stage");
      return true;
    }

    if (mustHealBeforeRaidAdvance()) {
      if (!AUTO.raidHealMode) {
        AUTO.raidHealMode = true;
        AUTO.raidFleeTarget = null;
        AUTO.raidHealSide = -1;
        AUTO.raidHealPhase = null;
      }
      return driveRaidHealTick(input, ship);
    }

    clearRaidFleeStateIfRecovered();

    if (!NAV.active) {
      return startRaidStageContinue();
    }

    return NAV.kind === "raid_stage";
  }

  /**
   * After raidStageClear, collect remaining own cargo before next portal.
   * Soft-extends while visible allowed cargo remains (or until hold full / hard cap).
   * Must actually drive collect/sweep — never return true while sitting idle.
   */
  function maybeDriveRaidStageClearCargo(input, ship) {
    if (!AUTO.collectCargo || !canCollectCargoNow()) return false;
    if (!input || !ship) return false;

    if (!AUTO.raidStageClearCargoUntil) {
      AUTO.raidStageClearCargoStartedAt = Date.now();
      AUTO.raidStageClearCargoUntil = Date.now() + RAID_STAGE_CLEAR_CARGO_MS;
    }

    // Contact scoop first — never sit on leftover loot during stage clear.
    if (tryContactRaidCargoScoop(input, ship, AUTO.raidCargoClear)) return true;

    const leftoverProbe = findRaidStageClearCargo(ship);
    if (Date.now() > AUTO.raidStageClearCargoUntil) {
      // Soft-extend while allowed cargo still visible — do not leave after partial scoop.
      if (leftoverProbe && canCollectCargoNow()) {
        const started = AUTO.raidStageClearCargoStartedAt || Date.now();
        if (Date.now() - started < RAID_STAGE_CLEAR_CARGO_MAX_MS) {
          AUTO.raidStageClearCargoUntil =
            Date.now() + RAID_STAGE_CLEAR_CARGO_EXTEND_MS;
        } else {
          // Hard cap: stuck loot cannot block the gate forever.
          if (AUTO.pendingCombatCargo) {
            finishCombatCargoCollect(
              AUTO.cargoCollectInFlightId ||
                AUTO.taskTargetId ||
                AUTO.pendingCollectId,
              { count: false }
            );
          }
          return false;
        }
      } else {
        if (AUTO.pendingCombatCargo) {
          finishCombatCargoCollect(
            AUTO.cargoCollectInFlightId || AUTO.taskTargetId || AUTO.pendingCollectId,
            { count: false }
          );
        }
        return false;
      }
    }

    // Clear→scoop FSM (also handles surround breakout).
    if (driveRaidCargoSweepTick(input, ship)) return true;

    // Active post-kill lifecycle
    if (AUTO.pendingCombatCargo || AUTO.cargoCollectInFlightId) {
      if (drivePendingCombatCargoTick(input, ship)) return true;
    }

    if (AUTO.currentTask === "collect") {
      const item = getCollectibleById(AUTO.taskTargetId);
      if (item) {
        driveCollect(item);
        return true;
      }
      // Sprite flicker but loot still in state — keep native path alive.
      const lootId = AUTO.taskTargetId;
      if (lootId && getGameState()?.loots?.has?.(lootId)) {
        armNativeCollect(lootId);
        return true;
      }
    }

    // Leftover cargo still on the ground after the last kill (pending may have been cleared)
    const leftover = leftoverProbe || findRaidStageClearCargo(ship);
    if (leftover) {
      // Already on it → instant scoop (more aggressive than mid-fight opp scoop).
      if (isRaidCargoInContactRange(leftover, ship)) {
        return tryContactRaidCargoScoop(input, ship, AUTO.raidCargoClear);
      }
      if (isRaidCargoApproachUnsafe(leftover, ship) || isRaidShipThreatenedForCargo(ship)) {
        armRaidCargoClear(leftover);
        return driveRaidCargoClearMovement(input, ship, AUTO.raidCargoClear);
      }
      if (
        AUTO.raidCargoClear?.scoopCooldownUntil &&
        Date.now() < AUTO.raidCargoClear.scoopCooldownUntil &&
        !isRaidCargoInContactRange(leftover, ship)
      ) {
        armRaidCargoClear(leftover);
        return driveRaidCargoClearMovement(input, ship, AUTO.raidCargoClear);
      }
      return beginRaidCargoScoop(leftover, ship);
    }

    return false;
  }

  function findRaidStageClearCargo(ship) {
    return findNearestRaidVisibleCargo(ship);
  }

  function syncSecurityPanelFromAuto() {
    const deathCountEl = document.getElementById("rg-sec-death-count");
    if (deathCountEl) deathCountEl.textContent = String(AUTO.deathCount);

    const sessionRemainingEl = document.getElementById("rg-sec-session-remaining");
    if (sessionRemainingEl) {
      if (AUTO.securityEditing === "rg-sec-session-limit" || !AUTO.sessionLimitMin || !AUTO.sessionStartedAt) {
        sessionRemainingEl.textContent = AUTO.sessionLimitMin > 0 ? "—" : "off";
      } else {
        const leftSec = secondsUntil(AUTO.sessionStartedAt + AUTO.sessionLimitMin * 60000);
        sessionRemainingEl.textContent =
          leftSec > 0 ? formatCountdownSec(leftSec) : formatDurationMinutes(getSessionRemainingMin());
      }
    }

    const coffeeStatusEl = document.getElementById("rg-sec-coffee-status");
    if (coffeeStatusEl) {
      if (AUTO.coffeeBreakUntil && Date.now() < AUTO.coffeeBreakUntil) {
        const pauseKey =
          AUTO.portalHoldReason === "admin" ? "ui.sec.admin_pause_left" : "ui.sec.coffee_pause_left";
        coffeeStatusEl.textContent = t(pauseKey, {
          time: formatCountdownSec(secondsUntil(AUTO.coffeeBreakUntil)),
        });
      } else if (AUTO.coffeeBreakIntervalMin > 0 && AUTO.nextCoffeeBreakAt > AUTO.sessionStartedAt) {
        const left = secondsUntil(AUTO.nextCoffeeBreakAt);
        coffeeStatusEl.textContent = t("ui.sec.coffee_next_left", {
          time: formatCountdownSec(left),
        });
      } else {
        coffeeStatusEl.textContent = AUTO.coffeeBreakIntervalMin > 0 ? t("ui.sec.coffee_scheduled") : "off";
      }
    }

    const portalCd = document.getElementById("rg-sec-portal-countdown");
    if (portalCd) {
      const sec = secondsUntil(AUTO.portalWaitUntil);
      if (sec > 0) {
        portalCd.hidden = false;
        portalCd.textContent = formatCountdownSec(sec);
      } else {
        portalCd.hidden = true;
        portalCd.textContent = "";
      }
    }

    const baseCd = document.getElementById("rg-sec-base-countdown");
    if (baseCd) {
      const sec = secondsUntil(AUTO.baseWaitUntil);
      if (sec > 0) {
        baseCd.hidden = false;
        baseCd.textContent = formatCountdownSec(sec);
      } else {
        baseCd.hidden = true;
        baseCd.textContent = "";
      }
    }

    document.getElementById("rg-sec-flee-enemies")?.classList.toggle("selected", AUTO.fleeEnemyPlayers);
    document.getElementById("rg-sec-flee-cloak")?.classList.toggle("selected", AUTO.fleeUseCloak);
    document.getElementById("rg-sec-flee-sap")?.classList.toggle("selected", AUTO.fleeUseSap);
    document.getElementById("rg-sec-pause-admin")?.classList.toggle("selected", AUTO.pauseOnAdmin);
    document.getElementById("rg-sec-auto-booty-key")?.classList.toggle("selected", AUTO.autoBuyBootyKeys);
    syncTimerCountdownUi();
  }

  function initSecurityPanelValues() {
    const portalEl = document.getElementById("rg-sec-portal-wait");
    const baseEl = document.getElementById("rg-sec-base-wait");
    const deathEl = document.getElementById("rg-sec-death-limit");
    const fleeEl = document.getElementById("rg-sec-flee-hp");
    const fleeEnemyEl = document.getElementById("rg-sec-flee-enemies");
    const fleeCloakEl = document.getElementById("rg-sec-flee-cloak");
    const fleeSapEl = document.getElementById("rg-sec-flee-sap");
    const pauseAdminEl = document.getElementById("rg-sec-pause-admin");
    const autoBootyEl = document.getElementById("rg-sec-auto-booty-key");
    const sessionEl = document.getElementById("rg-sec-session-limit");
    const coffeeIntervalEl = document.getElementById("rg-sec-coffee-interval");
    const coffeeDurationEl = document.getElementById("rg-sec-coffee-duration");
    const coffeeToleranceEl = document.getElementById("rg-sec-coffee-tolerance");
    if (portalEl) portalEl.value = String(AUTO.portalWaitSec);
    if (baseEl) baseEl.value = String(AUTO.baseWaitSec);
    if (deathEl) deathEl.value = String(AUTO.deathLimit);
    if (fleeEl) fleeEl.value = String(AUTO.fleeHpPercent);
    if (fleeEnemyEl) fleeEnemyEl.classList.toggle("selected", AUTO.fleeEnemyPlayers);
    if (fleeCloakEl) fleeCloakEl.classList.toggle("selected", AUTO.fleeUseCloak);
    if (fleeSapEl) fleeSapEl.classList.toggle("selected", AUTO.fleeUseSap);
    if (pauseAdminEl) pauseAdminEl.classList.toggle("selected", AUTO.pauseOnAdmin);
    if (autoBootyEl) autoBootyEl.classList.toggle("selected", AUTO.autoBuyBootyKeys);
    if (sessionEl) sessionEl.value = String(AUTO.sessionLimitMin);
    if (coffeeIntervalEl) coffeeIntervalEl.value = String(AUTO.coffeeBreakIntervalMin);
    if (coffeeDurationEl) coffeeDurationEl.value = String(AUTO.coffeeBreakDurationMin);
    if (coffeeToleranceEl) coffeeToleranceEl.value = String(AUTO.coffeeBreakToleranceMin);
  }

  function bindSecurityNumberInput(id, applyValue, min, max) {
    const el = document.getElementById(id);
    if (!el) return;
    bindPanelFormInput(el);
    el.addEventListener("focus", () => {
      AUTO.securityEditing = id;
    });

    el.addEventListener("input", () => {
      const raw = el.value.replace(/[^\d]/g, "");
      if (raw !== el.value) el.value = raw;
      if (raw === "") return;
      applyValue(clamp(Number(raw) || 0, min, max));
    });

    el.addEventListener("blur", () => {
      AUTO.securityEditing = null;
      const value = clamp(Number(el.value) || 0, min, max);
      applyValue(value);
      el.value = String(value);
    });

    el.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") el.blur();
    });
  }

  function toggleFleeEnemyPlayers() {
    AUTO.fleeEnemyPlayers = !AUTO.fleeEnemyPlayers;
    document.getElementById("rg-sec-flee-enemies")?.classList.toggle("selected", AUTO.fleeEnemyPlayers);
    setStatus(AUTO.fleeEnemyPlayers ? "status.flee_enemies_on" : "status.flee_enemies_off");
  }

  function toggleFleeUseCloak() {
    AUTO.fleeUseCloak = !AUTO.fleeUseCloak;
    document.getElementById("rg-sec-flee-cloak")?.classList.toggle("selected", AUTO.fleeUseCloak);
    setStatus(AUTO.fleeUseCloak ? "status.flee_cloak_on" : "status.flee_cloak_off");
  }

  function toggleFleeUseSap() {
    AUTO.fleeUseSap = !AUTO.fleeUseSap;
    document.getElementById("rg-sec-flee-sap")?.classList.toggle("selected", AUTO.fleeUseSap);
    setStatus(AUTO.fleeUseSap ? "status.flee_sap_on" : "status.flee_sap_off");
  }

  function togglePauseOnAdmin() {
    AUTO.pauseOnAdmin = !AUTO.pauseOnAdmin;
    document.getElementById("rg-sec-pause-admin")?.classList.toggle("selected", AUTO.pauseOnAdmin);
    setStatus(AUTO.pauseOnAdmin ? "status.pause_on_admin_on" : "status.pause_on_admin_off");
  }

  function toggleAutoBuyBootyKeys() {
    AUTO.autoBuyBootyKeys = !AUTO.autoBuyBootyKeys;
    document
      .getElementById("rg-sec-auto-booty-key")
      ?.classList.toggle("selected", AUTO.autoBuyBootyKeys);
    setStatus(AUTO.autoBuyBootyKeys ? "status.booty_key_auto_on" : "status.booty_key_auto_off");
  }

  function bindSecurityPanelEvents() {
    bindSecurityNumberInput("rg-sec-portal-wait", (v) => {
      AUTO.portalWaitSec = v;
    }, 0, 120);
    bindSecurityNumberInput("rg-sec-base-wait", (v) => {
      AUTO.baseWaitSec = v;
    }, 0, 300);
    bindSecurityNumberInput("rg-sec-death-limit", (v) => {
      AUTO.deathLimit = v;
    }, 0, 999);
    bindSecurityNumberInput("rg-sec-flee-hp", (v) => {
      AUTO.fleeHpPercent = v;
    }, 0, 100);
    bindSecurityNumberInput("rg-sec-session-limit", (v) => {
      AUTO.sessionLimitMin = v;
    }, 0, 999);
    bindSecurityNumberInput("rg-sec-coffee-interval", (v) => {
      AUTO.coffeeBreakIntervalMin = v;
      if (AUTO.active) scheduleNextCoffeeBreak();
    }, 0, 720);
    bindSecurityNumberInput("rg-sec-coffee-duration", (v) => {
      AUTO.coffeeBreakDurationMin = Math.max(1, v || 1);
    }, 1, 180);
    bindSecurityNumberInput("rg-sec-coffee-tolerance", (v) => {
      AUTO.coffeeBreakToleranceMin = Math.max(0, v || 0);
    }, 0, 60);
    document.getElementById("rg-sec-flee-enemies")?.addEventListener("click", toggleFleeEnemyPlayers);
    document.getElementById("rg-sec-flee-cloak")?.addEventListener("click", toggleFleeUseCloak);
    document.getElementById("rg-sec-flee-sap")?.addEventListener("click", toggleFleeUseSap);
    document.getElementById("rg-sec-pause-admin")?.addEventListener("click", togglePauseOnAdmin);

    document.getElementById("rg-device-copy")?.addEventListener("click", async () => {
      const id = AUTO.deviceId || (await ensureDeviceId());
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(id);
          setStatus("status.device_copied");
        }
      } catch (_) {}
    });

    document.getElementById("rg-license-apply")?.addEventListener("click", () => {
      const input = document.getElementById("rg-license-key");
      applyLicenseKey(input?.value || "").catch((err) => {
        AUTO.licenseValid = false;
        AUTO.licenseMessage = `Licenza: ${err.message || err}`;
        updateLicenseUI();
        updateLicenseLock();
      });
    });
    document.getElementById("rg-license-paste")?.addEventListener("click", () => {
      pasteLicenseFromClipboard();
    });
    document.getElementById("rg-game-update")?.addEventListener("click", () => {
      requestHostGameUpdate();
    });
    document.getElementById("rg-bastion-update")?.addEventListener("click", () => {
      requestHostBastionUpdate();
    });
    refreshBastionVersionLabel();
    bindLicenseInputInteractions();
  }

  function requestHostGameUpdate() {
    const statusEl = document.getElementById("rg-game-update-status");
    const payload = { action: "updateGame" };
    let pollId = 0;

    const stopPoll = () => {
      if (pollId) {
        clearInterval(pollId);
        pollId = 0;
      }
    };

    const startPoll = () => {
      stopPoll();
      let ticks = 0;
      let lastPhase = "";
      let lastPercent = -1;
      let stuckTicks = 0;
      pollId = window.setInterval(() => {
        ticks += 1;
        fetch("/__bastion__/update-status", { cache: "no-store" })
          .then((res) => (res.ok ? res.json() : null))
          .then((data) => {
            if (!data || !statusEl) return;
            if (data.phase === "done") {
              statusEl.textContent = data.message || t("ui.game_update_done");
              stopPoll();
              return;
            }
            if (data.phase === "error") {
              statusEl.textContent = `${t("ui.game_update_failed")}: ${data.error || data.message || ""}`;
              stopPoll();
              return;
            }
            if (data.running || data.phase !== "idle") {
              const pct = Number(data.percent) || 0;
              if (data.phase === lastPhase && pct === lastPercent) stuckTicks += 1;
              else stuckTicks = 0;
              lastPhase = data.phase;
              lastPercent = pct;
              statusEl.textContent = `${data.message || t("ui.game_update_started")}${pct ? ` (${pct}%)` : ""}`;
              // Host should fail with timeout; if status never advances, surface it.
              if (stuckTicks >= 180) {
                statusEl.textContent = `${t("ui.game_update_failed")}: timeout (nessun progresso per 3 min)`;
                stopPoll();
              }
            }
          })
          .catch(() => {});
        if (ticks > 600) {
          if (statusEl) {
            statusEl.textContent = `${t("ui.game_update_failed")}: timeout (10 min)`;
          }
          stopPoll();
        }
      }, 1000);
    };

    try {
      if (window.webkit?.messageHandlers?.bastionHost?.postMessage) {
        window.webkit.messageHandlers.bastionHost.postMessage(payload);
        if (statusEl) statusEl.textContent = t("ui.game_update_started");
        startPoll();
        return;
      }
    } catch (_) {}
    try {
      if (window.bastionHost?.updateGame) {
        window.bastionHost.updateGame();
        if (statusEl) statusEl.textContent = t("ui.game_update_started");
        startPoll();
        return;
      }
    } catch (_) {}
    try {
      fetch("/__bastion__/update-game", { method: "POST" }).then((res) => {
        if (statusEl) {
          statusEl.textContent = res.ok
            ? t("ui.game_update_started")
            : t("ui.game_update_unavailable");
        }
        if (res.ok) startPoll();
      }).catch(() => {
        if (statusEl) statusEl.textContent = t("ui.game_update_unavailable");
      });
      return;
    } catch (_) {}
    if (statusEl) statusEl.textContent = t("ui.game_update_unavailable");
  }

  function refreshBastionVersionLabel() {
    const el = document.getElementById("rg-bastion-version-label");
    if (!el) return;
    const apply = (version) => {
      el.textContent = t("ui.bastion_update_current", { version: version || BASTION_APP_VERSION });
    };
    apply(BASTION_APP_VERSION);
    fetch("/__bastion__/bastion-version", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.version) apply(String(data.version));
      })
      .catch(() => {});
  }

  function requestHostBastionUpdate() {
    const statusEl = document.getElementById("rg-bastion-update-status");
    const payload = { action: "updateBastion" };
    let pollId = 0;

    const stopPoll = () => {
      if (pollId) {
        clearInterval(pollId);
        pollId = 0;
      }
    };

    const startPoll = () => {
      stopPoll();
      let ticks = 0;
      pollId = window.setInterval(() => {
        ticks += 1;
        fetch("/__bastion__/update-status", { cache: "no-store" })
          .then((res) => (res.ok ? res.json() : null))
          .then((data) => {
            if (!data || !statusEl) return;
            if (data.kind && data.kind !== "bastion") return;
            if (data.phase === "done") {
              statusEl.textContent = data.message || t("ui.bastion_update_done");
              stopPoll();
              return;
            }
            if (data.phase === "error") {
              const err = data.error || data.message || "";
              statusEl.textContent =
                err === "configure_url" || /OWNER\/REPO|configura/i.test(String(err + data.message))
                  ? t("ui.bastion_update_configure")
                  : `${t("ui.bastion_update_failed")}: ${err || data.message || ""}`;
              stopPoll();
              return;
            }
            if (data.running || data.phase !== "idle") {
              const pct = Number(data.percent) || 0;
              statusEl.textContent = `${data.message || t("ui.bastion_update_started")}${pct ? ` (${pct}%)` : ""}`;
            }
          })
          .catch(() => {});
        if (ticks > 600) stopPoll();
      }, 1000);
    };

    try {
      if (window.webkit?.messageHandlers?.bastionHost?.postMessage) {
        window.webkit.messageHandlers.bastionHost.postMessage(payload);
        if (statusEl) statusEl.textContent = t("ui.bastion_update_started");
        // Mac host uses modal alerts; light status only.
        return;
      }
    } catch (_) {}
    try {
      if (window.bastionHost?.updateBastion) {
        window.bastionHost.updateBastion();
        if (statusEl) statusEl.textContent = t("ui.bastion_update_started");
        startPoll();
        return;
      }
    } catch (_) {}
    try {
      fetch("/__bastion__/update-bastion", { method: "POST" })
        .then((res) => {
          if (statusEl) {
            statusEl.textContent = res.ok
              ? t("ui.bastion_update_started")
              : t("ui.bastion_update_unavailable");
          }
          if (res.ok) startPoll();
        })
        .catch(() => {
          if (statusEl) statusEl.textContent = t("ui.bastion_update_unavailable");
        });
      return;
    } catch (_) {}
    if (statusEl) statusEl.textContent = t("ui.bastion_update_unavailable");
  }

  function isEditableTarget(el) {
    if (!el) return false;
    const tag = String(el.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || el.isContentEditable;
  }

  function bindPanelFormInput(el) {
    if (!el || el.dataset.rgFormBound === "1") return;
    el.dataset.rgFormBound = "1";

    const stopBubble = (ev) => ev.stopPropagation();
    for (const type of ["pointerdown", "mousedown", "keydown", "keyup", "paste", "copy", "cut", "focus", "click"]) {
      el.addEventListener(type, stopBubble);
    }
  }

  function bindLicenseInputInteractions() {
    const input = document.getElementById("rg-license-key");
    if (!input || input.dataset.rgLicenseBound === "1") return;
    input.dataset.rgLicenseBound = "1";
    bindPanelFormInput(input);

    input.addEventListener("paste", (ev) => {
      ev.stopPropagation();
      const text = ev.clipboardData?.getData("text/plain") || "";
      if (!text) return;
      ev.preventDefault();
      input.value = text.trim().replace(/\s+/g, "");
    });

    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "v") {
        ev.preventDefault();
        pasteLicenseFromClipboard();
        return;
      }
      if (ev.key === "Enter") document.getElementById("rg-license-apply")?.click();
    });
  }

  function bindDiscordWebhookInputInteractions() {
    const input = document.getElementById("rg-discord-webhook-url");
    if (!input || input.dataset.rgDiscordBound === "1") return;
    input.dataset.rgDiscordBound = "1";
    bindPanelFormInput(input);

    input.addEventListener("paste", (ev) => {
      ev.stopPropagation();
      const text = ev.clipboardData?.getData("text/plain") || "";
      if (!text) return;
      ev.preventDefault();
      input.value = String(text).trim().replace(/\s+/g, "");
      AUTO.discordWebhookUrl = input.value;
      saveDiscordWebhookPrefs();
    });

    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "v") {
        ev.preventDefault();
        pasteDiscordWebhookFromClipboard();
      }
    });
  }

  async function pasteLicenseFromClipboard() {
    const input = document.getElementById("rg-license-key");
    if (!input) return;

    if (navigator.clipboard?.readText) {
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          input.value = text.trim().replace(/\s+/g, "");
          input.focus();
          setStatus("status.key_pasted");
          return;
        }
      } catch (_) {
        /* fallback below */
      }
    }

    setStatus("status.paste_manual");
    input.focus();
  }

  async function pasteDiscordWebhookFromClipboard() {
    const input = document.getElementById("rg-discord-webhook-url");
    if (!input) return;

    if (navigator.clipboard?.readText) {
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          input.value = String(text).trim().replace(/\s+/g, "");
          AUTO.discordWebhookUrl = input.value;
          saveDiscordWebhookPrefs();
          input.focus();
          setStatus("status.webhook_pasted");
          setDiscordWebhookStatus(t("status.webhook_pasted"));
          return;
        }
      } catch (_) {
        /* fallback below */
      }
    }

    setStatus("status.paste_manual");
    setDiscordWebhookStatus(t("status.paste_manual"));
    input.focus();
  }

  function bytesToBase64url(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function timingSafeEqual(a, b) {
    const left = String(a || "");
    const right = String(b || "");
    if (left.length !== right.length) return false;
    let out = 0;
    for (let i = 0; i < left.length; i += 1) out |= left.charCodeAt(i) ^ right.charCodeAt(i);
    return out === 0;
  }

  function decodeBase64UrlJson(body) {
    let b64 = String(body || "").replace(/-/g, "+").replace(/_/g, "/");
    const pad = (4 - (b64.length % 4)) % 4;
    if (pad) b64 += "=".repeat(pad);
    return JSON.parse(atob(b64));
  }

  function parseLicenseKey(rawKey) {
    // Strip whitespace/newlines so longer --device keys survive chat/email wraps.
    const key = String(rawKey || "").trim().replace(/\s+/g, "");
    if (!key.startsWith(`${LICENSE_PREFIX}.`)) {
      return { valid: false, messageKey: "license.invalid_format" };
    }

    const parts = key.split(".");
    if (parts.length !== 3) return { valid: false, messageKey: "license.invalid_format" };

    const body = parts[1];
    const sig = parts[2];
    let payload;
    try {
      payload = decodeBase64UrlJson(body);
    } catch (_) {
      return { valid: false, messageKey: "license.invalid_payload" };
    }

    if (payload.product !== LICENSE_PRODUCT) {
      return { valid: false, messageKey: "license.wrong_product" };
    }

    const exp = Number(payload.exp) || 0;
    if (!exp) return { valid: false, messageKey: "license.no_expiry" };
    if (Date.now() >= exp * 1000) {
      return { valid: false, messageKey: "license.expired", exp };
    }

    return { valid: true, messageKey: "license.active", exp, body, sig, payload, key };
  }

  async function validateDeviceBinding(payload) {
    if (!payload?.did) return { ok: true };
    const localId = await ensureDeviceId();
    if (String(payload.did).toUpperCase() !== localId) {
      return { ok: false, messageKey: "license.device_mismatch" };
    }
    return { ok: true };
  }

  async function verifyLicenseSignature(body, sig) {
    if (!LICENSE_HMAC_SECRET || LICENSE_HMAC_SECRET === "CHANGE_ME_BEFORE_RELEASE") {
      return false;
    }
    if (!globalThis.crypto?.subtle) return false;

    const enc = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      enc.encode(LICENSE_HMAC_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const mac = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(body));
    return timingSafeEqual(bytesToBase64url(new Uint8Array(mac)), sig);
  }

  async function validateLicenseRemotely(key) {
    if (!LICENSE_VALIDATE_URL) return null;
    try {
      const deviceId = await ensureDeviceId();
      const res = await fetch(LICENSE_VALIDATE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key,
          product: LICENSE_PRODUCT,
          deviceId,
          action: "activate",
        }),
      });
      if (!res.ok) return { valid: false, messageKey: "license.server_unavailable" };
      const data = await res.json();
      if (data.reason === "device_mismatch" || data.reason === "already_bound") {
        return { valid: false, messageKey: "license.device_already_bound" };
      }
      return {
        valid: Boolean(data.valid),
        messageKey: data.valid ? "license.active" : "license.server_rejected",
        message: data.message,
        exp: Number(data.exp) || 0,
      };
    } catch (_) {
      return { valid: false, messageKey: "license.online_failed" };
    }
  }

  async function validateLicenseKey(rawKey) {
    const parsed = parseLicenseKey(rawKey);
    if (!parsed.valid) return parsed;

    const signed = await verifyLicenseSignature(parsed.body, parsed.sig);
    if (!signed) {
      return { valid: false, messageKey: "license.invalid_signature", exp: parsed.exp };
    }

    const deviceCheck = await validateDeviceBinding(parsed.payload);
    if (!deviceCheck.ok) {
      return { valid: false, messageKey: deviceCheck.messageKey, exp: parsed.exp };
    }

    if (LICENSE_VALIDATE_URL) {
      const remote = await validateLicenseRemotely(parsed.key);
      if (remote && !remote.valid) return remote;
    }

    return parsed;
  }

  function licenseMessageFromParsed(parsed) {
    if (parsed.messageKey) return t(parsed.messageKey);
    return parsed.message || t("license.active");
  }

  function formatLicenseExpiry(exp) {
    if (!exp) return "—";
    return new Date(exp * 1000).toLocaleString();
  }

  function updateLicenseUI() {
    const statusEl = document.getElementById("rg-license-status");
    const cardEl = document.getElementById("rg-license-card");
    const keyEl = document.getElementById("rg-license-key");
    if (keyEl && document.activeElement !== keyEl && AUTO.licenseKey) {
      keyEl.value = AUTO.licenseKey;
    }
    if (statusEl) {
      if (AUTO.licenseChecking) {
        statusEl.textContent = t("ui.license.checking");
      } else if (AUTO.licenseValid) {
        statusEl.textContent = t("ui.license.active_until", {
          date: formatLicenseExpiry(AUTO.licenseExpiresAt),
        });
      } else {
        statusEl.textContent = AUTO.licenseMessage || t("ui.license.required");
      }
    }
    if (cardEl) cardEl.classList.toggle("rg-license-valid", AUTO.licenseValid);

    const deviceEl = document.getElementById("rg-device-id");
    if (deviceEl && AUTO.deviceId) deviceEl.textContent = AUTO.deviceId;
  }

  function updateLicenseLock() {
    const lockEl = document.getElementById("rg-license-lock");
    const playBtn = document.getElementById("rg-story-play-main");
    const sessionBusy = AUTO.active || NAV.active || state.running;
    const running = sessionBusy && !AUTO.paused;
    if (playBtn) playBtn.disabled = running || !AUTO.licenseValid;

    document.querySelectorAll(`#${PANEL_ID} .rg-tab`).forEach((btn) => {
      const locked = !AUTO.licenseValid && btn.dataset.tab !== "settings";
      btn.classList.toggle("rg-tab-locked", locked);
      btn.disabled = locked;
    });

    if (lockEl) {
      const showLock = !AUTO.licenseValid && AUTO.activeTab !== "settings";
      lockEl.classList.toggle("rg-license-lock-hidden", !showLock);
    }
  }

  function isAppLicensed() {
    if (!AUTO.licenseValid) return false;
    if (!AUTO.licenseExpiresAt) return false;
    return Date.now() < AUTO.licenseExpiresAt * 1000;
  }

  async function applyLicenseKey(rawKey) {
    AUTO.licenseChecking = true;
    updateLicenseUI();

    const parsed = await validateLicenseKey(rawKey);
    AUTO.licenseChecking = false;
    AUTO.licenseKey = String(rawKey || "").trim();
    AUTO.licenseValid = parsed.valid;
    AUTO.licenseExpiresAt = parsed.exp || 0;
    AUTO.licenseMessage = licenseMessageFromParsed(parsed);

    if (parsed.valid) {
      try {
        localStorage.setItem(LICENSE_STORAGE_KEY, AUTO.licenseKey);
      } catch (_) {}
      setStatus("license.activated");
    } else {
      try {
        localStorage.removeItem(LICENSE_STORAGE_KEY);
      } catch (_) {}
    }

    updateLicenseUI();
    updateLicenseLock();
    applyI18n();
    return parsed.valid;
  }

  async function loadStoredLicense() {
    let stored = "";
    try {
      stored = localStorage.getItem(LICENSE_STORAGE_KEY) || "";
    } catch (_) {}

    if (!stored) {
      AUTO.licenseValid = false;
      AUTO.licenseMessage =
        LICENSE_HMAC_SECRET === "CHANGE_ME_BEFORE_RELEASE"
          ? t("license.configure_secret")
          : t("license.enter_key");
      updateLicenseUI();
      updateLicenseLock();
      return false;
    }

    return applyLicenseKey(stored);
  }

  async function ensureLicensed() {
    if (isAppLicensed()) return true;
    if (AUTO.licenseKey) {
      const ok = await applyLicenseKey(AUTO.licenseKey);
      if (ok) return true;
    }
    return false;
  }

  function enforceLicenseGate() {
    if (isAppLicensed()) return true;
    AUTO.licenseValid = false;
    updateLicenseUI();
    updateLicenseLock();
    if (AUTO.active) stopPlay();
    switchPanelTab("settings");
    setStatus(AUTO.licenseMessage || "ui.license.required");
    return false;
  }

  function switchPanelTab(tabId) {
    if (!AUTO.licenseValid && tabId !== "settings") {
      tabId = "settings";
      setStatus("license.activate_in_settings");
    }
    AUTO.activeTab = tabId;
    document.querySelectorAll(`#${PANEL_ID} .rg-tab`).forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === tabId);
    });
    document.querySelectorAll(`#${PANEL_ID} .rg-tab-panel`).forEach((panel) => {
      panel.classList.toggle("active", panel.dataset.tab === tabId);
    });
    document.getElementById("rg-panel-settings")?.classList.toggle("selected", tabId === "settings");
    updateLicenseLock();
  }

  function scheduleNextWander() {
    if (!isInRaidMap()) {
      // Standard maps: leave almost immediately after arriving (tiny settle only).
      AUTO.nextWanderDelay = randBetween(0, 280);
    } else {
      AUTO.nextWanderDelay = randBetween(AUTO.wanderMinMs, AUTO.wanderMaxMs);
    }
    AUTO.lastWanderAt = Date.now();
  }

  /**
   * Hold still only during real engage / sticky fight / scoop / death-flee.
   * Bare combatActive with no target must NOT block wander (map exploration).
   */
  function shouldSuppressWander() {
    if (AUTO.postDeathRecover || AUTO.healSafeTravel) return true;
    if (AUTO.fleeActive || AUTO.combatSuspendedForFlee) return true;
    if (AUTO.pendingCombatCargo && canCollectCargoNow()) {
      clearPhantomPendingCargoBlockingCombat();
      // Never freeze the ship mid-attack waiting for phantom cargo.
      if (
        AUTO.pendingCombatCargo &&
        !hasLivingStickyCombat() &&
        !isNpcStillFightable(AUTO.pendingCombatCargo.npcId) &&
        !getNpcSprite(AUTO.pendingCombatCargo.npcId)?.alive
      ) {
        return true;
      }
    }
    if (AUTO.raidCargoClear && canCollectCargoNow() && !hasLivingStickyCombat()) {
      return true;
    }
    // Never wander while a combat task is still open (gap before clearTaskIfDone).
    if (AUTO.currentTask === "combat" && AUTO.taskTargetId) return true;
    if (
      AUTO.combatTargetGoneAt &&
      Date.now() - AUTO.combatTargetGoneAt < COMBAT_TARGET_GONE_CONFIRM_MS
    ) {
      return true;
    }
    if (isCombatEngaged()) return true;
    const focusId = AUTO.combatFocusId || AUTO.taskTargetId || AUTO.combatTargetId;
    if (
      focusId &&
      (isNpcStillFightable(focusId) ||
        getNpcSprite(focusId)?.alive ||
        !isCombatTargetConfirmedGone(focusId))
    ) {
      return true;
    }
    return false;
  }

  function driveWanderTick() {
    const input = getInputSystem();
    const ship = getShipPosition();
    if (!input || !ship) return;
    if (isRaidHealActive()) return;
    if (shouldSuppressWander()) return;

    ensureActiveConfig(AUTO.roamConfig);

    if (isInRaidMap()) {
      const center = getRaidCenter();
      const dist = distance(ship.x, ship.y, center.x, center.y);
      const maxR = getRaidTurretRange() * 0.72;
      if (dist > maxR) {
        const pt = getRaidSupportPoint(ship, 0.62);
        setMoveTargetDirect(input, pt.x, pt.y);
        setStatus(`Raid: resto nel raggio torre (${Math.round(dist)}m)`);
        return;
      }
    }

    if (input.moveTarget) {
      const dist = distance(ship.x, ship.y, input.moveTarget.x, input.moveTarget.y);
      if (dist > AUTO.arriveDistance) {
        setStatus(`Esplorazione (${Math.round(dist)}m)`);
        return;
      }
      input.moveTarget = null;
    }

    const now = Date.now();
    if (now - AUTO.lastWanderAt >= AUTO.nextWanderDelay) {
      let moved = false;
      if (isInRaidMap()) {
        const center = getRaidCenter();
        const angle = Math.random() * Math.PI * 2;
        // Pattuglia sul ring esterno torre (non il centro dove spawnano le onde)
        const r = getRaidTurretRange() * (0.55 + Math.random() * 0.22);
        const wx = center.x + Math.cos(angle) * r;
        const wy = center.y + Math.sin(angle) * r;
        moveViaMinimap(wx, wy);
        moved = true;
      } else {
        moved = clickMinimapRandom();
      }
      if (moved) {
        scheduleNextWander();
        setStatus(isInRaidMap() ? "Raid: pattuglio ring torre" : "Esplorazione minimappa");
      } else {
        AUTO.lastWanderAt = now - AUTO.nextWanderDelay + 900;
      }
    }
  }

  function mainTick() {
    installKeepAlive();
    installGameHooks();
    hookMinimap(getMinimap());
    syncMapDimsFromWindow();

    if (AUTO.active && !isAppLicensed()) {
      enforceLicenseGate();
      return;
    }

    if (AUTO.active && processSecurityGates()) return;

    if (NAV.active && driveNavigationTick()) return;

    if (!AUTO.active || AUTO.paused) return;

    // Optional booty-key buy (safe zone only) — never mandatory.
    maybeAutoBuyBootyKey();

    const input = getInputSystem();
    const ship = getShipPosition();
    if (!input || !ship) {
      const dbg = debugSnapshot();
      setStatus(`Attendo mappa... game=${dbg.game ? "ok" : "no"} scene=${dbg.scene ? "ok" : "no"}`);
      return;
    }

    if (processSecurityMovement(input, ship)) return;

    const game = getGame();
    if (game?.isPaused) game.resume();

    if (processRefineryTick()) return;

    if (abortCargoCollectIfHoldFull()) {
      // Hold full: pending/move cleared — fall through to combat/wander immediately
    }

    if (AUTO.active && AUTO.modeAttack && listSelectedPrimaryAmmoTypes().length && processCombatAmmoTick()) return;

    if (driveRaidAutomation(input, ship)) return;

    // Arm post-kill cargo before the scoop driver so standard maps scoop on the
    // same tick the NPC disappears (raid already held retarget in clearTaskIfDone).
    clearTaskIfDone();

    // Kill flicker can leave a phantom pending that freezes on "Attendo cargo".
    // mac40/mac41: confirmed kills + mandatory phase are kept; re-arm so scoop
    // owns the tick before portal-drift cold heal.
    if (AUTO.pendingCombatCargo) clearPhantomPendingCargoBlockingCombat();
    rearmPendingCombatCargoFromRecentKillSite();

    // HARD RULE: mandatory post-kill cargo phase owns the tick before heal/search.
    if (drivePendingCombatCargoTick(input, ship)) return;

    // Raid Gate: clear→scoop every visible cargo before combat search / wander.
    if (driveRaidCargoSweepTick(input, ship)) return;

    if (runCurrentTask()) return;

    // While cargo lifecycle open, pickNewTask is a no-op (blocks heal + next NPC).
    if (pickNewTask() && runCurrentTask()) return;

    explainIdleReason();
    // Sticky fight / scoop / death-flee: hold still — no Esplorazione flicker.
    // combatActive alone with no target: wander so attack mode can find NPCs.
    if (shouldSuppressWander()) return;

    driveWanderTick();
  }

  function autoTick() {
    mainTick();
  }

  function updatePlayControls() {
    const pauseBtn = document.getElementById("rg-story-pause");
    const stopBtn = document.getElementById("rg-story-stop");
    const playBtn = document.getElementById("rg-story-play-main");
    const orbPlay = document.getElementById("rg-orb-play");
    const orbPause = document.getElementById("rg-orb-pause");
    const orbStop = document.getElementById("rg-orb-stop");
    if (!pauseBtn || !stopBtn) return;
    const sessionBusy = AUTO.active || NAV.active || state.running;
    const running = sessionBusy && !AUTO.paused;
    const paused = sessionBusy && AUTO.paused;
    // Full panel: Play enabled when stopped/paused; Pause only while running
    pauseBtn.disabled = !running;
    pauseBtn.textContent = t("ui.pause");
    stopBtn.disabled = !sessionBusy;
    if (playBtn) playBtn.disabled = running || !AUTO.licenseValid;

    // Mini toolbar (screenshot layout): NEVER show two Plays.
    // idle/stopped → Play only
    // paused      → Play + Stop (single resume Play on the left)
    // running     → Pause + Stop (Play hidden)
    const showOrbPlay = !running;
    const showOrbPause = running;
    const showOrbStop = sessionBusy;
    if (orbPlay) {
      const playLabel = paused ? t("ui.resume") : t("ui.play");
      orbPlay.disabled = running || !AUTO.licenseValid;
      orbPlay.title = playLabel;
      orbPlay.setAttribute("aria-label", playLabel);
      orbPlay.hidden = !showOrbPlay;
      orbPlay.style.display = showOrbPlay ? "" : "none";
      orbPlay.setAttribute("aria-hidden", showOrbPlay ? "false" : "true");
    }
    if (orbPause) {
      orbPause.disabled = !running;
      orbPause.title = t("ui.pause");
      orbPause.setAttribute("aria-label", t("ui.pause"));
      orbPause.hidden = !showOrbPause;
      orbPause.style.display = showOrbPause ? "" : "none";
      orbPause.setAttribute("aria-hidden", showOrbPause ? "false" : "true");
    }
    if (orbStop) {
      orbStop.disabled = !sessionBusy;
      orbStop.title = t("ui.stop");
      orbStop.setAttribute("aria-label", t("ui.stop"));
      orbStop.hidden = !showOrbStop;
      orbStop.style.display = showOrbStop ? "" : "none";
      orbStop.setAttribute("aria-hidden", showOrbStop ? "false" : "true");
    }
  }

  function togglePausePlay() {
    if (!(AUTO.active || NAV.active || state.running)) return;
    // Pause only pauses; resume happens via Play (no dual Play icons)
    if (AUTO.paused) return;
    AUTO.paused = true;
    state.paused = true;
    const btn = document.getElementById("rg-story-pause");
    if (btn) btn.textContent = t("ui.pause");
    setStatus("status.paused");
    updateOrbVisual();
    updatePlayControls();
  }

  function resumeFromPause() {
    if (!AUTO.paused) return false;
    if (!(AUTO.active || NAV.active || state.running)) return false;
    AUTO.paused = false;
    state.paused = false;
    const btn = document.getElementById("rg-story-pause");
    if (btn) btn.textContent = t("ui.pause");
    setStatus("status.resumed");
    updateOrbVisual();
    updatePlayControls();
    return true;
  }

  function setPlayControls(active) {
    const playBtn = document.getElementById("rg-story-play-main");
    const pauseBtn = document.getElementById("rg-story-pause");
    const stopBtn = document.getElementById("rg-story-stop");
    const modeCollectBonusBtn = document.getElementById("rg-mode-collect-bonus");
    const modeCollectCargoBtn = document.getElementById("rg-mode-collect-cargo");
    const modeCollectBootyBtn = document.getElementById("rg-mode-collect-booty");
    const modeAttackBtn = document.getElementById("rg-mode-attack");
    const modeOrbitBtn = document.getElementById("rg-mode-orbit");
    if (!playBtn || !pauseBtn || !stopBtn) return;
    const running = active && !AUTO.paused;
    playBtn.disabled = running || !AUTO.licenseValid;
    if (modeCollectBonusBtn) modeCollectBonusBtn.disabled = active;
    if (modeCollectCargoBtn) modeCollectCargoBtn.disabled = active;
    if (modeCollectBootyBtn) modeCollectBootyBtn.disabled = active;
    if (modeAttackBtn) modeAttackBtn.disabled = active;
    if (modeOrbitBtn) modeOrbitBtn.disabled = active;
    listNpcToggleDisabled(active);
    if (!active && !NAV.active && !state.running) {
      resetPauseState();
    } else if (active) {
      resetPauseState();
    }
    updatePlayControls();
    updateOrbVisual();
  }

  function listNpcToggleDisabled(disabled) {
    document.querySelectorAll("#rg-npc-list [data-npc-type]").forEach((btn) => {
      btn.disabled = disabled;
    });
  }

  async function startPlay() {
    if (resumeFromPause()) return;
    if (!(await ensureLicensed())) {
      enforceLicenseGate();
      return;
    }
    if (AUTO.active) return;
    await loadMapGraph();
    const dbg = debugSnapshot();
    if (!dbg.scene || !dbg.ship) {
      setStatus("status.enter_map_play");
      return;
    }
    if (!hasAnyCollectMode() && !AUTO.modeAttack) {
      setStatus("status.select_modes");
      return;
    }
    if (AUTO.modeAttack && AUTO.selectedNpcTypes.size === 0) {
      setStatus("status.select_npc_attack");
      return;
    }
    if (!hasPlayObjective()) {
      setStatus("status.need_play_objective");
      return;
    }
    // No raid selected → never keep a stale pending that would travel to X-7.
    if (!AUTO.raidGateId) {
      AUTO.pendingRaidGate = null;
      NAV.pendingRaidGate = null;
    }
    if (AUTO.raidGateId) {
      const gateId = resolveRaidGate(AUTO.raidGateId);
      const currentId = getCurrentMapId();
      // On faction X-7 (raid hub): missing portal → block Play immediately.
      if (gateId && isFactionRaidHubMap(currentId) && !isRaidGatePortalAvailable(gateId)) {
        setStatus("status.raid_gate_unavailable", { gate: gateId.toUpperCase() });
        return;
      }
    }

    installGameHooks();
    stopScript();
    captureSessionBaseline();
    capturePlayLoginIdentity();
    beginSessionTimers();
    AUTO.active = true;
    AUTO.bootyKeyBuysThisSession = 0;
    AUTO.bootyKeyBuyPending = false;
    resetPauseState();
    AUTO.chasingBonusId = null;
    AUTO.pendingCollectId = null;
    clearCurrentTask();
    scheduleNextWander();
    installKeepAlive();
    ensureUiLoop();

    if (AUTO.modeAttack) {
      startCombatFromSelection();
    }

    AUTO.timerId = window.setInterval(mainTick, AUTO.tickMs);
    setPlayControls(true);

    // Abort any leftover navigation from a previous session before cold heal.
    // stopPlay used to leave NAV.active running (only stopAll cleared it).
    if (NAV.active) stopNavigation();
    AUTO.healSafeTravel = false;
    AUTO.fleeActive = false;
    AUTO.fleeMode = null;
    // Snapshot map at Play press: cold resume stays here unless workingMapId differs
    // (user changed objective while stopped after stopPlay pinned working map).
    AUTO.coldPlayStayMapId = getCurrentMapId() || "";

    // Cold Play: Attack config only + never leave map for hub heal (see driveHealSafeZoneTravelTick).
    beginPreObjectiveHeal({ armBaseWait: false, kind: "cold" });
    mainTick();

    if (!AUTO.postDeathRecover) {
      const parts = [];
      if (hasAnyCollectMode()) parts.push("Raccolta");
      if (AUTO.modeAttack) parts.push("Attacco");
      if (AUTO.modeOrbit) parts.push("Orbita");
      setStatus(`Play: ${parts.join(" + ")}`);
    }
  }

  function stopPlay() {
    AUTO.active = false;
    resetPauseState();
    AUTO.pendingRaidGate = null;
    NAV.pendingRaidGate = null;
    AUTO.fleeActive = false;
    AUTO.fleeMode = null;
    AUTO.combatSuspendedForFlee = false;
    AUTO.raidHealMode = false;
    AUTO.raidExecutionerLatched = false;
    AUTO.pendingConfigIndex = null;
    clearRaidProgressTracking();
    clearPostDeathRecoverState();
    AUTO.coldPlayStayMapId = "";
    AUTO.raidWaveRepositionUntil = 0;
    AUTO.raidWaveEscapeDir = 0;
    AUTO.raidOrbitExpandUntil = 0;
    resetRaidDangerState();
    resetSessionTimers();
    AUTO.deathCount = 0;
    AUTO.wasDead = false;
    AUTO.repairSentThisDeath = false;
    AUTO.repairSentAt = 0;
    AUTO.deathSignalSince = 0;
    AUTO.deathInfoReceived = false;
    AUTO.postArrivalSecurityGraceUntil = 0;
    stopCombat();
    resetOrbitState();
    AUTO.chasingBonusId = null;
    AUTO.pendingCollectId = null;
    AUTO.pendingCombatCargo = null;
    AUTO.mandatoryPostKillCargo = null;
    AUTO.cargoCollectInFlightId = null;
    AUTO.lastCargoCollectAttempt = null;
    AUTO.cargoSkipUntilUsedBelow = null;
    AUTO.cargoSkipLatchedAt = 0;
    AUTO.raidStageClearCargoUntil = 0;
    AUTO.raidStageClearCargoStartedAt = 0;
    AUTO.raidCargoClear = null;
    AUTO.cargoSettledNpcIds.clear();
    AUTO.recentCargoKillSites = [];
    AUTO.foreignNpcIds.clear();
    AUTO.lootOwnerById.clear();
    AUTO.countedNpcKillIds.clear();
    // Soft-move / orbit hold memory must not re-assert waypoints after Stop.
    AUTO.lastMinimapTarget = null;
    AUTO.lastMinimapMoveAt = 0;
    AUTO.lastMinimapStickyId = null;
    AUTO.orbitHumanHoldUntil = 0;
    clearCurrentTask();
    if (AUTO.timerId) {
      clearInterval(AUTO.timerId);
      AUTO.timerId = null;
    }
    // Stop leftover map/flee/raid nav — otherwise Play can resume a mid-hop to X-1.
    stopNavigation();
    // Product: Stop → Play must continue where the ship is. Pin working map to
    // current so cold heal → finishPostDeathRecoverAndResume cannot beginPlayTravel
    // to a stale hub (X-1) left in the dropdown / prior objective.
    syncWorkingMapToCurrentMap("stop");
    uninstallKeepAlive();
    const input = getInputSystem();
    if (input) {
      input.moveTarget = null;
      input.attackMode = false;
      input.pendingAttackOnLock = null;
    }
    const K = getGameState();
    if (K) K.cargoTargetId = null;
    clearLockedTarget();
    setPlayControls(false);
    if (!state.running) setStatus("status.stopped");
  }

  function stopAll() {
    stopPlay();
    stopScript();
  }

  function startAuto() {
    syncCollectMasterFlag();
    startPlay();
  }

  function stopAuto() {
    stopPlay();
  }

  function waitForReadyStatus() {
    if (AUTO.readyCheckId) return;
    AUTO.readyCheckId = window.setInterval(() => {
      const dbg = debugSnapshot();
      installGameHooks();
      if (dbg.scene && dbg.ship) {
        setStatus("status.ready");
        clearInterval(AUTO.readyCheckId);
        AUTO.readyCheckId = null;
        return;
      }
      setStatus("status.login_map");
    }, 1000);
  }

  function updateOrbVisual() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel || !AUTO.panelMinimized) return;
    const busy = AUTO.active || NAV.active || state.running;
    panel.classList.toggle("rg-orb-active", busy && !AUTO.paused);
    panel.classList.toggle("rg-orb-paused", busy && AUTO.paused);
    panel.classList.toggle("rg-orb-idle", !busy);
  }

  function setPanelMinimized(minimized) {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    AUTO.panelMinimized = minimized;
    panel.classList.toggle("rg-panel-minimized", minimized);

    const btn = document.getElementById("rg-panel-minimize");
    if (btn) {
      btn.textContent = minimized ? "□" : "◎";
      btn.title = minimized ? t("ui.orb.expand_panel") : t("ui.orb.minimize");
    }

    if (minimized) {
      const rect = panel.getBoundingClientRect();
      panel.style.right = "auto";
      panel.style.left = `${Math.round(rect.left)}px`;
      panel.style.top = `${Math.round(rect.top)}px`;
      panel.style.cursor = "default";
    } else {
      resetPanelDockPosition();
      panel.style.cursor = "";
    }

    updatePlayControls();
    updateOrbVisual();
    applyUiZoom();
  }

  function togglePanelMinimized() {
    setPanelMinimized(!AUTO.panelMinimized);
  }

  function openSettingsSection() {
    if (AUTO.panelMinimized) setPanelMinimized(false);
    switchPanelTab("settings");
  }

  function loadUiZoomPreference() {
    try {
      const raw = localStorage.getItem(UI_ZOOM_STORAGE_KEY);
      if (raw == null || raw === "") return;
      const n = Number(raw);
      if (!Number.isFinite(n)) return;
      // Snap to slider step (5) so restart matches the control the user set.
      const snapped = Math.round(n / 5) * 5;
      AUTO.uiZoomPercent = clamp(snapped, 75, 125);
    } catch (_) {}
  }

  function applyUiZoom() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const pct = clamp(Number(AUTO.uiZoomPercent) || 100, 75, 125);
    AUTO.uiZoomPercent = pct;
    panel.style.transform = pct === 100 ? "" : `scale(${pct / 100})`;
    panel.style.transformOrigin = AUTO.panelMinimized ? "top left" : "top right";
    const label = document.getElementById("rg-settings-zoom-value");
    if (label) label.textContent = `${pct}%`;
    const slider = document.getElementById("rg-settings-zoom");
    if (slider && document.activeElement !== slider) slider.value = String(pct);
  }

  function setUiZoomPercent(pct) {
    AUTO.uiZoomPercent = clamp(Math.round(Number(pct) || 100), 75, 125);
    try {
      localStorage.setItem(UI_ZOOM_STORAGE_KEY, String(AUTO.uiZoomPercent));
    } catch (_) {}
    applyUiZoom();
  }

  function initUiZoomControls() {
    loadUiZoomPreference();
    applyUiZoom();
    const slider = document.getElementById("rg-settings-zoom");
    if (!slider || slider.dataset.bound === "1") return;
    slider.dataset.bound = "1";
    slider.value = String(AUTO.uiZoomPercent || 100);
    slider.addEventListener("input", () => setUiZoomPercent(slider.value));
    slider.addEventListener("change", () => setUiZoomPercent(slider.value));
  }

  function initPanelOrbDrag() {
    const panel = document.getElementById(PANEL_ID);
    const orbFace = panel?.querySelector(".rg-panel-orb-face");
    if (!panel || !orbFace || panel.dataset.orbDragReady === "1") return;
    panel.dataset.orbDragReady = "1";

    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    orbFace.addEventListener("pointerdown", (ev) => {
      if (!AUTO.panelMinimized || ev.button !== 0) return;
      if (ev.target.closest(".rg-orb-quick-actions")) return;
      dragging = true;
      moved = false;
      AUTO.orbDragMoved = false;
      const rect = panel.getBoundingClientRect();
      startX = ev.clientX;
      startY = ev.clientY;
      panel.style.right = "auto";
      panel.style.left = `${rect.left}px`;
      panel.style.top = `${rect.top}px`;
      startLeft = rect.left;
      startTop = rect.top;
      orbFace.setPointerCapture(ev.pointerId);
      orbFace.style.cursor = "grabbing";
      ev.preventDefault();
    });

    orbFace.addEventListener("pointermove", (ev) => {
      if (!dragging) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 5) {
        moved = true;
        AUTO.orbDragMoved = true;
      }
      const size = panel.offsetWidth || 120;
      const height = panel.offsetHeight || 40;
      const left = clamp(startLeft + dx, 4, Math.max(4, window.innerWidth - size - 4));
      const top = clamp(startTop + dy, 4, Math.max(4, window.innerHeight - height - 4));
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    });

    const finishDrag = (ev) => {
      if (!dragging) return;
      dragging = false;
      orbFace.style.cursor = "grab";
      try {
        orbFace.releasePointerCapture(ev.pointerId);
      } catch (_) {
        /* ignore */
      }
      if (!moved && AUTO.panelMinimized) {
        setPanelMinimized(false);
      }
    };

    orbFace.addEventListener("pointerup", finishDrag);
    orbFace.addEventListener("pointercancel", finishDrag);
  }

  function ensureStyles() {
    if (document.getElementById("rg-story-style")) return;
    const style = document.createElement("style");
    style.id = "rg-story-style";
    style.textContent = `
      #${PANEL_ID} {
        position: fixed;
        top: 4px;
        right: 8px;
        bottom: 4px;
        z-index: 100000;
        box-sizing: border-box;
        width: 380px;
        height: calc(100vh - 8px);
        max-height: calc(100vh - 8px);
        overflow: hidden;
        display: flex;
        flex-direction: column;
        background: rgba(8, 12, 24, 0.94);
        border: 2px solid rgba(31, 157, 99, 0.8);
        border-radius: 10px;
        color: #e8f0ff;
        /* Avoid Segoe UI metrics inflation on Windows vs Mac system fonts */
        font: 12px/1.4 Arial, "Helvetica Neue", Helvetica, sans-serif;
        -webkit-font-smoothing: antialiased;
        box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
        transition: width 0.22s ease, height 0.22s ease, border-radius 0.22s ease, box-shadow 0.22s ease;
      }
      #${PANEL_ID}.rg-panel-minimized {
        width: auto !important;
        height: 32px !important;
        min-width: unset;
        max-height: 32px;
        bottom: auto;
        overflow: hidden;
        border-radius: 16px;
        padding: 0;
        cursor: default;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(8, 12, 24, 0.94);
        border-color: rgba(31, 157, 99, 0.8);
        box-shadow: 0 5px 18px rgba(31, 157, 99, 0.4);
      }
      #${PANEL_ID} .rg-panel-expanded {
        display: flex;
        flex-direction: column;
        flex: 1 1 auto;
        min-height: 0;
        overflow: hidden;
      }
      #${PANEL_ID}.rg-panel-minimized .rg-panel-expanded {
        display: none !important;
        visibility: hidden !important;
        pointer-events: none !important;
      }
      #${PANEL_ID} .rg-story-chrome {
        flex: 0 0 auto;
      }
      #${PANEL_ID} .rg-panel-orb-wrap,
      #${PANEL_ID} #rg-mini-orb {
        display: none;
        box-sizing: border-box;
        align-items: center;
        justify-content: center;
        height: 32px;
        gap: 4px;
        padding: 4px;
      }
      #${PANEL_ID}.rg-panel-minimized .rg-panel-orb-wrap,
      #${PANEL_ID}.rg-panel-minimized #rg-mini-orb {
        display: flex;
      }
      #${PANEL_ID} .rg-panel-orb-face {
        display: none;
        box-sizing: border-box;
        width: 24px;
        height: 24px;
        flex: 0 0 24px;
        align-items: center;
        justify-content: center;
        margin: 0;
        border-radius: 50%;
        cursor: grab;
        pointer-events: auto;
        background: radial-gradient(circle at 32% 28%, #5dffb8 0%, #1f9d63 42%, #0b3d28 100%);
        box-shadow: inset 0 -2px 6px rgba(0, 0, 0, 0.25);
      }
      #${PANEL_ID}.rg-panel-minimized .rg-panel-orb-face {
        display: flex;
      }
      #${PANEL_ID} .rg-orb-quick-actions {
        display: none;
        box-sizing: border-box;
        align-items: center;
        justify-content: center;
        gap: 4px;
        padding: 0;
        height: 24px;
      }
      #${PANEL_ID}.rg-panel-minimized .rg-orb-quick-actions {
        display: flex;
      }
      #${PANEL_ID} .rg-orb-quick-btn {
        box-sizing: border-box;
        width: 24px;
        height: 24px;
        min-width: 24px;
        border-radius: 50%;
        border: 1px solid rgba(157, 255, 208, 0.45);
        background: rgba(20, 40, 32, 0.92);
        color: #9dffd0;
        font-size: 9px;
        line-height: 1;
        cursor: pointer;
        padding: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      #${PANEL_ID} #rg-orb-play {
        padding-left: 1px;
      }
      #${PANEL_ID} .rg-ico {
        display: block;
        flex: 0 0 auto;
        pointer-events: none;
      }
      #${PANEL_ID} .rg-ico-play {
        width: 0;
        height: 0;
        border-style: solid;
        border-width: 5px 0 5px 8px;
        border-color: transparent transparent transparent currentColor;
        margin-left: 1px;
      }
      #${PANEL_ID} .rg-ico-pause {
        position: relative;
        width: 8px;
        height: 10px;
      }
      #${PANEL_ID} .rg-ico-pause::before,
      #${PANEL_ID} .rg-ico-pause::after {
        content: "";
        position: absolute;
        top: 0;
        width: 2.5px;
        height: 100%;
        background: currentColor;
        border-radius: 0.5px;
      }
      #${PANEL_ID} .rg-ico-pause::before { left: 0; }
      #${PANEL_ID} .rg-ico-pause::after { right: 0; }
      #${PANEL_ID} .rg-ico-stop {
        width: 8px;
        height: 8px;
        background: currentColor;
        border-radius: 1px;
      }
      #${PANEL_ID} .rg-orb-quick-btn:hover:not(:disabled) {
        background: rgba(31, 157, 99, 0.55);
      }
      #${PANEL_ID} .rg-orb-quick-btn:disabled {
        opacity: 0.38;
        cursor: default;
      }
      #${PANEL_ID} .rg-orb-quick-btn[hidden],
      #${PANEL_ID} .rg-orb-quick-btn[aria-hidden="true"] {
        display: none !important;
      }
      #${PANEL_ID} .rg-orb-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.82);
        box-shadow: 0 0 4px rgba(255, 255, 255, 0.45);
      }
      #${PANEL_ID}.rg-orb-active .rg-orb-dot {
        animation: rg-orb-pulse 1.5s ease-in-out infinite;
      }
      #${PANEL_ID}.rg-orb-paused .rg-orb-dot {
        background: #ffd2a8;
        box-shadow: 0 0 8px rgba(255, 210, 168, 0.75);
      }
      #${PANEL_ID}.rg-orb-idle .rg-orb-dot {
        opacity: 0.72;
      }
      @keyframes rg-orb-pulse {
        0%, 100% { opacity: 0.7; transform: scale(0.82); }
        50% { opacity: 1; transform: scale(1.12); }
      }
      #${PANEL_ID} .rg-story-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 10px 12px 6px;
        font-weight: 700;
        color: #9dffd0;
      }
      #${PANEL_ID} .rg-story-head-title {
        flex: 1;
        min-width: 0;
      }
      #${PANEL_ID} .rg-story-head-actions {
        display: flex;
        align-items: center;
        gap: 4px;
        flex: 0 0 auto;
      }
      #${PANEL_ID} .rg-zoom-field input[type="range"] {
        width: 100%;
        margin-top: 6px;
      }
      #${PANEL_ID} .rg-panel-icon-btn.selected {
        border-color: rgba(31, 157, 99, 0.9);
        color: #7dffc0;
      }
      #${PANEL_ID} .rg-panel-icon-btn {
        flex: 0 0 auto;
        width: 26px;
        height: 26px;
        min-width: 26px;
        padding: 0;
        border-radius: 50%;
        background: rgba(31, 157, 99, 0.22);
        border: 1px solid rgba(157, 255, 208, 0.45);
        color: #9dffd0;
        font-size: 13px;
        line-height: 1;
        cursor: pointer;
      }
      #${PANEL_ID} .rg-panel-icon-btn:hover {
        background: rgba(31, 157, 99, 0.42);
      }
      #${PANEL_ID} .rg-story-status-bar {
        padding: 0 12px 6px;
        color: #b8c7e6;
        min-height: 18px;
        display: flex;
        align-items: flex-start;
        gap: 8px;
      }
      #${PANEL_ID} .rg-story-status-bar #rg-story-status {
        flex: 1;
        min-width: 0;
      }
      #${PANEL_ID} #rg-timer-countdown {
        flex: 0 0 auto;
        font-variant-numeric: tabular-nums;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.02em;
        color: #9dffd0;
        background: rgba(20, 70, 48, 0.55);
        border: 1px solid rgba(157, 255, 208, 0.35);
        border-radius: 4px;
        padding: 1px 6px;
        line-height: 1.35;
        white-space: nowrap;
      }
      #${PANEL_ID} #rg-timer-countdown[hidden] {
        display: none !important;
      }
      #${PANEL_ID} .rg-sec-live-cd {
        margin-left: 6px;
        font-variant-numeric: tabular-nums;
        font-weight: 700;
        color: #9dffd0;
        font-size: 11px;
      }
      #${PANEL_ID} .rg-sec-live-cd[hidden] {
        display: none !important;
      }
      #${PANEL_ID} .rg-story-actions-main {
        padding: 0 12px 10px;
        border-bottom: 1px solid rgba(120, 170, 255, 0.18);
        margin-bottom: 4px;
      }
      #${PANEL_ID} .rg-tabs {
        display: flex;
        gap: 4px;
        padding: 0 10px 8px;
        border-bottom: 1px solid rgba(120, 170, 255, 0.18);
      }
      #${PANEL_ID} .rg-tab {
        flex: 1;
        border: 1px solid rgba(120, 170, 255, 0.18);
        border-radius: 6px;
        padding: 5px 2px;
        background: rgba(20, 28, 48, 0.85);
        color: #b8c7e6;
        font-size: 10px;
        font-weight: 600;
        cursor: pointer;
      }
      #${PANEL_ID} .rg-tab.active {
        border-color: rgba(31, 157, 99, 0.95);
        background: rgba(20, 70, 48, 0.75);
        color: #e8f0ff;
      }
      #${PANEL_ID} .rg-tab.rg-tab-locked {
        opacity: 0.45;
        cursor: not-allowed;
      }
      #${PANEL_ID} .rg-tab-panels-wrap {
        position: relative;
        flex: 1 1 auto;
        min-height: 120px;
        overflow: auto;
      }
      #${PANEL_ID} .rg-license-lock {
        position: absolute;
        inset: 0;
        z-index: 12;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 18px;
        text-align: center;
        background: rgba(8, 12, 22, 0.88);
        color: #ffd2a8;
        font-size: 12px;
        line-height: 1.45;
        border-radius: 0 0 10px 10px;
      }
      #${PANEL_ID} .rg-license-lock.rg-license-lock-hidden {
        display: none;
      }
      #${PANEL_ID} .rg-license-card {
        border-color: rgba(255, 196, 120, 0.35);
        margin-bottom: 10px;
      }
      #${PANEL_ID} .rg-license-card.rg-license-valid {
        border-color: rgba(31, 157, 99, 0.65);
      }
      #${PANEL_ID} .rg-license-actions {
        display: flex;
        gap: 6px;
        margin-top: 6px;
      }
      #${PANEL_ID} .rg-license-actions input {
        flex: 1;
        min-width: 0;
        background: rgba(20, 28, 48, 0.95);
        border: 1px solid rgba(120, 170, 255, 0.22);
        border-radius: 6px;
        color: #e8f0ff;
        padding: 6px 8px;
        font-size: 11px;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        user-select: text;
        -webkit-user-select: text;
        pointer-events: auto;
      }
      #${PANEL_ID} .rg-license-actions button {
        flex: 0 0 auto;
      }
      #${PANEL_ID} .rg-device-field {
        margin-top: 8px;
      }
      #${PANEL_ID} .rg-device-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 4px;
        min-width: 0;
      }
      #${PANEL_ID} .rg-device-code {
        flex: 1 1 auto;
        min-width: 0;
        font-size: 11px;
        line-height: 1.35;
        padding: 6px 8px;
        border-radius: 6px;
        background: rgba(0, 0, 0, 0.25);
        border: 1px solid rgba(120, 170, 255, 0.2);
        user-select: all;
        -webkit-user-select: all;
        white-space: nowrap;
        overflow-x: auto;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      #${PANEL_ID} .rg-device-row .secondary.mini {
        flex: 0 0 auto;
      }
      #${PANEL_ID} .rg-locale-field select {
        width: 100%;
      }
      #${PANEL_ID} .rg-field input,
      #${PANEL_ID} .rg-field select {
        user-select: text;
        -webkit-user-select: text;
        pointer-events: auto;
      }
      #${PANEL_ID} .rg-tab-panel { display: none; padding: 10px 12px; }
      #${PANEL_ID} .rg-tab-panel.active { display: block; }
      #${PANEL_ID} .rg-story-body {
        padding: 0 12px 8px;
        color: #b8c7e6;
      }
      #${PANEL_ID} .rg-story-meta {
        margin-top: 4px;
        font-size: 11px;
        color: #8ea5cf;
      }
      #${PANEL_ID} .rg-group {
        border: 1px solid rgba(120, 170, 255, 0.18);
        border-radius: 8px;
        padding: 8px 10px;
        margin-bottom: 8px;
        background: rgba(14, 20, 36, 0.65);
      }
      #${PANEL_ID} .rg-group-title {
        font-weight: 600;
        color: #9dffd0;
        margin-bottom: 6px;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      #${PANEL_ID} .rg-field {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 6px;
      }
      #${PANEL_ID} .rg-field:last-child { margin-bottom: 0; }
      #${PANEL_ID} .rg-field label {
        font-size: 11px;
        color: #b8c7e6;
        flex: 1;
      }
      #${PANEL_ID} .rg-field select,
      #${PANEL_ID} .rg-field input {
        flex: 0 0 130px;
        background: rgba(20, 28, 48, 0.95);
        border: 1px solid rgba(120, 170, 255, 0.22);
        border-radius: 6px;
        color: #e8f0ff;
        padding: 4px 6px;
        font-size: 11px;
        -moz-appearance: textfield;
      }
      #${PANEL_ID} .rg-field input[type="number"]::-webkit-outer-spin-button,
      #${PANEL_ID} .rg-field input[type="number"]::-webkit-inner-spin-button {
        -webkit-appearance: none;
        margin: 0;
      }
      #${PANEL_ID} .rg-ore-row {
        margin-top: 2px;
      }
      #${PANEL_ID} .rg-ore-row .rg-mode-toggle {
        flex: 1;
        min-width: 0;
        padding: 5px 4px;
        font-size: 10px;
      }
      #${PANEL_ID} .rg-enhance-label {
        font-size: 10px;
        color: #8ea5cf;
        margin: 4px 0 2px;
      }
      #${PANEL_ID} .rg-current-map {
        font-size: 13px;
        font-weight: 700;
        color: #ffd2a8;
        margin-bottom: 4px;
      }
      #${PANEL_ID} .rg-portals-list {
        max-height: 90px;
        overflow: auto;
        margin-top: 4px;
      }
      #${PANEL_ID} .rg-portal-row,
      #${PANEL_ID} .rg-portal-empty {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        font-size: 10px;
        color: #8ea5cf;
        padding: 3px 0;
        border-bottom: 1px solid rgba(120, 170, 255, 0.08);
      }
      #${PANEL_ID} .rg-portal-dist { color: #ffb199; }
      #${PANEL_ID} .rg-nav-row {
        display: flex;
        gap: 6px;
        margin-top: 6px;
      }
      #${PANEL_ID} .rg-nav-row input { flex: 1; }
      #${PANEL_ID} .rg-story-actions {
        display: flex;
        gap: 6px;
        padding: 0 12px 8px;
      }
      #${PANEL_ID} .rg-story-actions-secondary {
        padding: 0 12px 10px;
      }
      #${PANEL_ID} button {
        flex: 1;
        border: 0;
        border-radius: 7px;
        padding: 7px 8px;
        cursor: pointer;
        background: #2f5fd1;
        color: #fff;
        font: inherit;
        font-size: 11px;
        font-weight: 600;
        line-height: 1.3;
        letter-spacing: 0.01em;
      }
      #${PANEL_ID} button.secondary { background: #2a3348; }
      #${PANEL_ID} button.auto { background: #1f9d63; }
      #${PANEL_ID} button.danger { background: #c0392b; }
      #${PANEL_ID} button.mini {
        flex: 0 0 auto;
        min-width: 34px;
        padding: 4px 8px;
        font-size: 13px;
      }
      #${PANEL_ID} button:disabled { opacity: 0.45; cursor: default; }
      #${PANEL_ID} .rg-panel-icon-btn {
        flex: 0 0 auto;
        width: 26px;
        height: 26px;
        min-width: 26px;
        padding: 0;
        border-radius: 50%;
        background: rgba(31, 157, 99, 0.22);
        border: 1px solid rgba(157, 255, 208, 0.45);
        color: #9dffd0;
        font-size: 13px;
        line-height: 1;
      }
      #${PANEL_ID} .rg-panel-icon-btn:hover {
        background: rgba(31, 157, 99, 0.42);
      }
      #${PANEL_ID} .rg-stats-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      #${PANEL_ID} .rg-stat-box {
        border: 1px solid rgba(120, 170, 255, 0.18);
        border-radius: 8px;
        overflow: hidden;
        background: rgba(14, 20, 36, 0.65);
      }
      #${PANEL_ID} .rg-stat-box-title {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 6px 8px;
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        color: #9dffd0;
        border-bottom: 1px solid rgba(120, 170, 255, 0.12);
      }
      #${PANEL_ID} .rg-stat-box-title #rg-stat-npc-selected-count {
        font-variant-numeric: tabular-nums;
        color: #ffb199;
        font-size: 12px;
      }
      #${PANEL_ID} .rg-stat-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 10px;
      }
      #${PANEL_ID} .rg-stat-table td {
        padding: 4px 8px;
        border-bottom: 1px solid rgba(120, 170, 255, 0.08);
        color: #d7e4ff;
      }
      #${PANEL_ID} .rg-stat-table td.rg-stat-num {
        text-align: right;
        font-weight: 700;
        color: #ffb199;
        white-space: nowrap;
      }
      #${PANEL_ID} .rg-stat-empty {
        text-align: center;
        color: #8ea5cf;
        padding: 8px !important;
      }
      #${PANEL_ID} .rg-stat-note {
        font-size: 10px;
        color: #8ea5cf;
        text-align: right;
        margin-top: 4px;
      }
      #${PANEL_ID} .rg-npc-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 0 0 6px;
        font-weight: 600;
        color: #ffd2a8;
      }
      #${PANEL_ID} .rg-npc-list {
        display: flex;
        flex-direction: column;
        gap: 4px;
        max-height: 280px;
        overflow: auto;
        margin-bottom: 8px;
      }
      #${PANEL_ID} .rg-npc-item {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 2px;
        width: 100%;
        text-align: left;
        background: rgba(20, 28, 48, 0.95);
        border: 1px solid rgba(120, 170, 255, 0.18);
        border-radius: 7px;
        padding: 7px 9px;
        color: #e8f0ff;
        cursor: pointer;
      }
      #${PANEL_ID} .rg-npc-item.selected {
        border-color: rgba(255, 120, 80, 0.95);
        background: rgba(70, 24, 24, 0.75);
      }
      #${PANEL_ID} .rg-mode-actions {
        display: flex;
        gap: 6px;
        padding-bottom: 6px;
      }
      #${PANEL_ID} .rg-mode-toggle {
        flex: 1;
        background: rgba(20, 28, 48, 0.95);
        border: 1px solid rgba(120, 170, 255, 0.18);
        color: #e8f0ff;
      }
      #${PANEL_ID} .rg-mode-toggle.selected {
        border-color: rgba(31, 157, 99, 0.95);
        background: rgba(20, 70, 48, 0.75);
      }
      #${PANEL_ID} .rg-npc-head-actions { display: flex; gap: 4px; }
      #${PANEL_ID} .rg-npc-name { font-weight: 600; font-size: 12px; }
      #${PANEL_ID} .rg-npc-meta { font-size: 10px; color: #8ea5cf; }
      #${PANEL_ID} .rg-npc-empty { color: #8ea5cf; font-size: 11px; padding: 8px 2px; }
    `;
    document.head.appendChild(style);
  }

  function buildPanel() {
    ensureStyles();
    if (document.getElementById(PANEL_ID)) return;

    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="rg-panel-orb-wrap" id="rg-mini-orb">
        <div class="rg-panel-orb-face" data-i18n-title="ui.orb.expand" title="Click to expand · drag to move">
          <span class="rg-orb-dot"></span>
        </div>
        <div class="rg-orb-quick-actions">
          <button id="rg-orb-play" type="button" class="rg-orb-quick-btn" title="Play" aria-label="Play"><span class="rg-ico rg-ico-play" aria-hidden="true"></span></button>
          <button id="rg-orb-pause" type="button" class="rg-orb-quick-btn" title="Pause" aria-label="Pause" disabled><span class="rg-ico rg-ico-pause" aria-hidden="true"></span></button>
          <button id="rg-orb-stop" type="button" class="rg-orb-quick-btn" title="Stop" aria-label="Stop" disabled><span class="rg-ico rg-ico-stop" aria-hidden="true"></span></button>
        </div>
      </div>
      <div class="rg-panel-expanded">
      <div class="rg-story-chrome">
      <div class="rg-story-head">
        <span class="rg-story-head-title" id="rg-story-head-title">RedGalaxy Bastion</span>
        <div class="rg-story-head-actions">
          <button id="rg-panel-minimize" type="button" class="rg-panel-icon-btn" data-i18n-title="ui.orb.minimize" title="Minimize to orb">◎</button>
        </div>
      </div>
      <div class="rg-story-body rg-story-status-bar">
        <div id="rg-story-status">Loading...</div>
        <span id="rg-timer-countdown" hidden></span>
      </div>
      <div class="rg-story-actions rg-story-actions-main">
        <button id="rg-story-play-main" class="auto" type="button">Play</button>
        <button id="rg-story-pause" type="button" class="secondary" disabled>Pause</button>
        <button id="rg-story-stop" type="button" class="secondary" disabled>Stop</button>
      </div>
      <div class="rg-tabs">
        <button type="button" class="rg-tab active" data-tab="general">General</button>
        <button type="button" class="rg-tab" data-tab="collect">Collect</button>
        <button type="button" class="rg-tab" data-tab="attack">Attack</button>
        <button type="button" class="rg-tab" data-tab="security">Security</button>
        <button type="button" class="rg-tab" data-tab="settings">Settings</button>
      </div>
      </div>

      <div class="rg-tab-panels-wrap">
      <div id="rg-license-lock" class="rg-license-lock rg-license-lock-hidden" data-i18n="ui.license.lock">
        App locked — enter a valid license in Settings
      </div>

      <div class="rg-tab-panel active" data-tab="general">
        <div class="rg-group">
          <div class="rg-group-title" data-i18n="ui.map">Map</div>
          <div class="rg-current-map"><span data-i18n="ui.position">Position:</span> <span id="rg-current-map">—</span></div>
          <div class="rg-field">
            <label for="rg-working-map" data-i18n="ui.working_map">Working Map</label>
            <select id="rg-working-map"><option value="" data-i18n="ui.none_option">— none —</option></select>
          </div>
          <div class="rg-field">
            <label for="rg-raid-target" data-i18n="ui.raid_gate">Raid Gate</label>
            <select id="rg-raid-target">
              <option value="">— nessuno —</option>
              <option value="void">VOID</option>
              <option value="rift">RIFT</option>
              <option value="nebula">NEBULA</option>
              <option value="inferno">INFERNO</option>
            </select>
          </div>
          <div class="rg-story-meta" data-i18n="ui.map.play_hint">With Play: reaches Working Map or Raid Gate before working</div>
          <div class="rg-story-meta" data-i18n="ui.portals_visible">Visible portals</div>
          <div id="rg-portals-list" class="rg-portals-list"></div>
        </div>
        <div class="rg-group">
          <div class="rg-group-title" data-i18n="ui.ship_configs">Ship configurations</div>
          <div class="rg-field">
            <label for="rg-attack-config" data-i18n="ui.attack_config">Attack config</label>
            <select id="rg-attack-config">
              <option value="1">1</option>
              <option value="2">2</option>
            </select>
          </div>
          <div class="rg-field">
            <label for="rg-roam-config" data-i18n="ui.roam_config">Roam config</label>
            <select id="rg-roam-config">
              <option value="1">1</option>
              <option value="2" selected>2</option>
            </select>
          </div>
          <div class="rg-field">
            <label for="rg-run-config" data-i18n="ui.run_config">Run config</label>
            <select id="rg-run-config">
              <option value="1">1</option>
              <option value="2" selected>2</option>
            </select>
          </div>
          <div class="rg-field">
            <label for="rg-executioner-config" data-i18n="ui.executioner_config">Executioner attack config</label>
            <select id="rg-executioner-config">
              <option value="1">1</option>
              <option value="2" selected>2</option>
            </select>
          </div>
          <div class="rg-story-meta" data-i18n="ui.executioner_config_hint">Raid last round (11/11) only: attack + flee use this config</div>
        </div>
        <div class="rg-group">
          <div class="rg-group-title" data-i18n="ui.statistics">Statistics</div>
          <div class="rg-stats-grid">
            <div class="rg-stat-box">
              <div class="rg-stat-box-title">
                <span data-i18n="ui.stat_npc_selected">Selected NPC types</span>
                <span id="rg-stat-npc-selected-count">0</span>
              </div>
              <table class="rg-stat-table">
                <tbody id="rg-stat-npc-table"></tbody>
              </table>
            </div>
            <div class="rg-stat-box">
              <div class="rg-stat-box-title" data-i18n="ui.stat_results">Results</div>
              <table class="rg-stat-table">
                <tbody id="rg-stat-summary-table"></tbody>
              </table>
            </div>
          </div>
          <div class="rg-stat-note"><span data-i18n="ui.stat_note">Approximate stats · NPC kills:</span> <span id="rg-stat-npc-kills">0</span></div>
        </div>
      </div>

      <div class="rg-tab-panel" data-tab="collect">
        <div class="rg-group">
          <div class="rg-group-title" data-i18n="ui.collect">Collect</div>
          <div class="rg-mode-actions">
            <button id="rg-mode-collect-bonus" type="button" class="rg-mode-toggle">Bonus box</button>
          </div>
          <div class="rg-mode-actions">
            <button id="rg-mode-collect-cargo" type="button" class="rg-mode-toggle">Cargo NPC</button>
          </div>
          <div class="rg-mode-actions">
            <button id="rg-mode-collect-booty" type="button" class="rg-mode-toggle">Bauli</button>
            <button id="rg-sec-auto-booty-key" type="button" class="rg-mode-toggle" data-i18n="ui.sec.auto_booty_key">Buy 1 booty key in safe zone if keys=0</button>
          </div>
        </div>
        <div class="rg-group">
          <div class="rg-group-title" data-i18n="ui.refinery">Refinery</div>
          <div class="rg-mode-actions">
            <button id="rg-refinery-sell" type="button" class="rg-mode-toggle">Vendi minerali</button>
          </div>
          <div class="rg-mode-actions">
            <button id="rg-refinery-antimatter" type="button" class="rg-mode-toggle">Invia antimateria</button>
          </div>
          <div class="rg-mode-actions">
            <button id="rg-refinery-refine" type="button" class="rg-mode-toggle">Autoraffinamento</button>
          </div>
          <div class="rg-mode-actions">
            <button id="rg-refinery-enhance" type="button" class="rg-mode-toggle">Potenziamento</button>
          </div>
          <div class="rg-story-meta" data-i18n="ui.refinery_sell_hint">Sell: everything except Plutonium, Tritium, Antimatter (Premium)</div>
          <div class="rg-story-meta" data-i18n="ui.refinery_antimatter_hint">Send antimatter: transfers ship antimatter to warehouse (Premium)</div>
          <div class="rg-enhance-label" data-i18n="ui.laser_ores">Laser — ores</div>
          <div class="rg-mode-actions rg-ore-row">
            <button type="button" class="rg-mode-toggle" data-refinery-category="LASER" data-refinery-ore="TITANIUM">Titanio</button>
            <button type="button" class="rg-mode-toggle" data-refinery-category="LASER" data-refinery-ore="PLUTONIUM">Plutonio</button>
            <button type="button" class="rg-mode-toggle" data-refinery-category="LASER" data-refinery-ore="ANTIMATTER">Antimateria</button>
          </div>
          <div class="rg-enhance-label" data-i18n="ui.rocket_ores">Rockets — ores</div>
          <div class="rg-mode-actions rg-ore-row">
            <button type="button" class="rg-mode-toggle" data-refinery-category="ROCKET" data-refinery-ore="TITANIUM">Titanio</button>
            <button type="button" class="rg-mode-toggle" data-refinery-category="ROCKET" data-refinery-ore="PLUTONIUM">Plutonio</button>
            <button type="button" class="rg-mode-toggle" data-refinery-category="ROCKET" data-refinery-ore="ANTIMATTER">Antimateria</button>
          </div>
          <div class="rg-enhance-label" data-i18n="ui.shield_ores">Shield — ores</div>
          <div class="rg-mode-actions rg-ore-row">
            <button type="button" class="rg-mode-toggle" data-refinery-category="SHIELD" data-refinery-ore="URANIUM">Uranio</button>
            <button type="button" class="rg-mode-toggle" data-refinery-category="SHIELD" data-refinery-ore="TRITIUM">Tritio</button>
            <button type="button" class="rg-mode-toggle" data-refinery-category="SHIELD" data-refinery-ore="ANTIMATTER">Antimateria</button>
          </div>
          <div class="rg-enhance-label" data-i18n="ui.speed_ores">Engines — ores</div>
          <div class="rg-mode-actions rg-ore-row">
            <button type="button" class="rg-mode-toggle" data-refinery-category="SPEED" data-refinery-ore="URANIUM">Uranio</button>
            <button type="button" class="rg-mode-toggle" data-refinery-category="SPEED" data-refinery-ore="TRITIUM">Tritio</button>
            <button type="button" class="rg-mode-toggle" data-refinery-category="SPEED" data-refinery-ore="ANTIMATTER">Antimateria</button>
          </div>
          <div class="rg-story-meta" data-i18n="ui.refinery_enhance_hint">Enhancement: enable toggle above and pick ores per category</div>
        </div>
      </div>

      <div class="rg-tab-panel" data-tab="attack">
        <div class="rg-group">
          <div class="rg-group-title" data-i18n="ui.npc_killer">NPC Killer</div>
          <div class="rg-mode-actions">
            <button id="rg-mode-attack" type="button" class="rg-mode-toggle">Attacco NPC</button>
            <button id="rg-mode-orbit" type="button" class="rg-mode-toggle">Orbita</button>
            <button id="rg-mode-portal-drift" type="button" class="rg-mode-toggle" data-i18n="ui.orbit_portal_drift">Portal drift</button>
          </div>
          <div class="rg-enhance-label" data-i18n="ui.ammo_primary">Primary ammo (multi-select)</div>
          <div class="rg-mode-actions rg-ore-row">
            ${COMBAT_PRIMARY_AMMO_TYPES.map(
              (entry) =>
                `<button type="button" class="rg-mode-toggle" data-combat-ammo="${entry.key}">${entry.label}</button>`
            ).join("")}
          </div>
          <div class="rg-enhance-label" data-i18n="ui.ammo_special">Special (requires LAP)</div>
          <div class="rg-mode-actions rg-ore-row">
            ${COMBAT_SPECIAL_AMMO_TYPES.map(
              (entry) =>
                `<button type="button" class="rg-mode-toggle" data-combat-ammo="${entry.key}">${entry.label}</button>`
            ).join("")}
          </div>
          <div class="rg-enhance-label" data-i18n="ui.ammo_buy">Buy ammo (shop pack)</div>
          <div class="rg-mode-actions rg-ore-row">
            ${COMBAT_AMMO_BUY_QTY_OPTIONS.map(
              (qty) =>
                `<button type="button" class="rg-mode-toggle" data-combat-ammo-buy="${qty}">${qty === 0 ? "Off" : qty}</button>`
            ).join("")}
          </div>
          <div class="rg-story-meta" id="rg-combat-ammo-status" data-i18n="ui.ammo_status_manual">ammo: manual</div>
          <div class="rg-story-meta" id="rg-ammo-autobuy-hint" data-i18n="ui.ammo_autobuy_hint" data-i18n-threshold="${COMBAT_AMMO_LOW_THRESHOLD}">Auto-buy: if active (&gt;0) resupplies below ${COMBAT_AMMO_LOW_THRESHOLD} for active type</div>
        </div>
        <div class="rg-npc-head">
          <span id="rg-npc-types-label">NPC types (<span id="rg-npc-count">0</span> visible)</span>
          <div class="rg-npc-head-actions">
            <button id="rg-npc-select-all" type="button" class="secondary mini" data-i18n-title="ui.npc_select_all_title" title="Select all">All</button>
            <button id="rg-npc-clear" type="button" class="secondary mini" data-i18n-title="ui.npc_clear_title" title="Clear selection">None</button>
            <button id="rg-npc-refresh" type="button" class="secondary mini" data-i18n-title="ui.npc_refresh_title" title="Refresh">↻</button>
          </div>
        </div>
        <div id="rg-npc-list" class="rg-npc-list">
          <div class="rg-npc-empty" data-i18n="ui.npc_empty">Available NPC types</div>
        </div>
        <div class="rg-story-meta" data-i18n="ui.npc_multi_hint">Multi-click to select several types</div>
      </div>

      <div class="rg-tab-panel" data-tab="security">
        <div class="rg-group">
          <div class="rg-group-title" data-i18n="ui.security">Security</div>
          <div class="rg-field">
            <label for="rg-sec-portal-wait"><span data-i18n="ui.sec.portal_wait">Post-portal wait (s)</span><span id="rg-sec-portal-countdown" class="rg-sec-live-cd" hidden></span></label>
            <input id="rg-sec-portal-wait" type="text" inputmode="numeric" autocomplete="off" value="3" />
          </div>
          <div class="rg-field">
            <label for="rg-sec-base-wait"><span data-i18n="ui.sec.base_wait">Base wait after death (s)</span><span id="rg-sec-base-countdown" class="rg-sec-live-cd" hidden></span></label>
            <input id="rg-sec-base-wait" type="text" inputmode="numeric" autocomplete="off" value="5" />
          </div>
          <div class="rg-field">
            <label for="rg-sec-death-limit" data-i18n="ui.sec.death_limit">Death limit (0=off)</label>
            <input id="rg-sec-death-limit" type="text" inputmode="numeric" autocomplete="off" value="0" />
          </div>
          <div class="rg-field">
            <label for="rg-sec-flee-hp" data-i18n="ui.sec.flee_hp">Flee below HP %</label>
            <input id="rg-sec-flee-hp" type="text" inputmode="numeric" autocomplete="off" value="30" />
          </div>
          <div class="rg-mode-actions">
            <button id="rg-sec-flee-enemies" type="button" class="rg-mode-toggle">Flee from enemies</button>
            <button id="rg-sec-flee-sap" type="button" class="rg-mode-toggle" data-i18n="ui.sec.flee_sap">Use SAP shield on PvP flee</button>
            <button id="rg-sec-flee-cloak" type="button" class="rg-mode-toggle" data-i18n="ui.sec.flee_cloak">Cloak on PvP flee</button>
            <button id="rg-sec-pause-admin" type="button" class="rg-mode-toggle" data-i18n="ui.sec.pause_on_admin">Pause if admin detected</button>
          </div>
          <div class="rg-story-meta" data-i18n="ui.sec.flee_enemies_hint">Enemies: other-faction players (incl. cloaked/minimap) → flee to allied portal</div>
          <div class="rg-story-meta" data-i18n="ui.sec.pause_on_admin_hint">Admin/staff in AOI → nearest portal, hold for coffee-break duration</div>
          <div class="rg-field">
            <label for="rg-sec-session-limit" data-i18n="ui.sec.session_limit">Auto-stop timer (min, 0=off)</label>
            <input id="rg-sec-session-limit" type="text" inputmode="numeric" autocomplete="off" value="0" />
          </div>
          <div class="rg-story-meta"><span data-i18n="ui.sec.session_remaining">Timer: stops Play automatically — remaining:</span> <span id="rg-sec-session-remaining">off</span></div>
          <div class="rg-field">
            <label for="rg-sec-coffee-interval" data-i18n="ui.sec.coffee_interval">Coffee break every (min)</label>
            <input id="rg-sec-coffee-interval" type="text" inputmode="numeric" autocomplete="off" value="0" />
          </div>
          <div class="rg-field">
            <label for="rg-sec-coffee-duration" data-i18n="ui.sec.coffee_duration">Coffee break duration (min)</label>
            <input id="rg-sec-coffee-duration" type="text" inputmode="numeric" autocomplete="off" value="5" />
          </div>
          <div class="rg-field">
            <label for="rg-sec-coffee-tolerance" data-i18n="ui.sec.coffee_tolerance">Pause tolerance (min)</label>
            <input id="rg-sec-coffee-tolerance" type="text" inputmode="numeric" autocomplete="off" value="2" />
          </div>
          <div class="rg-story-meta" data-i18n="ui.sec.coffee_tolerance_hint">Each coffee/admin hold is randomized within duration ± tolerance (min 0.5)</div>
          <div class="rg-story-meta"><span data-i18n="ui.sec.coffee_status">Coffee break: goes to nearest portal and stops —</span> <span id="rg-sec-coffee-status">off</span></div>
          <div class="rg-story-meta" data-i18n="ui.sec.map_flee_hint">Map: flee to nearest allied portal</div>
          <div class="rg-story-meta" data-i18n="ui.sec.raid_flee_hint">Raid: flee to a side, hold until HP 100%, then attack</div>
          <div class="rg-story-meta"><span data-i18n="ui.sec.deaths_session">Session deaths:</span> <span id="rg-sec-death-count">0</span></div>
        </div>
      </div>

      <div class="rg-tab-panel" data-tab="settings">
        <div class="rg-group">
          <div class="rg-group-title" data-i18n="ui.settings.ui_zoom">App UI zoom</div>
          <div class="rg-field rg-zoom-field">
            <label for="rg-settings-zoom"><span id="rg-settings-zoom-label" data-i18n="ui.settings.ui_zoom">App UI zoom</span>: <strong id="rg-settings-zoom-value">100%</strong></label>
            <input id="rg-settings-zoom" type="range" min="75" max="125" step="5" value="100" />
          </div>
          <div class="rg-story-meta" id="rg-settings-zoom-hint" data-i18n="ui.settings.ui_zoom_hint">Scales only the Bastion panel — not the game canvas</div>
        </div>
        <div class="rg-group">
          <div class="rg-group-title" data-i18n="ui.settings.discord">Discord webhook</div>
          <div class="rg-mode-actions">
            <button id="rg-discord-enabled" type="button" class="rg-mode-toggle" data-i18n="ui.settings.discord_enable">Enable webhook</button>
            <button id="rg-discord-status-notify" type="button" class="rg-mode-toggle" data-i18n="ui.settings.discord_status_notify">Notify status line</button>
          </div>
          <div class="rg-field">
            <label for="rg-discord-webhook-url" data-i18n="ui.settings.discord_url">Webhook URL</label>
            <div class="rg-license-actions rg-discord-url-actions">
              <input id="rg-discord-webhook-url" type="text" inputmode="url" autocomplete="off" spellcheck="false" data-i18n-placeholder="ui.settings.discord_url_placeholder" placeholder="https://discord.com/api/webhooks/…" />
              <button id="rg-discord-webhook-paste" type="button" class="secondary" data-i18n="ui.paste">Paste</button>
            </div>
          </div>
          <div class="rg-field">
            <label for="rg-discord-interval" data-i18n="ui.settings.discord_interval">Stats interval (min)</label>
            <input id="rg-discord-interval" type="number" min="0" max="180" step="1" inputmode="numeric" value="5" />
          </div>
          <div class="rg-story-meta" data-i18n="ui.settings.discord_interval_hint">0 = no periodic stats; status notifications still work if enabled</div>
          <div class="rg-mode-actions" style="margin-top:8px">
            <button id="rg-discord-test" type="button" class="secondary" data-i18n="ui.settings.discord_test">Test webhook</button>
          </div>
          <div id="rg-discord-webhook-status" class="rg-story-meta"></div>
          <div class="rg-story-meta" data-i18n="ui.settings.discord_hint">Sends status updates and session stats (kills, loot, XP, credits) to your Discord channel</div>
        </div>
        <div id="rg-license-card" class="rg-group rg-license-card">
          <div class="rg-group-title" data-i18n="ui.license">License</div>
          <div class="rg-license-actions">
            <input id="rg-license-key" type="text" autocomplete="off" spellcheck="false" data-i18n-placeholder="ui.license.placeholder" placeholder="RG1.xxxxx.yyyyy" />
            <button id="rg-license-paste" type="button" class="secondary">Paste</button>
            <button id="rg-license-apply" type="button" class="auto">Activate</button>
          </div>
          <div id="rg-license-status" class="rg-story-meta" data-i18n="ui.license.required">License required</div>
          <div class="rg-field rg-locale-field">
            <label for="rg-locale-select" data-i18n="ui.language">Language</label>
            <select id="rg-locale-select"></select>
          </div>
          <div class="rg-device-field">
            <div class="rg-enhance-label" data-i18n="ui.device_id">Device ID</div>
            <div class="rg-device-row">
              <code id="rg-device-id" class="rg-device-code">—</code>
              <button id="rg-device-copy" type="button" class="secondary mini">Copy</button>
            </div>
            <div class="rg-story-meta" data-i18n="ui.device_id_hint">Send this ID when purchasing a license. Each key works on one device only.</div>
          </div>
          <div class="rg-group" style="margin-top:10px">
            <div class="rg-group-title" data-i18n="ui.game_update">Game update</div>
            <div class="rg-story-meta" data-i18n="ui.game_update_hint">Downloads official RedGalaxy web assets. Bastion autopilot/license stay under Bastion control.</div>
            <div class="rg-mode-actions" style="margin-top:8px">
              <button id="rg-game-update" type="button" class="auto" data-i18n="ui.game_update_btn">Update game</button>
            </div>
            <div id="rg-game-update-status" class="rg-story-meta"></div>
          </div>
          <div class="rg-group" style="margin-top:10px">
            <div class="rg-group-title" data-i18n="ui.bastion_update">Bastion update</div>
            <div class="rg-story-meta" data-i18n="ui.bastion_update_hint">Download a newer Bastion host (DMG/exe). Separate from game assets.</div>
            <div class="rg-story-meta" id="rg-bastion-version-label"></div>
            <div class="rg-mode-actions" style="margin-top:8px">
              <button id="rg-bastion-update" type="button" class="auto" data-i18n="ui.bastion_update_btn">Update Bastion</button>
            </div>
            <div id="rg-bastion-update-status" class="rg-story-meta"></div>
          </div>
        </div>
      </div>
      </div>
      </div>
    `;
    document.body.appendChild(panel);

    panel.querySelectorAll(".rg-tab").forEach((btn) => {
      btn.addEventListener("click", () => switchPanelTab(btn.dataset.tab));
    });

    bindSecurityPanelEvents();
    initSecurityPanelValues();
    syncSecurityPanelFromAuto();
    installSocialChatAdminHook();

    document.getElementById("rg-panel-minimize").addEventListener("click", (ev) => {
      ev.stopPropagation();
      togglePanelMinimized();
    });
    initUiZoomControls();
    initDiscordWebhookControls();
    initPanelOrbDrag();

    document.getElementById("rg-orb-play")?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      startPlay();
    });
    document.getElementById("rg-orb-pause")?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      togglePausePlay();
    });
    document.getElementById("rg-orb-stop")?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      stopAll();
    });

    document.getElementById("rg-story-play-main").addEventListener("click", startPlay);
    document.getElementById("rg-mode-collect-bonus").addEventListener("click", () => toggleCollectOption("bonus"));
    document.getElementById("rg-mode-collect-cargo").addEventListener("click", () => toggleCollectOption("cargo"));
    document.getElementById("rg-mode-collect-booty").addEventListener("click", () => toggleCollectOption("booty"));
    document.getElementById("rg-sec-auto-booty-key")?.addEventListener("click", toggleAutoBuyBootyKeys);
    document.getElementById("rg-refinery-sell").addEventListener("click", () => toggleRefineryOption("sell"));
    document.getElementById("rg-refinery-antimatter").addEventListener("click", () => toggleRefineryOption("antimatter"));
    document.getElementById("rg-refinery-refine").addEventListener("click", () => toggleRefineryOption("refine"));
    document.getElementById("rg-refinery-enhance").addEventListener("click", () => toggleRefineryOption("enhance"));
    panel.querySelectorAll("[data-refinery-category]").forEach((btn) => {
      btn.addEventListener("click", () => {
        toggleRefineryOption("ore", {
          category: btn.dataset.refineryCategory,
          ore: btn.dataset.refineryOre,
        });
      });
    });
    document.getElementById("rg-mode-attack").addEventListener("click", () => togglePlayMode("attack"));
    document.getElementById("rg-mode-orbit").addEventListener("click", toggleOrbitMode);
    document.getElementById("rg-mode-portal-drift")?.addEventListener("click", toggleOrbitPortalDrift);
    panel.querySelectorAll("[data-combat-ammo]").forEach((btn) => {
      btn.addEventListener("click", () => {
        toggleCombatAmmoType(btn.dataset.combatAmmo);
        const n = AUTO.selectedCombatAmmoTypes.size;
        setStatus(n > 0 ? `${n} tipo/i munizione selezionati` : "Munizioni: controllo manuale");
      });
    });
    panel.querySelectorAll("[data-combat-ammo-buy]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const qty = Number(btn.dataset.combatAmmoBuy) || 0;
        setCombatAmmoBuyQty(qty);
        setStatus(
          qty > 0
            ? `Auto-buy munizioni: ${qty} pack sotto ${COMBAT_AMMO_LOW_THRESHOLD}`
            : "Auto-buy munizioni disattivato"
        );
      });
    });
    updateAttackAmmoButtons();
    document.getElementById("rg-story-pause").addEventListener("click", togglePausePlay);
    document.getElementById("rg-story-stop").addEventListener("click", stopAll);
    document.getElementById("rg-npc-refresh").addEventListener("click", refreshNpcListUI);
    document.getElementById("rg-npc-select-all").addEventListener("click", () => {
      selectAllNpcTypes();
      setStatus("status.npc_selected", { count: AUTO.selectedNpcTypes.size });
    });
    document.getElementById("rg-npc-clear").addEventListener("click", () => {
      clearNpcTypeSelection();
      setStatus("status.npc_cleared");
    });

    document.getElementById("rg-working-map").addEventListener("change", (ev) => {
      if (AUTO.raidGateId) return;
      AUTO.workingMapId = ev.target.value || "";
    });
    document.getElementById("rg-raid-target").addEventListener("change", (ev) => {
      AUTO.raidGateId = ev.target.value || "";
      if (AUTO.raidGateId) {
        applyRaidGateNpcSelection(AUTO.raidGateId, { mergeVisible: isInRaidMap() });
      }
      updateMapConfigUI();
    });
    document.getElementById("rg-attack-config").addEventListener("change", (ev) => {
      AUTO.attackConfig = Number(ev.target.value) || 1;
    });
    document.getElementById("rg-roam-config").addEventListener("change", (ev) => {
      AUTO.roamConfig = Number(ev.target.value) || 2;
    });
    document.getElementById("rg-run-config").addEventListener("change", (ev) => {
      AUTO.runConfig = Number(ev.target.value) || 2;
    });
    document.getElementById("rg-executioner-config").addEventListener("change", (ev) => {
      AUTO.executionerConfig = Number(ev.target.value) || 2;
    });

    loadMapGraph().then(() => {
      syncCollectMasterFlag();
      updateGeneralPanel();
      updateStatisticsPanel();
      ensureUiLoop();
      ensureNpcListBuilt();
      updateModeButtons();
      updateMapConfigUI();
      buildLocaleSelect();
      ensureDeviceId().then(() => {
        updateLicenseUI();
        applyI18n();
        setStatus("ui.loading");
        loadStoredLicense().finally(() => {
          switchPanelTab(AUTO.licenseValid ? AUTO.activeTab : "settings");
          if (!AUTO.active && !state.running) setStatus("status.ready");
        });
      });
      waitForReadyStatus();
    });
  }

  async function loadScript(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`Script non trovato: ${url}`);
    return res.json();
  }

  function stopScript() {
    if (state.abortController) {
      state.abortController.abort();
      state.abortController = null;
    }
    state.running = false;
    if (!AUTO.active) setPlayControls(false);
  }

  async function waitForNavigation(signal) {
    while (NAV.active) {
      await sleep(350, signal);
    }
  }

  async function startScript(url) {
    if (state.running || AUTO.active) return;
    if (!(await ensureLicensed())) {
      enforceLicenseGate();
      return;
    }
    await loadMapGraph();
    const script = await loadScript(url || DEFAULT_SCRIPT);
    state.running = true;
    state.abortController = new AbortController();
    const signal = state.abortController.signal;
    setPlayControls(true);
    setStatus(`Story: ${script.title || script.id || "demo"}`);
    try {
      while (!signal.aborted) {
        if (getGameScene() && getShipPosition()) break;
        await sleep(400, signal);
      }
      for (const step of script.steps || []) {
        if (signal.aborted) break;
        if (step.type === "goto_map" || step.type === "travel_map") {
          const dest = step.map || step.target || step.to;
          startMapNavigation(dest);
          await waitForNavigation(signal);
        } else if (step.type === "goto_raid" || step.type === "travel_raid") {
          startRaidNavigation(step.gate || step.target || "void");
          await waitForNavigation(signal);
        } else if (step.type === "move") {
          setMoveTargetDirect(null, step.x, step.y);
          clickMinimapRandom();
          if (step.timeout_ms) await sleep(step.timeout_ms, signal);
        } else if (step.type === "wait") {
          await sleep(step.ms ?? 1000, signal);
        }
      }
      setStatus("Story completata");
    } finally {
      state.running = false;
      if (!AUTO.active) setPlayControls(false);
      state.abortController = null;
    }
  }

  window.RedGalaxyStory = {
    startPlay,
    startAuto,
    stopAuto,
    stopAll,
    start: startScript,
    stop: stopAll,
    clickMinimapRandom,
    clickMinimapAt: (worldX, worldY) => moveViaMinimap(worldX, worldY),
    moveViaMinimap,
    clickWorld,
    listBonusBoxes,
    listNpcs,
    listNpcTypes,
    listNpcsByType,
    selectNpcType: (type, selected = true) => {
      if (selected) AUTO.selectedNpcTypes.add(type);
      else AUTO.selectedNpcTypes.delete(type);
      refreshNpcListUI();
    },
    clearNpcSelection: clearNpcTypeSelection,
    toggleOrbit: toggleOrbitMode,
    attackSelected: startCombatFromSelection,
    stopCombat,
    getShipPosition,
    debugSnapshot,
    NPC_TYPES,
    getNpcKills: () => ({ ...AUTO.npcKillsByType }),
    getNpcKillTotal,
    getCurrentMap: getCurrentMapInfo,
    getCurrentMapId,
    formatMapLabel,
    resolveMapRef,
    listPortals: listRuntimePortals,
    listKnownMaps,
    findMapPath,
    navigateToMap: startMapNavigation,
    navigateToRaid: startRaidNavigation,
    stopNavigation,
    getSessionStats,
  };

  loadStoredLocale();
  buildPanel();
})();

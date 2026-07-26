#!/usr/bin/env node
/**
 * Genera chiavi licenza per RedGalaxy Story Autopilot.
 *
 * Uso (consigliato — usa automaticamente LICENSE_HMAC_SECRET da autopilot.js):
 *   node tools/story/generate_story_license.js 30 --device=RGD-0123ABCD4567EF89
 *   node tools/story/generate_story_license.js 30 --uid=cliente-123 --device=RGD-...
 *
 * NON usare RG_STORY_LICENSE_SECRET="tua-chiave" (placeholder): la chiave sembrerà
 * valida in terminale ma l'app la rifiuta (firma diversa dal secret embedded).
 *
 * Oppure con secret esplicito (deve coincidere con LICENSE_HMAC_SECRET nell'app):
 *   RG_STORY_LICENSE_SECRET="..." node tools/story/generate_story_license.js 30 --device=RGD-...
 *   (se diverso da autopilot.js serve --force-env)
 *
 * Verifica una chiave già generata:
 *   node tools/story/generate_story_license.js --verify='RG1....'
 *
 * --device: ID dispositivo del cliente (tab Sicurezza nell'app). La chiave funziona solo su quel PC.
 *
 * La stessa chiave segreta deve essere impostata in redgalaxy_story_autopilot.js
 * (LICENSE_HMAC_SECRET) prima della build.
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const AUTOPILOT_PATH = path.join(__dirname, "redgalaxy_story_autopilot.js");

function loadSecretFromAutopilot() {
  let src;
  try {
    src = fs.readFileSync(AUTOPILOT_PATH, "utf8");
  } catch (err) {
    return { secret: "", error: err.message };
  }
  const match = src.match(/const\s+LICENSE_HMAC_SECRET\s*=\s*"([^"]*)"/);
  if (!match) return { secret: "", error: "LICENSE_HMAC_SECRET non trovato in autopilot.js" };
  return { secret: match[1], error: null };
}

function resolveSecret() {
  const baked = loadSecretFromAutopilot();
  const fromEnv = String(process.env.RG_STORY_LICENSE_SECRET || "").trim();
  const forceEnv = process.argv.includes("--force-env");
  const placeholders = new Set([
    "",
    "tua-chiave",
    "your-secret",
    "CHANGE_ME",
    "CHANGE_ME_BEFORE_RELEASE",
    "secret",
    "test",
  ]);

  if (fromEnv && placeholders.has(fromEnv.toLowerCase())) {
    console.error(
      `ERRORE: RG_STORY_LICENSE_SECRET="${fromEnv}" è un placeholder, non il secret reale.`
    );
    console.error(
      "Genera così (usa automaticamente LICENSE_HMAC_SECRET da autopilot.js):"
    );
    console.error(
      "  node tools/story/generate_story_license.js 30 --uid=AVATAR --device=RGD-..."
    );
    process.exit(1);
  }

  if (fromEnv && baked.secret && fromEnv !== baked.secret && !forceEnv) {
    console.error("ERRORE: RG_STORY_LICENSE_SECRET non coincide con LICENSE_HMAC_SECRET in autopilot.js.");
    console.error("Le chiavi firmate con un secret diverso risultano INVALIDE nell'app (spesso lette come scadute/non valide).");
    console.error("Rimuovi la variabile d'ambiente, oppure usa --force-env solo se sai cosa fai.");
    console.error(`  env: ${fromEnv.slice(0, 8)}…`);
    console.error(`  autopilot: ${baked.secret.slice(0, 8)}…`);
    process.exit(1);
  }

  if (fromEnv) {
    return { secret: fromEnv, source: "env:RG_STORY_LICENSE_SECRET" };
  }
  if (baked.secret) {
    return { secret: baked.secret, source: "autopilot:LICENSE_HMAC_SECRET" };
  }
  return { secret: "", source: "", error: baked.error || "secret mancante" };
}

function signBody(secret, body) {
  return crypto.createHmac("sha256", secret).update(body, "utf8").digest("base64url");
}

function verifyKey(secret, rawKey) {
  const key = String(rawKey || "").trim().replace(/\s+/g, "");
  const parts = key.split(".");
  if (parts.length !== 3 || parts[0] !== "RG1") {
    return { ok: false, reason: "formato non valido (atteso RG1.body.sig)" };
  }
  const [, body, sig] = parts;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch (err) {
    return { ok: false, reason: `payload non decodificabile: ${err.message}` };
  }
  const expected = signBody(secret, body);
  if (expected !== sig) {
    return { ok: false, reason: "firma non valida (secret diverso da quello dell'app?)", payload };
  }
  return { ok: true, payload, body, sig };
}

const verifyArg = process.argv.find((arg) => arg.startsWith("--verify="));
const { secret, source, error: secretError } = resolveSecret();

if (!secret || secret === "CHANGE_ME_BEFORE_RELEASE") {
  console.error("Secret non disponibile.");
  if (secretError) console.error(secretError);
  console.error("Imposta RG_STORY_LICENSE_SECRET oppure configura LICENSE_HMAC_SECRET in redgalaxy_story_autopilot.js.");
  process.exit(1);
}

if (verifyArg) {
  const raw = verifyArg.slice("--verify=".length);
  const result = verifyKey(secret, raw);
  console.error(`Secret: ${source}`);
  if (!result.ok) {
    console.error(`FAIL: ${result.reason}`);
    if (result.payload) console.error("Payload:", JSON.stringify(result.payload));
    process.exit(1);
  }
  console.log("OK");
  console.error("Payload:", JSON.stringify(result.payload, null, 2));
  if (result.payload.exp) {
    console.error(`Valida fino: ${new Date(result.payload.exp * 1000).toISOString()}`);
  }
  process.exit(0);
}

const days = Number(process.argv[2] || 30);
const uidArg = process.argv.find((arg) => arg.startsWith("--uid="));
const deviceArg = process.argv.find((arg) => arg.startsWith("--device="));
const uid = uidArg ? uidArg.slice(6) : "";
const device = deviceArg ? deviceArg.slice(9).trim().toUpperCase() : "";

if (!Number.isFinite(days) || days <= 0) {
  console.error("Giorni non validi:", process.argv[2]);
  process.exit(1);
}

const now = Math.floor(Date.now() / 1000);
const payload = {
  v: 1,
  product: "redgalaxy-story",
  iat: now,
  exp: now + Math.floor(days * 86400),
};
if (uid) payload.uid = uid;
if (device) {
  if (!/^RGD-[A-F0-9]{16}$/.test(device)) {
    console.error("Device ID non valido (atteso RGD- seguito da 16 hex 0-9A-F):", device);
    process.exit(1);
  }
  payload.did = device;
}

const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
const sig = signBody(secret, body);
const key = `RG1.${body}.${sig}`;

console.log(key);
console.error(`Secret: ${source}`);
console.error(`Valida fino: ${new Date(payload.exp * 1000).toISOString()}`);
if (payload.did) console.error(`Dispositivo: ${payload.did}`);
else console.error("ATTENZIONE: chiave senza --device (funziona su qualsiasi PC)");

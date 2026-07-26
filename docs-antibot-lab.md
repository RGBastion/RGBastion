# RedGalaxy AntiBot Lab

Questo laboratorio serve a testare misure anti-bot senza creare un client che giochi al posto dell'utente.
Lavora su log, replay o dati sintetici; non clicca nel browser, non controlla il client e non si collega ai server.

## Uso rapido

Genera un dataset sintetico con due player umani e due profili bot:

```bash
./tools/redgalaxy_antibot_lab.py make-sample artifacts/antibot-sample.jsonl
```

Analizza il dataset:

```bash
./tools/redgalaxy_antibot_lab.py analyze artifacts/antibot-sample.jsonl
```

Output JSON:

```bash
./tools/redgalaxy_antibot_lab.py analyze artifacts/antibot-sample.jsonl --format json
```

## Schema eventi

Formato JSONL consigliato, un evento per riga:

```json
{"ts":"2026-07-06T10:00:03.250Z","user_id":"player123","type":"target_lock","target_name":"Raider","x":1000,"y":1200}
```

Campi supportati:

- `ts`, `timestamp` o `time`: ISO 8601, epoch secondi o epoch millisecondi.
- `user_id`, `player_id` o `account`.
- `type`, `event` o `action`.
- `x`, `y` per movimento.
- `target_name`, `npc_name` o `target`.
- `resource_type`, `mineral_type` o `box_type`.

Eventi utili:

- `move`
- `target_lock`
- `attack_start`
- `npc_kill`
- `box_collect`
- `mineral_collect`
- `login`
- `logout`

## Segnali analizzati

- Cadenza troppo regolare tra azioni utili.
- Reazioni target->attacco troppo rapide e con poco jitter.
- Velocita di movimento troppo costante.
- Percorsi ripetuti su griglia.
- Selezione target/risorse troppo stretta.
- Alto rate sostenuto di azioni.
- Mancanza di pause umane su finestre lunghe.

## Come usarlo lato sviluppo

1. Aggiungi telemetria server-side per gli eventi sopra.
2. Esporta JSONL o CSV per sessione/account.
3. Esegui `analyze`.
4. Usa il punteggio come segnale di triage, non come ban automatico.
5. Valida sempre con replay, review manuale o altri segnali antifrode.

La regola sana: questo tool produce indizi, non sentenze.

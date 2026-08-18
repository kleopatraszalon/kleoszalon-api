# VIR Transaction Trace Forensic Toolkit

## Cél

A Transaction Lifecycle & Traceability réteg nemcsak eseménynapló. A VIR minden fontos üzleti tranzakcióhoz olyan bizonyítási csomagot épít, amelyből visszamenőleg megállapítható:

- mi történt;
- milyen sorrendben történt;
- mely üzleti és technikai rekordok érintettek;
- melyik modul hozta létre az eseményt;
- ki vagy milyen rendszerfolyamat hajtotta végre;
- hol szakadt meg a folyamat;
- sértetlen-e a bizonyítási lánc;
- van-e SLA vagy integritási eltérés.

## Forensic Toolkit

### Risk score

A rendszer 0–100 kockázati pontszámot képez. Kritikus súlyú többek között:

- SHA-256 hash-chain sérülés;
- HMAC proof checkpoint sérülés vagy hiányzó production HMAC konfiguráció;
- broken trace;
- kritikus életút SLA-túllépés;
- NAV error/failed/rejected esemény.

Figyelmeztetés többek között:

- nem aktuális HMAC checkpoint;
- hosszú eseményköz;
- pénzügyi reversal/sztornó jelenléte.

### SLA

Alapértelmezett incomplete lifecycle SLA: 240 perc.

Konfiguráció:

`TRANSACTION_TRACE_SLA_MINUTES`

### Függőségi gráf

A gráf a trace gyökérrekordját, kapcsolt entitásait és az eseménysorrendi kapcsolatokat mutatja. Célja nem az üzleti adat módosítása, hanem a root-cause vizsgálat felgyorsítása.

### Proof package export

A `proof-package` JSON csomag tartalmazza:

- trace metadata;
- forensic assessment;
- graph;
- append-only eseménysor;
- entity registry;
- verification history;
- HMAC proof checkpoint history;
- SHA-256 manifest hash;
- ha konfigurált, HMAC-SHA256 manifest signature.

Formátumazonosító:

`KLEO-VIR-TRANSACTION-PROOF-PACKAGE-V1`

A csomag audit, incidensvizsgálat és kontrollált bizonyíték-átadás céljára használható.

## Watchdog

A digest watchdog 10 percenként ellenőrzi az elmúlt 30 nap releváns trace-eit.

A watchdog:

1. újraellenőrzi a hash-láncot;
2. ellenőrzi a HMAC checkpointot;
3. ellenőrzi az életút SLA-t;
4. detektálja a NAV és pénzügyi anomáliákat;
5. perzisztens alert rekordot hoz létre;
6. megszűnt eltérést automatikusan resolved állapotba tesz;
7. kritikus eltérésekről egyetlen összesített e-mail digestet küld cooldown mellett.

Nem küld külön e-mailt minden warning eseményről, így a historikus backfill nem okozhat riasztási vihart.

Konfiguráció:

`TRANSACTION_TRACE_ALERT_COOLDOWN_MINUTES=180`

## Release Control

A `business.transaction_trace` gate blocking.

NO-GO, ha:

- a trace/event/signature/watchdog séma hiányos;
- a HMAC secret nincs konfigurálva;
- az elmúlt 30 napban broken trace van;
- 20 percnél régebbi aktuális trace nincs aláírva;
- nyitott critical trace watchdog alert van.

## Admin eszközök

VIR → Pénzügy és pénztár → Tranzakció-életút

- trace keresés;
- 30 napos backfill;
- manuális watchdog;
- hash + HMAC verify;
- forensic risk score;
- anomálialista;
- függőségi gráf;
- proof package export;
- eseménytimeline;
- emberi/rendszer audit korreláció.

VIR → Beállítások és adminisztráció → Rendszerállapot

- 30 napos Transaction Trace Health;
- broken/incomplete/verified számok;
- HMAC állapot;
- unsigned current trace-ek;
- watchdog nyitott/kritikus alert számok;
- figyelmet igénylő trace-ek közvetlen megnyitása.

## Biztonsági elv

A `TRANSACTION_TRACE_HMAC_KEY` értéke kizárólag secret storage-ban tartható. Gitben, adatbázisban, auditlogban vagy proof package-ben nem szerepelhet.

A forensic eszközök üzleti adatot nem javítanak automatikusan. Diagnosztizálnak, rekonstruálnak, bizonyítanak és riasztanak.

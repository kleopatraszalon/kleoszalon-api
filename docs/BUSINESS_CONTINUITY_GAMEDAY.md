# Business Continuity GameDay / Disaster Recovery Drill Center

## Cél

A GameDay Center a VIR Resilience & Recovery rétegének gyakorló- és bizonyítási rendszere. A cél nem éles szolgáltatás leállítása, hanem a recovery folyamatok rendszeres, auditálható szimulációja.

**Biztonsági alapelv:** a GameDay `simulation only`. Nem hoz létre valódi Major Incident rekordot, nem aktivál éles change-freeze-et és nem állít le szolgáltatást.

## Folyamat

`Drill terv -> Szimuláció indítása -> Injectek -> Recovery runbook -> RTO/RPO mérés -> Verifikáció -> Független jóváhagyás -> Scorecard -> Improvement actions`

## Sablonok

Alapértelmezett gyakorlatok:

- Backup / Restore GameDay
- PostgreSQL kiesés GameDay
- Pénzügy / NAV degradáció GameDay
- Pénztár kiesés GameDay
- Foglalási rendszer kiesés GameDay
- Kommunikációs csatorna kiesés GameDay
- Teljes üzletmenet-folytonossági GameDay

A sablonok meghatározzák az alapértelmezett szolgáltatáskört, a periodicitást és a szimulációs injecteket.

## Service drill policy

A `continuity_service_drill_policy` minden aktív resilience service-hez minimum gyakorlási gyakoriságot rendel:

- Tier 1: 90 nap
- Tier 2: 180 nap
- Tier 3: 365 nap

A rendszer megkülönbözteti az `ok`, `due`, `overdue`, `never` readiness állapotokat.

## RTO/RPO snapshot

GameDay létrehozásakor a szolgáltatások aktuális Resilience & Recovery profiljából snapshot készül:

- target RTO
- target RPO
- service criticality
- service name

A gyakorlat alatt rögzíthető az observed RTO és observed RPO. Ez megőrzi a történeti bizonyíthatóságot akkor is, ha később a service profil célértéke változik.

## Runbook

A GameDay a `resilience_recovery_runbooks` aktív lépéseit materializálja külön `continuity_drill_steps` rekordokba. Így a valódi recovery és a gyakorlat ugyanazt a kontrollstruktúrát használja, de külön végrehajtási síkon.

Kötelező step `completed` állapota csak konkrét evidence mellett engedélyezett. Ezt alkalmazási validáció és PostgreSQL trigger is védi.

## Injectek

Az inject szimulált esemény vagy új információ, amelyet a gyakorlatvezető ad ki.

Állapot:

- `pending`
- `released`
- `acknowledged`

Acknowledgement csak legalább 10 karakteres válasz/döntés és konkrét evidence mellett lehetséges.

## Független lezárás

GameDay csak `verifying` állapotból zárható le, és:

- minden kötelező runbook step completed;
- minden service verified;
- minden inject acknowledged;
- lezárási note és evidence rendelkezésre áll;
- a jóváhagyó nem lehet azonos a drill ownerrel.

A két-személyes kontrollt alkalmazási validáció és DB-trigger is védi.

## Scorecard

100 pontos determinisztikus score:

- RTO megfelelés: 30 pont
- RPO megfelelés: 20 pont
- kötelező runbook step teljesítés: 20 pont
- service verification: 15 pont
- inject acknowledgement: 10 pont
- független jóváhagyás: 5 pont

Eredmény:

- `PASS`: >=85 pont és nincs Tier-1 kritikus RTO/RPO breach
- `CONDITIONAL`: 70-84.99 pont kritikus Tier-1 breach nélkül
- `FAIL`: <70 pont vagy Tier-1 RTO/RPO breach

Hiányzó RTO/RPO mérés Tier-1 szolgáltatásnál kritikus breachnek számít.

## Automatikus improvement actions

Lezáráskor automatikus javítóakció keletkezik:

- RTO túllépésre;
- RPO túllépésre;
- nem PASS scorecardra.

Az akciók életciklusa:

`open -> in_progress -> completed -> accepted`

Completed/accepted állapot evidence nélkül nem engedélyezett.

## Scheduler

A governance cycle naponta 07:10-kor fut `Europe/Budapest` időzónában.

Ha egy tervezett GameDay több mint 24 órája nem indult el, automatikus `Elmaradt GameDay indítás` improvement action keletkezik.

## System Health

A `Rendszerállapot` külön GameDay readiness panelen mutatja:

- aktív drill;
- lejárt service drill;
- elmaradt tervezett drill;
- 90 napos átlagpontszám;
- nyitott improvement action.

## Menü

`Statisztika és VIR -> Üzletmenet-folytonossági GameDay`

Frontend route:

`/finance/exception-command-center/gameday`

Backend base API:

`/api/transactions/notifications/gameday`

## Fő API-k

- `GET /summary`
- `GET /templates`
- `GET /service-readiness`
- `POST /governance-cycle`
- `GET /drills`
- `POST /drills`
- `GET /drills/:id`
- `POST /drills/:id/start`
- `POST /drills/:id/verification`
- `POST /drills/:id/complete`
- `POST /drills/:id/cancel`
- `PATCH /drills/:id/services/:serviceKey`
- `PATCH /drills/:id/steps/:serviceKey/:stepKey`
- `POST /drills/:id/injects/:injectId/release`
- `POST /drills/:id/injects/:injectId/ack`
- `PATCH /drills/:id/actions/:actionId`

## Adatmodell

- `continuity_drill_templates`
- `continuity_service_drill_policy`
- `continuity_drills`
- `continuity_drill_services`
- `continuity_drill_steps`
- `continuity_drill_injects`
- `continuity_drill_actions`
- `continuity_drill_events`

A `continuity_drill_events` append-only audit ledger.

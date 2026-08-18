# Resilience & Recovery Control

## Cél

A Resilience & Recovery réteg a Major Incident / War Room után következő üzletmenet-folytonossági kontroll. A rendszer nem csak azt bizonyítja, hogy egy súlyos incidens kezelve van, hanem azt is, hogy az érintett üzleti szolgáltatások helyreállítása RTO/RPO célok, runbookok, change-freeze és bizonyítékos verifikáció szerint történik.

## Automatikus működés

Aktív SEV1 vagy SEV2 Major Incident esetén a rendszer 3 percen belül:

1. recovery sessiont nyit;
2. az incidens forráskategóriái alapján kijelöli az érintett üzleti szolgáltatásokat;
3. minden szolgáltatáshoz recovery runbookot materializál;
4. automatikus change-freeze-et aktivál;
5. méri a szolgáltatásonkénti RTO és megfigyelt RPO állapotot.

A scheduler 3 percenként fut `Europe/Budapest` időzónában.

## Alapértelmezett business service profilok

- VIR core: Tier 1, RTO 30 perc, RPO 5 perc
- PostgreSQL: Tier 1, RTO 30 perc, RPO 5 perc
- Pénzügy és NAV: Tier 1, RTO 60 perc, RPO 15 perc
- Foglalás és munkalap: Tier 1, RTO 60 perc, RPO 15 perc
- Pénztár és checkout: Tier 1, RTO 30 perc, RPO 5 perc
- Készlet és beszerzés: Tier 2, RTO 120 perc, RPO 30 perc
- Kommunikáció: Tier 2, RTO 120 perc, RPO 60 perc
- Mobil alkalmazás: Tier 2, RTO 120 perc, RPO 60 perc

A profilok vezetői jogosultsággal módosíthatók.

## Recovery runbook

Minden érintett szolgáltatáshoz kötelező alaplépések:

1. Hatás és függőségek rögzítése
2. Adatintegritás védelme
3. Szolgáltatás helyreállítása
4. Technikai és üzleti verifikáció
5. Üzleti visszaigazolás

A kötelező lépés `completed` állapotához konkrét evidence szükséges. Ezt alkalmazási validáció és DB-trigger is védi.

## Change-freeze

Aktív SEV1/SEV2 alatt a rendszer automatikusan change-freeze rekordot tart fenn. Normál release a `business.resilience_recovery` Release Control gate miatt NO-GO.

Az ALL CLEAR után a freeze feloldódik. DB-trigger megakadályozza, hogy all-clear/closed recovery session mellett a scheduler vagy közvetlen adatbázis-művelet újraaktiválja.

## Emergency change override

Sürgős incidensjavító release esetén létrehozható exact-SHA override request.

Követelmények:

- release SHA/ref kötelező;
- legalább 10 karakteres indok;
- konkrét request evidence;
- 15–120 perces érvényesség;
- kijelölt Incident Commander;
- a kérelmező és jóváhagyó nem lehet ugyanaz a személy;
- approval evidence kötelező.

Az override kizárólag a megadott exact release ref change-freeze kontrollját fedi. A többi Release Control gate változatlanul kötelező, tehát az emergency override nem általános GO-kiskapu.

## ALL CLEAR

ALL CLEAR csak akkor adható ki, ha:

- a Major Incident `monitoring` vagy `resolved` állapotban van;
- van Incident Commander;
- minden kötelező recovery runbook lépés completed;
- minden érintett service state verified;
- nincs nyitott Critical/High War Room action;
- legalább 10 karakteres All Clear note és konkrét evidence áll rendelkezésre.

A rendszer az ALL CLEAR pillanatában kiszámítja az actual RTO-t és a legnagyobb megfigyelt RPO-t, majd feloldja a change-freeze-et.

## Adatmodell

- `resilience_service_profiles`
- `resilience_recovery_runbooks`
- `resilience_recovery_sessions`
- `resilience_recovery_service_state`
- `resilience_recovery_step_runs`
- `resilience_change_freezes`
- `resilience_emergency_change_overrides`
- `resilience_recovery_events`

A recovery event ledger append-only.

## API

Base:
`/api/transactions/notifications/exceptions/intelligence/resilience`

- `GET /summary`
- `GET /sessions`
- `POST /sync`
- `GET /services`
- `PUT /services/:serviceKey`
- `GET /sessions/:id`
- `PATCH /sessions/:id/services/:serviceKey`
- `PATCH /sessions/:id/steps/:serviceKey/:stepKey`
- `POST /sessions/:id/all-clear`
- `POST /freezes/:freezeId/overrides`
- `POST /freezes/:freezeId/overrides/:overrideId/decision`

## Vezetői felület

Menü:
`Statisztika és VIR -> Resilience & Recovery`

Route:
`/finance/exception-command-center/resilience`

A Rendszerállapot külön panelen mutatja az aktív freeze-eket, RTO/RPO sértéseket, nem verifikált szolgáltatásokat és függő emergency override kérelmeket.

## Release Control

Blocking gate:
`business.resilience_recovery`

Normál PASS feltétel: nincs aktív recovery session és nincs aktív change-freeze.

Emergency control PASS csak akkor lehetséges, ha minden aktív freeze-et az aktuális exact release SHA-ra érvényes, jóváhagyott és le nem járt kétkulcsos override fed. Ez önmagában nem módosítja más release gate-ek eredményét.

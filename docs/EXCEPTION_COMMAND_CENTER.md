# VIR Exception Command Center

## Cél

Az Exception Command Center a VIR központi vezetői eltérés- és incidenskezelő rétege. Nem különálló hibalista: a már létező pénzügyi, készlet-, beszerzési, NAV-, pénztár-, payroll-, kommunikációs, panasz-, process-integrity-, APM-, transaction-trace- és tárgyi eszköz kontrollokból tartós, felelőshöz és SLA-hoz rendelhető ügyet (`exception case`) képez.

Menü: **Statisztika és VIR → Exception Command Center**

Frontend route: `/finance/exception-command-center`

API base: `/api/transactions/notifications/exceptions`

## Automatikus működés

A backend `Europe/Budapest` időzónában 5 percenként futtatja a discovery/sync folyamatot. Az első futás az API indulása után automatikusan megtörténik. A frontend 60 másodpercenként frissíti a munkasort.

A discovery futás:

1. kiolvassa a támogatott források aktuális nyitott eltéréseit;
2. stabil `exception_key` alapján deduplikálja őket;
3. új case-t nyit vagy frissíti a meglévőt;
4. az SLA/routing szabály szerint csapathoz és határidőhöz rendeli;
5. növeli az occurrence countot, ha ugyanaz a forráseltérés új eseménnyel jelentkezik;
6. újranyitja a korábban megoldott ügyet, ha a hiba visszatér;
7. csak sikeresen ellenőrzött forrás esetén enged automatikus lezárást;
8. frissíti az SLA állapotot és prioritást;
9. kritikus / SLA-sértett ügyekből deduplikált e-mail digestet készít.

Az `EXCEPTION_CENTER_DISABLED=1` kizárólag vészleállításra használható; productionben alapértelmezetten kikapcsolva kell maradnia.

## Források

A Command Center jelenleg automatikusan aggregálja:

- `reconciliation_alert_events` – pénzügyi és stock reconciliation;
- `business_process_integrity_exceptions` – end-to-end üzleti lánc eltérések;
- `business_transaction_trace_alerts` – trace/hash/HMAC/SLA forensic anomáliák;
- `apm_alert_events` – infrastruktúra és üzleti APM riasztások;
- `nav_invoice_queue` – az aktuálisan hibás NAV számlák;
- `cash_register_shifts` – elavult nyitott / handover pending kasszaműszakok;
- `payroll_runs` – failed/error vagy elakadt számfejtések;
- `booking_communication_queue` – feloldatlan sikertelen kézbesítések;
- `operations_quality_records` (`module_key='complaints'`) – sürgős és SLA-közeli panaszok;
- `inventory_warehouse_balances` – negatív készletek;
- `purchase_orders` + `finance_invoices` – bevételezett rendelés kapcsolt bejövő számla nélkül;
- `fixed_asset_maintenance_plans` – lejárt tárgyi eszköz karbantartások.

A NAV-ra külön consistency reconciler fut. Ez nem azt nézi, hogy volt-e korábban failed rekord, hanem a számla **legutolsó tényleges NAV státuszát**. Ha az már nem `error/failed/rejected`, a régi NAV exception case konzisztencia-bizonyítékkal automatikusan lezárható.

## Case életciklus

Lehetséges státuszok:

- `open` – új / újranyitott ügy;
- `acknowledged` – vezető vagy felelős visszaigazolta;
- `in_progress` – javítás folyamatban;
- `waiting` – külső vagy üzleti függőségre vár;
- `snoozed` – időzítetten elhalasztva;
- `resolved` – megoldott;
- `dismissed` – dokumentált indokkal elutasított / nem releváns.

Minden státuszváltás, kiosztás, automatikus újranyitás/lezárás és megjegyzés az append-only `exception_case_events` naplóba kerül.

Lezárás (`resolved` vagy `dismissed`) csak dokumentált indokkal történhet. A frontend strukturált `resolution_evidence` objektumot is rögzít.

## SLA és prioritás

Az SLA kategóriánként és súlyosságonként állítható az UI-n.

SLA állapotok:

- `on_track` – határidőn belül;
- `at_risk` – az SLA utolsó 25%-ában;
- `breached` – határidő túllépve;
- `closed` – lezárt ügy.

A prioritás alapértéke súlyosságtól függ, és `at_risk`/`breached` állapotban emelkedik. A szerver a munkasort prioritás, súlyosság és SLA szerint rendezi.

## Alap routing mátrix

| Kategória | Csapat | Critical | High | Medium | Low | Auto-resolve |
|---|---|---:|---:|---:|---:|---|
| finance | finance | 30 p | 90 p | 240 p | 720 p | igen |
| nav | finance | 15 p | 30 p | 120 p | 480 p | igen |
| inventory | inventory | 45 p | 180 p | 480 p | 1440 p | igen |
| procurement | procurement | 120 p | 360 p | 720 p | 1440 p | igen |
| cashier | operations | 15 p | 45 p | 120 p | 480 p | igen |
| payroll | hr | 60 p | 180 p | 480 p | 1440 p | igen |
| communications | customer-care | 60 p | 180 p | 480 p | 1440 p | igen |
| complaints | customer-care | 60 p | 120 p | 240 p | 720 p | **nem** |
| trace | administration | 15 p | 45 p | 120 p | 480 p | igen |
| system | administration | 15 p | 60 p | 180 p | 720 p | igen |
| process | management | 30 p | 90 p | 240 p | 720 p | igen |
| assets | operations | 120 p | 360 p | 720 p | 1440 p | igen |

A panaszok szándékosan nem auto-resolve-olhatók: üzleti/vendégkezelési ügyet emberi döntés nélkül a rendszer nem zár le.

## Safe auto-resolve

Automatikus lezárás csak akkor történhet, ha:

- az adott routing szabály `auto_resolve=true`;
- a case aktív;
- a hozzá tartozó forrás a jelenlegi scanben **sikeresen ellenőrizhető volt**;
- ugyanaz az `exception_key` már nem szerepel az aktuális forráseltérések között.

Ha egy forrás lekérdezése hibát ad vagy a szükséges tábla nem érhető el, az adott source kimarad az auto-resolve körből. Így adatbázis- vagy integrációs kiesés nem tud hamis „megoldva” állapotot okozni.

## Értesítések

A critical ügyek és a high + breached ügyek admin/vezetői digestbe kerülnek. Ha a case felelőse e-mail-címmel van megadva, ő is címzett lehet.

`EXCEPTION_CENTER_ALERT_COOLDOWN_MINUTES` szabályozza az ismételt digest minimum időközét (alapérték 120 perc).

A kézbesítési próbák az `exception_case_notifications` táblában auditálódnak (`sent`, `failed`, `logged`).

## UI eszközök

A vezetői radar mutatja:

- kritikus ügyek;
- összes nyitott ügy;
- SLA-sértett és SLA-veszélyes ügyek;
- kiosztatlan ügyek;
- elmúlt 24 órában lezárt ügyek;
- MTTA (Mean Time To Acknowledge);
- MTTR (Mean Time To Resolve).

Az ügylista szűrhető státusz, súlyosság, kategória, SLA, telephely és szabad szöveg szerint. Van bulk acknowledge / in-progress művelet, CSV export, manuális sync, forrásmegnyitás, felelős/csapat kiosztás, megjegyzés, snooze és bizonyítékos lezárás.

## API

- `GET /summary`
- `GET /cases`
- `GET /cases/:id`
- `PATCH /cases/:id`
- `POST /cases/:id/comment`
- `POST /cases/bulk`
- `POST /sync`
- `POST /consistency`
- `GET /routing-rules`
- `PUT /routing-rules/:category`
- `GET /export.csv`

Minden endpoint management jogosultság mögött van.

## Adatvédelmi elv

A case csak a vizsgálathoz szükséges minimális forrásbizonyítékot tárolja. Személyes adatot nem másol indokolatlanul külön exception adattárba. A forrásrendszer marad a részletes üzleti rekord igazságforrása; a Command Center a navigációs hivatkozást és a szükséges diagnosztikai payloadot tárolja.

## Production elfogadási kritérium

Az Exception Command Center production-ready, ha:

1. a schema bootstrap sikeres;
2. a scheduler fut;
3. a collector source-ok állapota látható;
4. egy mesterséges teszteltérés case-t nyit;
5. ugyanaz az eltérés nem duplikálódik;
6. felelős és státusz auditálhatóan módosítható;
7. SLA breach működik;
8. a mechanikus eltérés forrásoldali javítás után auto-resolve-ol;
9. panasz nem záródik automatikusan;
10. a NAV consistency reconciler a legutolsó státusz alapján dönt;
11. e-mail delivery/logging bizonyíték rendelkezésre áll;
12. frontend strict typecheck/lint/test/build gate PASS.

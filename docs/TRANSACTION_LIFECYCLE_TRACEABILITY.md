# VIR Transaction Lifecycle & Traceability

## Cél

A VIR-ben egy üzleti tranzakció nem önálló rekordok halmaza, hanem bizonyítható életút. A rendszer célja, hogy egy munkalap, beszerzési rendelés, foglalás vagy számla teljes downstream folyamata egyetlen `trace_id` alatt visszakövethető és automatikusan ellenőrizhető legyen.

A modell három bizonyítási szintet használ:

1. **üzleti bizonyítás** – a kötelező láncszemek és kapcsolatok ténylegesen léteznek;
2. **adatbázis-bizonyítás** – minden új kulcsrekord-változás append-only eseményként bekerül a trace ledgerbe;
3. **kriptográfiai bizonyítás** – az események SHA-256 hash-láncot alkotnak, a trace aktuális checkpointja pedig adatbázison kívül tartott HMAC kulccsal aláírható.

## Gyökér tranzakciók

Támogatott root type-ok:

- `work_order`
- `purchase_order`
- `booking`
- `invoice`

A fő üzleti trace-ek:

### Work order lifecycle

`Foglalás → munkalap → fizetés → settlement → pénztár → pénzügyi tranzakció → számla → NAV → főkönyv`

### Procurement lifecycle

`Beszerzés → jóváhagyás → bevételezés → készlet → bejövő számla → könyvelés`

## Adatmodell

### `business_transaction_traces`

Egy üzleti tranzakció gyökérrekordja és aktuális proof állapota.

Fontos mezők:

- `trace_id`
- `root_type`
- `root_id`
- `location_id`
- `lifecycle_status`
- `integrity_status`
- `last_sequence`
- `last_hash`

### `business_transaction_entities`

A trace-hez tartozó konkrét adatbázis-entitások kapcsolótáblája.

Példák:

- appointment
- work order
- settlement
- payment
- financial movement
- invoice
- NAV queue record
- journal entry
- purchase order item
- receipt cost
- inventory movement

### `business_transaction_events`

Append-only eseménynapló.

Minden esemény tartalmazza:

- monoton `sequence` értéket;
- eseménytípust;
- entitástípust és azonosítót;
- modult;
- műveletet;
- időbélyeget;
- forrást;
- minimális, PII-szegény evidence JSON-t;
- `previous_hash` értéket;
- `event_hash` értéket.

A tábla UPDATE és DELETE műveleteit adatbázis-trigger tiltja.

## Automatikus adatbázis-capture

A `kleo_capture_business_transaction()` trigger automatikusan figyeli a következő kulcstáblákat, ha azok léteznek:

- `appointments`
- `work_orders`
- `work_order_payments`
- `work_order_settlements`
- `financial_movements`
- `finance_invoices`
- `nav_invoice_queue`
- `accounting_journal_entries`
- `purchase_orders`
- `purchase_order_items`
- `procurement_receipt_costs`
- `inventory_movements`

A trigger nem tárol teljes rekordmásolatot. Csak a bizonyításhoz szükséges státusz-, összeg-, kapcsolat- és dokumentumazonosító mezőket helyezi az evidence objektumba.

## Legacy backfill

A már meglévő VIR-adatoknál a rendszer automatikusan rekonstruálja a trace-et.

Munkalap esetén felkeresi:

- foglalás;
- work order;
- settlement;
- payment;
- financial movement;
- invoice;
- NAV queue;
- journal entry.

Beszerzésnél:

- purchase order;
- purchase order items;
- receipt cost;
- inventory movements;
- incoming invoice;
- journal entry.

A legacy rekonstrukció `snapshot` típusú bizonyítási eseményeket hoz létre, de nem írja át az eredeti üzleti rekordokat.

## SHA-256 hash chain

Minden esemény hash-e tartalmazza többek között:

- `trace_id`
- sequence
- előző esemény hash-e
- event type
- entity type / ID
- module / action
- occurred_at
- evidence
- metadata

Ezért egy esemény módosítása, törlése, beszúrása vagy sorrendváltozása megtöri a láncot.

A `business_transaction_verifications` minden ellenőrzés eredményét külön naplózza.

## HMAC proof checkpoint

A hash-lánc fölött a VIR külső kulccsal aláírt checkpointot készít.

Konfiguráció:

- `TRANSACTION_TRACE_HMAC_KEY`
- `TRANSACTION_TRACE_HMAC_KEY_ID`

A kulcsot kizárólag Render secretként kell tárolni. Nem kerülhet adatbázisba vagy Git repositoryba.

Az aláírt payload:

`KLEO-TRACE-PROOF-V1 | trace_id | last_sequence | last_hash`

Algoritmus:

`HMAC-SHA256`

Az aláírásokat a `business_transaction_proof_signatures` append-only tábla tárolja.

A signing worker 15 percenként aláírja az aktuális trace checkpointokat. Egy trace megnyitásakor vagy manuális verify esetén az aktuális checkpoint azonnal is aláírásra kerül.

## Release Control

A Release Control backend két üzleti blocking gate-et kezel:

- `business.process_integrity`
- `business.transaction_trace`

A `business.transaction_trace` csak akkor PASS, ha:

- a trace/event/signature runtime séma létezik;
- `TRANSACTION_TRACE_HMAC_KEY` konfigurált;
- az elmúlt 30 napban nincs `integrity_status='broken'` trace;
- nincs 20 percnél régebbi aktuális, aláíratlan trace.

Ellenkező esetben a release döntés fail-closed `NO-GO`.

## API

Base:

`/api/transactions/notifications/reconciliation/trace`

Végpontok:

- `GET /recent`
- `GET /search?q=`
- `POST /backfill`
- `GET /:root_type/:root_id`
- `POST /:root_type/:root_id/verify`
- `GET /:root_type/:root_id/signature`

A route management jogosultság mögött van.

## Frontend

Menü:

**Pénzügy és pénztár → Tranzakció-életút**

Route:

`/finance/transaction-trace`

A képernyő mutatja:

- trace ID;
- lifecycle státusz;
- hash-chain állapot;
- teljes üzleti lánc vizuális szakaszokkal;
- kapcsolt entitásokat;
- időrendi event timeline-t;
- event hash-eket;
- normál VIR auditlogból összekapcsolt emberi/rendszer műveleteket;
- legacy backfill és manuális verify lehetőséget.

## Biztonsági modell

A megoldás célja **tamper-evidence**, nem az adatbázis-adminisztrátor teljes kizárása. A védelmi rétegek egymásra épülnek:

1. append-only DB trigger;
2. esemény-szekvencia;
3. SHA-256 previous-hash láncolás;
4. külön verification history;
5. adatbázison kívüli HMAC secret;
6. Release Control fail-closed gate;
7. rendszer auditlog korreláció.

Egy DB-only támadó a külső HMAC kulcs nélkül nem tud érvényes aktuális proof checkpointot előállítani.

## Automatizálás

- 02:35 Europe/Budapest: legacy/recent trace backfill + hash-chain verification;
- 15 percenként: HMAC proof signing;
- trace megnyitásakor: aktuális hash verification + HMAC checkpoint;
- új üzleti rekord-változáskor: automatikus DB trigger event capture.

## Production követelmény

A funkció production-ready állapotához Renderen kötelező:

1. legalább 64 karakteres nagy entrópiájú `TRANSACTION_TRACE_HMAC_KEY`;
2. stabil `TRANSACTION_TRACE_HMAC_KEY_ID`;
3. Release Control `business.transaction_trace = PASS`;
4. 30 napos backfill első sikeres futása;
5. `broken = 0` a verification eredményekben.

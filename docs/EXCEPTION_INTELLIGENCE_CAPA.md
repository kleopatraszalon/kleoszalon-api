# VIR Exception Intelligence + CAPA

## Cél

Az Exception Command Center operatív case-kezelését két további kontrollréteg egészíti ki:

1. **Exception Intelligence** – ismétlődés, korreláció, hotspot, SLA és L1/L2/L3 eszkaláció.
2. **CAPA központ** – a tartósan visszatérő vagy többmodulos problémák javító/megelőző intézkedési workflow-ja.

A rendszer elemző és kontroll funkció. Nem enged autonóm vezetői döntést vagy automatikus CAPA-jóváhagyást.

## Exception Intelligence

### Automatikus ciklus

- 5 percenként, Europe/Budapest időzónában.
- A Command Center és consistency reconciler után fut.
- Minden 15 perces időablakhoz történeti snapshotot tárol.
- 08:00-kor reggeli és 19:30-kor esti executive briefet készít az admin címzetteknek.

### Eszkaláció

Alapértelmezett szabályok:

| Severity | L1 | L2 | L3 |
|---|---:|---:|---:|
| critical | 15 perc | 30 perc | 60 perc |
| high | 60 perc | 120 perc | 240 perc |
| medium | 240 perc | 480 perc | 960 perc |
| low | 720 perc | 1440 perc | 2880 perc |

- **L1**: első reakció / acknowledgement késik.
- **L2**: ügy életkora vagy SLA-sértés vezetői eszkalációt igényel.
- **L3**: executive eszkaláció; kritikus vagy tartósan SLA-sértett ügy.
- Az eszkaláció deduplikált case + occurrence + level alapon.
- Az eszkaláció a case append-only audit eseménytörténetébe is bekerül.

### Root-cause klaszterek

A motor négy determinisztikus klasztertípust használ:

- `trace` – ugyanahhoz a transaction trace-hez több forrásból érkezik eltérés;
- `entity` – ugyanaz az üzleti entitás több modulban hibás;
- `outbreak` – azonos telephely + kategória alatt legalább három aktív eltérés halmozódik;
- `recurrence` – ugyanaz az Exception legalább háromszor visszatér/újranyílik.

A klaszter root-cause hipotézist és vizsgálati irányt ad, de nem módosít automatikusan üzleti adatot.

### Vezetői mutatók

- Exception Health Score 0–100
- aktív / kritikus / SLA-sértett / kiosztatlan ügyek
- aktív root-cause klaszterek
- recurrence eventek
- telephelyi hotspotok
- napi created / resolved / critical / breached trend
- csapat MTTA / MTTR / SLA compliance
- felelősi MTTA / MTTR / SLA compliance

A felelősi mutatók operatív folyamat- és kapacitáskontrollra szolgálnak, nem automatikus dolgozói minősítésre.

## CAPA központ

### Automatikus javaslat

A rendszer CAPA-javaslatot készít, ha az aktív root-cause klaszter:

- `critical` vagy `high` súlyosságú; vagy
- `recurrence` / `outbreak` típusú.

A generált rekord tartalmazza:

- probléma-meghatározás;
- root-cause hipotézis;
- javasolt corrective action;
- javasolt preventive action;
- tervezett határidő.

### Human-in-the-loop workflow

`proposed → approved → in_progress → verification → verified`

Elutasítás engedélyezett a megfelelő állapotokból; auditált indok kötelező.

**Kritikus biztonsági szabályok:**

- automatikus CAPA csak `proposed` állapotban jöhet létre;
- approval emberi művelet;
- verified állapothoz legalább 10 karakteres verifikációs jegyzet szükséges;
- verified állapothoz strukturált verification evidence kötelező;
- minden státuszváltás append-only `exception_capa_events` auditnaplóba kerül.

## API

Base:

`/api/transactions/notifications/exceptions`

### Intelligence

- `GET /intelligence/dashboard`
- `POST /intelligence/run`
- `GET /intelligence/escalation-rules`
- `PUT /intelligence/escalation-rules/:severity`
- `POST /intelligence/brief/morning`
- `POST /intelligence/brief/evening`

### CAPA

- `GET /intelligence/capa/summary`
- `GET /intelligence/capa`
- `POST /intelligence/capa/sync`
- `GET /intelligence/capa/:id`
- `PATCH /intelligence/capa/:id`

Minden endpoint a parent routeren keresztül management (`admin` / `manager`) védelem alatt áll.

## VIR menü

**Statisztika és VIR** alatt:

1. AI vezetői asszisztens
2. Exception Command Center
3. Exception Intelligence
4. CAPA központ

## Release / UAT ellenőrzés

Minimum ellenőrizendő:

- Intelligence séma létrejön;
- scheduler egyszer indul;
- L1/L2/L3 deduplikáció működik;
- resolved/snoozed ügyet nem eszkalál;
- root-cause klaszterek stale állapotban resolved-ra váltanak;
- CAPA automatikusan csak proposed lehet;
- tiltott CAPA státuszváltás 409;
- verified evidence nélkül 400;
- admin/manager access; más szerepkör fail-closed;
- frontend route sorrendben a specifikus Intelligence/CAPA route a generic Exception route előtt van.

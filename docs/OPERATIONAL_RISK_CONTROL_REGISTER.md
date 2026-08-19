# Operational Risk & Control Register

## Cél

A modul a VIR vállalati kontrollláncának kockázati rétege. Nem egyszerű kockázatlista: a kockázat forrása, inherent és residual score-ja, appetite státusza, kontrolljai, kontrolltesztjei, KRI-jei és governance eseményei egyetlen auditálható életútban kezelhetők.

Kontrolllánc:

`Exception → CAPA → Major Incident → Resilience → GameDay → Operational Risk & Control → Exception`

## Automatikus risk források

A napi 07:25 Europe/Budapest governance cycle strukturális forrásból hoz létre/frissít kockázatot:

- critical/high, még nem verified/rejected CAPA;
- SEV1/SEV2 Major Incident, amíg nincs postmortem_closed/dismissed;
- lezárt recovery session, amely RTO vagy RPO célt sértett;
- az elmúlt 365 nap FAIL vagy CONDITIONAL GameDay eredménye.

Az automatikus sync kockázatot **nem fogad el és nem zár le**. A forrás megszűnése csak a source-linket oldja fel; maga a risk vezetői felülvizsgálatig megmarad.

## Risk scoring

- Likelihood: 1–5.
- Impact: 1–5.
- Inherent score: `likelihood × impact`, 1–25.
- Band: low 1–4, medium 5–9, high 10–15, critical 16–25.
- A kapcsolt enabled kontrollok legutóbbi effectiveness score-ja súlyozott átlagot képez.
- A kontrollhatás legfeljebb 80%-kal csökkentheti az inherent score-t; residual risk soha nem lesz mesterségesen nulla.
- Appetite state: `within`, ha residual ≤ appetite threshold, különben `outside`.

## Governance

Risk státuszok:

`identified → assessed / mitigating / monitoring → accepted / closed`

Elfogadás:

- független approver szükséges;
- approver nem lehet azonos a risk ownerrel;
- legalább 10 karakteres indok;
- evidence description;
- következő review legfeljebb 90 napon belül.

Lezárás csak akkor engedett, ha:

- residual score az appetite-on belül van;
- nincs open critical/high/SEV1/SEV2/FAIL source-link;
- nincs breached KRI;
- nincs 180 napnál régebben vagy soha nem tesztelt kapcsolt key control;
- closure note + evidence megvan.

A DB trigger fail-closed módon védi ezeket a szabályokat.

## Control catalogue

Alap key controlok:

- Release Control Center;
- Tranzakció-életút bizonyítás;
- Pénzügyi egyeztetés;
- Exception SLA governance;
- RBAC és scope boundary;
- Resilience / GameDay readiness;
- Backup / Restore proof.

Control mezők:

- preventive / detective / corrective;
- manual / automated / hybrid;
- frequency;
- key-control jelölés;
- design score;
- operating score;
- effectiveness score;
- utolsó/következő teszt;
- elvárt evidence.

Key control tesztet a control owner saját maga nem igazolhat. A teszthez jegyzet és evidence kötelező. A `operational_control_tests` append-only.

## KRI

Minden riskhez tetszőleges KRI rendelhető:

- max/min irány;
- warning threshold;
- breach threshold;
- unit;
- owner;
- mérési gyakoriság.

A KRI mérések append-only rekordok. A rendszer automatikusan `ok`, `warning` vagy `breached` állapotot számol.

## Risk → Exception bridge

5 percenként a bridge Exception case-t hoz létre/frissít az alábbiakból:

- high/critical residual, appetite feletti aktív risk;
- breached KRI;
- lejárt, 60% alatti vagy FAIL eredményű key control.

Ha az eltérés megszűnik, a bridge automatikusan resolved állapotba viszi a saját `source_type='operational-risk'` Exception case-ét. Ez zárja vissza a vállalati kontrollhurkot.

## API

Base path:

`/api/transactions/notifications/risk-register`

Fő endpointok:

- `GET /summary`
- `POST /sync`
- `POST /governance-cycle`
- `GET /risks`
- `POST /risks`
- `GET /risks/:id`
- `PATCH /risks/:id`
- `POST /risks/:id/controls/:controlId/link`
- `POST /risks/:id/kri`
- `GET /controls`
- `POST /controls`
- `PATCH /controls/:id`
- `POST /controls/:id/tests`
- `POST /kri/:id/measurements`

A route management-only (`admin`, `manager`) boundary mögött fut.

## UI

Menü:

`Statisztika és VIR → Operational Risk & Control Register`

Route:

`/finance/exception-command-center/risk-register`

A workspace tartalmaz:

- 5×5 heatmap;
- risk register listát;
- inherent → residual score vizualizációt;
- appetite státuszt;
- assessment/governance szerkesztést;
- control mappinget és control tesztet;
- KRI létrehozást és mérést;
- source chain megnyitást;
- audit timeline-t;
- control catalogue-ot.

A System Health külön Operational Risk & Control readiness panelt kap.

## Audit és megőrzés

Append-only:

- `operational_risk_events`;
- `operational_control_tests`;
- `operational_kri_measurements`.

A risk/control/KRI aktuális törzsállapot módosítható, de a bizonyítási események és teszteredmények utólag nem írhatók át vagy törölhetők alkalmazási adatbázis-művelettel.

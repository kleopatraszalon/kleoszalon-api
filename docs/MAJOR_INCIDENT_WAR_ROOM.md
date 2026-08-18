# Major Incident / War Room

## Cél

A Major Incident / War Room réteg az Exception Command Center és Exception Intelligence fölött működő vezetői incidenskezelési kontroll. A rendszer automatikusan felismeri a több forrásból vagy több modulból összekapcsolható súlyos eltéréseket, impact score-t számol, és SEV1/SEV2 szinten Major Incidentet deklarál.

Az automatika felismer, korrelál, deklarál, riaszt és idővonalat nyit. Nem hoz autonóm üzleti döntést, nem küld automatikus külső ügyfél/stakeholder kommunikációt, nem jelöl ki önkényesen incident commandert, és nem zár le Major Incidentet emberi bizonyíték/post-mortem nélkül.

## Automatikus deklarálás

Forrás: aktív `exception_root_cause_clusters` rekordok.

Impact score összetevők:
- cluster súlyosság;
- kapcsolt Exception case-ek száma;
- különböző forrásmodulok száma;
- recurrence / outbreak minta;
- pénzügy, NAV, pénztár, trace, system vagy process érintettség.

Besorolás:
- `SEV1`: impact score >= 80;
- `SEV2`: impact score >= 60;
- 60 alatti klaszterből nem nyílik automatikusan Major Incident.

A detektor 3 percenként fut Europe/Budapest időzónában.

## War Room heartbeat watchdog

A watchdog 5 percenként ellenőrzi az aktív SEV1/SEV2 incidenseket.

Riasztási szabályok:
- SEV1 commander hiány: 15 perc;
- SEV2 commander hiány: 30 perc;
- SEV1 War Room update freshness: maximum 30 perc;
- SEV2 War Room update freshness: maximum 60 perc;
- lejárt Critical/High War Room akció: azonnal riasztási jelölt.

A watchdog riasztások 60 perces deduplikációs ablakkal készülnek, bekerülnek az append-only incident event logba és a belső vezetői e-mail auditba.

## War Room szerepkörök

- Incident Commander: az incidens döntési és koordinációs felelőse.
- Technical Lead: technikai/folyamat-helyreállítás szakmai felelőse.
- Communications Lead: belső/vezetői/stakeholder kommunikáció koordinátora.

A rendszer incident commander nélkül deklarálhat Major Incidentet, de ember által indított mitigáció/feloldás/post-mortem lezárás commander nélkül fail-closed.

## Életciklus

`open -> mitigating -> monitoring -> resolved -> postmortem_closed`

Alternatív ágak:
- `open -> dismissed`
- `mitigating -> open`
- `monitoring -> mitigating`
- `resolved -> monitoring`
- `dismissed -> open`

Ha a forrás root-cause klaszter megszűnik, a rendszer automatikusan legfeljebb `monitoring` állapotba léptethet. Automatikus `resolved` vagy `postmortem_closed` nincs.

## War Room action board

Minden akció rendelkezhet prioritással, felelőssel és határidővel. `done` állapothoz konkrét `completion_evidence.description` szükséges. Ezt az alkalmazási réteg és DB-trigger is ellenőrzi.

## Feloldás és post-mortem

`resolved` státuszhoz kötelező:
- legalább 10 karakteres resolution note;
- legalább 5 karakteres konkrét resolution evidence leírás;
- incident commander.

`postmortem_closed` státuszhoz ezen felül kötelező:
- root cause;
- impact summary;
- lessons learned;
- follow-up actions.

A Major Incident eseménytörténet és War Room update napló append-only.

## Kommunikáció

SEV1/SEV2 deklarálás és súlyosság-emelkedés esetén a rendszer a konfigurált admin/vezetői címzetteknek belső riasztást küld. A War Room `stakeholder` update naplóbejegyzés, nem automatikus külső üzenetküldés.

## Release Control policy

A `business.major_incident` blocking gate a Release Control része.

NO-GO:
- bármely SEV1, amíg nincs `postmortem_closed` vagy `dismissed` állapotban;
- SEV2 `open`, `mitigating` vagy `monitoring` állapotban;
- aktív SEV1/SEV2 incidenshez tartozó lejárt Critical/High War Room akció.

A SEV1 szabály szándékosan a post-mortem lezárásig tartja a kaput zárva, hogy kritikus incidens után ne lehessen bizonyíték és tanulság-rögzítés nélkül új release-t GO-ra állítani.

## API

Base:
`/api/transactions/notifications/exceptions/intelligence/major-incidents`

- `GET /summary`
- `GET /`
- `POST /sync`
- `POST /watchdog`
- `GET /:id`
- `PATCH /:id`
- `POST /:id/actions`
- `PATCH /:id/actions/:actionId`
- `POST /:id/updates`

A teljes route management-only, mert a `/notifications/exceptions` router `requireManagement` védelem alatt fut.

## Vezetői felület

Menü:
`Statisztika és VIR -> Major Incident / War Room`

Route:
`/finance/exception-command-center/major-incidents`

A Rendszerállapot külön War Room readiness panelen mutatja:
- SEV1 aktív;
- SEV2 aktív;
- commander hiány;
- lejárt akció;
- post-mortem backlog.

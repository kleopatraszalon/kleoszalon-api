# KLEO operatív kiegészítő nyomonkövetési mátrix

Az eredeti SRS v2 tesztelhető baseline **31 követelményt és 62 elfogadási kritériumot** tartalmaz. A működő VIR és az éles release-folyamat auditja további **19 kötelező követelményt és 38 elfogadási kritériumot** azonosított.

**Összesített KLEO baseline: 50 követelmény / 100 elfogadási kritérium.**

A részletes Given–When–Then kritériumok és a `TC-*` teszteset-azonosítók forrása: `catalog.operational.cjs`. A fájl `npm run requirements:matrix` futtatásakor újragenerálható.

| Követelmény | Terület | Miért kellett hozzáadni? |
|---|---|---|
| KLEO-FUN-BOOK-004 | Foglalás | A működő hangalapú foglalásnak nem volt baseline-követelménye. |
| KLEO-FUN-WO-003 | Munkalap | A létrehozás/állapotgép megvolt, a lezárás előfeltételei és véglegessége nem. |
| KLEO-FUN-FIN-003 | Pénzügy | A munkalaphoz kötött részfizetés és settlement integritása hiányzott. |
| KLEO-FUN-FIN-004 | Pénzügy | A kimenő számla és NAV Online Számla életciklus nem szerepelt. |
| KLEO-FUN-PROC-001 | Beszerzés | A rendelési javaslat–jóváhagyás–küldés workflow hiányzott. |
| KLEO-FUN-PROC-002 | Beszerzés | A bevételezés és bejövő számla közötti kapcsolati integritás hiányzott. |
| KLEO-FUN-PAY-001 | Bérszámfejtés | A tényleges havi bérszámfejtési modul nem volt lefedve. |
| KLEO-FUN-PAY-002 | Bérszámfejtés | Bérjegyzék PDF és kézbesítési napló nem volt lefedve. |
| KLEO-FUN-ACC-001 | Könyvelés | Kettős könyvvitel és idempotens főkönyvi feladás hiányzott. |
| KLEO-FUN-NOT-001 | Értesítések | Értesítési deduplikáció, olvasottság és címzetti izoláció hiányzott. |
| KLEO-FUN-COMM-001 | Panaszkezelés | Dedikált panaszpostafiók automatikus, idempotens feldolgozása hiányzott. |
| KLEO-NFR-SEC-004 | Biztonság | Szerveroldali RBAC és telephely-szegregáció nem volt önálló fail-closed követelmény. |
| KLEO-NFR-PRV-001 | Adatvédelem | GDPR érintetti jogok teljesítésének bizonyíthatósága hiányzott. |
| KLEO-NFR-PRV-002 | Adatvédelem | Retention és hozzájárulás-visszavonás nem volt mérhetően szabályozva. |
| KLEO-NFR-OPS-001 | Üzemeltetés | System health és release readiness kapu nem volt baseline-követelmény. |
| KLEO-NFR-BCK-001 | Üzemeltetés | Backup/restore próba és RPO/RTO bizonyíték hiányzott. |
| KLEO-NFR-PERF-001 | Teljesítmény | Nem volt számszerű p95 API/performance küszöb. |
| KLEO-NFR-IDEM-001 | Megbízhatóság | Kritikus írások ismétlés/párhuzamosság elleni általános idempotencia-követelménye hiányzott. |
| KLEO-NFR-REL-001 | Release | Adatbázis-migráció és hibás deploy visszaállíthatósága hiányzott. |

## UAT kapcsolat

A `20260816_UAT_KLEO_MAPPING_V3.sql` a korábbi 14 UAT-esetet kanonikus `KLEO-* → AC → TC` azonosítókhoz köti, és további runtime UAT-eseteket hoz létre a panaszmail, GDPR, backup/restore, teljesítmény, idempotencia és release-migráció ellenőrzésére.

A release gate csak kanonikus KLEO mapping és végrehajtási bizonyíték mellett tekinthető teljesnek.

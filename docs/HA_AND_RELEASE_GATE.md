# VIR – magas rendelkezésre állás és release-minőségkapu

## 1. Cél

A VIR alkalmazásoldali kódja ne függjön egyetlen API-példány helyi állapotától, és production kiadás csak sikeres automatikus tesztek, majd dokumentált emberi jóváhagyás után történhessen.

## 2. Magas rendelkezésre állás

A kódoldali előfeltételek elkészültek:

- a panasz e-mail csatolmányai PostgreSQL-ben (`bytea`) tárolódnak, nem egy Render instance lokális fájlrendszerén;
- az API health endpoint mellett külön `/api/health/ready` readiness endpoint van;
- a readiness válasz külön jelzi az API-példányszámot, az adatbázis HA állapotot és a `single_instance_failure_ready` értéket;
- a mailbox feldolgozás idempotens (`mailbox_key + imap_uid` unique), ezért több példány versenyhelyzetében ugyanaz a levél nem hozhat létre két panaszrekordot.

### Kötelező hosting-beállítások

A specifikáció szerinti „egy szerver leállását kibírja” követelmény csak akkor tekinthető teljesítettnek, ha a tényleges infrastruktúrán is teljesül mindegyik pont:

1. Legalább **2 aktív API instance** ugyanazon szolgáltatás mögött.
2. A load balancer automatikusan kiveszi a hibás instance-t a forgalomból.
3. A PostgreSQL szolgáltatás maga is magas rendelkezésre állású / automatikus failover-képes.
4. `RENDER_INSTANCE_COUNT` a tényleges példányszámot tükrözi.
5. `DATABASE_HA_ENABLED=1` csak akkor állítható be, ha az adatbázis redundancia ténylegesen aktív.
6. Production ellenőrzés: `GET /api/health/ready` válaszában `single_instance_failure_ready=true`.

A környezeti változók **nem hozzák létre** a redundanciát; csak a tényleges hosting-konfiguráció állapotát deklarálják a VIR felé.

## 3. Release quality gate

Mind az API, mind a frontend Render deploy workflow két egymás utáni kaput tartalmaz:

### Automatikus kapu

API:

- `npm ci`
- `npm test` – unit/contract/integration/UAT jellegű automata tesztek
- `npm run build` – TypeScript production build

Frontend:

- `npm ci`
- `CI=true npm test -- --watchAll=false`
- `CI=true npm run build`

Bármely hiba esetén a deploy job nem indulhat el.

### Manuális production kapu

A deploy job GitHub Environment neve:

`production-manual-approval`

A repository Settings → Environments alatt ehhez az environmenthez **Required reviewers** szabályt kell beállítani. Ettől kezdve a sikeres automatikus tesztek után a deployment emberi jóváhagyásra vár, és csak jóváhagyás után hívhatja meg a Render deploy hookot.

A VIR admin felületén a `Specifikáció-megfelelőségi központ → HA + release gate` fülön külön UAT sign-off rekord is rögzíthető. Ez auditnyomot ad a release/commit azonosítójáról, tesztelőről, eredményről és megjegyzésről.

## 4. Production release checklist

- [ ] API automatikus tesztek PASS
- [ ] API build PASS
- [ ] Frontend automatikus tesztek PASS
- [ ] Frontend build PASS
- [ ] Manuális UAT végrehajtva
- [ ] VIR UAT sign-off rögzítve
- [ ] GitHub `production-manual-approval` jóváhagyva
- [ ] Render deployment sikeres
- [ ] `/api/health` PASS
- [ ] `/api/health/ready` PASS
- [ ] Kritikus auth-boundary smoke PASS
- [ ] Ha HA-követelményt deklarálunk: `single_instance_failure_ready=true`

# VIR Business Process Integrity

## Cél

A VIR üzleti folyamatai nem önálló képernyők vagy lazán kapcsolt modulok. Egy üzleti esemény csak akkor tekinthető lezártnak, ha a teljes downstream lánc konzisztensen és auditálhatóan végigfutott.

A központi ellenőrző motor: `src/services/businessProcessIntegrity.ts`.

## Kontrollált láncok

### 1. Értékesítési / pénzügyi lánc

`Foglalás → munkalap → fizetés → settlement → pénztár → pénzügyi tranzakció → számla → NAV → főkönyv`

Kritikus invariánsok:

- a lezárt munkalaphoz tartozó foglalás/forrás kapcsolat megvan;
- a settlement lezárt;
- a nettó fizetett összeg egyezik a munkalap értékével;
- a fizetéshez pénzügyi mozgás tartozik;
- a fizetés nyitott/érvényes pénztári műszakhoz kapcsolódott;
- hivatalos, nem belső draft számla készült;
- a számla összege egyezik a munkalappal;
- a NAV queue legfrissebb állapota `done`;
- a számla főkönyvi tétele posted/approved, kiegyensúlyozott és összeghelyes.

Bármely kritikus eltérés esetén a folyamat `critical`.

### 2. Készletlánc

`nyitókészlet + bevételezés + átadás be − felhasználás − értékesítés − selejt − átadás ki ± korrekció = zárókészlet`

A rendszer raktár/termék szinten újraszámolja a várt zárókészletet a mozgásnaplóból, és összeveti a tényleges záró készlettel.

### 3. Beszerzési lánc

`Beszerzés → jóváhagyás → bevételezés → készlet → bejövő számla → könyvelés`

Kritikus invariánsok:

- csak jóváhagyott/automatikusan jóváhagyott rendelés kerülhet bevételezésre;
- a rendelési státusz és a tételenkénti received quantity egyezik;
- minden bevételezett tételhez azonos mennyiségű készletmozgás kapcsolható;
- a készletmozgás forrásrekordja tartósan a purchase orderhöz kötött;
- teljesen bevételezett rendeléshez bejövő számla tartozik;
- a bevételezési bruttó összeg és a kapcsolt bejövő számlák összege egyezik;
- a kapcsolt számlák főkönyvi tételei kiegyensúlyozottak és könyveltek.

A rendszer a korábbi `Beszerzési rendelés #<id>` megjegyzésű készletmozgásokat automatikusan visszaköti a `purchase_order` forrásrekordhoz, és az új mozgásoknál triggerrel fenntartja ezt a kapcsolatot.

### 4. Rendszer-invariánsok

A folyamatintegritási motor a modulok elérhetősége mellett üzleti adatminőségi szabályokat is ellenőriz:

- `nettó + ÁFA = bruttó` minden aktív számlán;
- Tartozik = Követel minden főkönyvi tételnél;
- nincs negatív raktári készlet;
- nincs előző napról nyitva maradt/elavult pénztári műszak;
- sikertelen kommunikációk láthatók;
- jóváhagyásra váró payroll futások láthatók.

## Fail-closed elv

A rendszer nem tekinti sikeresnek a folyamatot csak azért, mert a végső rekord létrejött. Ha bármely kötelező köztes kapcsolat hiányzik, az ellenőrzés eltérést jelez.

A `critical` állapot üzleti integritási hibát jelent. A `warning` olyan eltérés, amely nem feltétlenül sérti azonnal a könyvelési/készlet integritást, de vezetői beavatkozást igényel.

## Bizonyíték és történet

A futások a következő táblákba kerülnek:

- `business_process_integrity_runs`
- `business_process_integrity_exceptions`
- `financial_reconciliation_runs/items`
- `stock_reconciliation_runs/items`

A frontend a **Pénzügy és pénztár → Pénzügyi egyeztető központ → Folyamatintegritás** fülön jeleníti meg a folyamatokat és a központi kivétellistát.

## Automatizálás

A napi kontroll 02:20-kor, `Europe/Budapest` időzónában fut az előző üzleti napra:

1. pénzügyi reconciliation;
2. stock reconciliation;
3. end-to-end process integrity;
4. globális és telephelyenkénti bizonyíték mentése.

A backend indulás után egy kezdeti kontrollfutást is indít, ha a reconciliation nincs letiltva.

## Éles üzemi elfogadási szabály

Egy üzleti nap csak akkor tekinthető teljesen zártnak, ha:

- pénzügyi reconciliation = `ok`;
- stock reconciliation = `ok`;
- business process integrity = `ok`;
- NAV kötelezett számlák státusza `done`;
- nincs kiegyensúlyozatlan főkönyvi tétel;
- nincs negatív készlet;
- nincs elavult nyitott kasszaműszak.

## Release Control backend gate

A Release Control backend válaszát a `src/middleware/releaseControlProcessIntegrity.ts` szerveroldali gate egészíti ki a `/api/transactions/release-control` útvonalon.

A gate kulcsa: `business.process_integrity`.

A gate **blocking és nem szerkeszthető**. PASS csak akkor adható, ha az előző kontrollnap globális (`location_key='__all__'`) `business_process_integrity_runs` rekordja:

- létezik;
- `status = 'ok'`;
- `exception_count = 0`.

Minden más állapot fail-closed `NO-GO`:

- hiányzó séma;
- hiányzó globális futás;
- `warning` vagy `critical` folyamatállapot;
- bármilyen kivétel;
- adatbázis/ellenőrzési hiba.

A middleware a gate hozzáadása után szerveroldalon újraszámolja a `release_ready`, `decision`, `summary`, `blockers` és `gates` mezőket. Emiatt a frontend nem tudja egy hibás vagy hiányzó folyamatintegritási eredményt lokálisan GO állapotra felülírni.
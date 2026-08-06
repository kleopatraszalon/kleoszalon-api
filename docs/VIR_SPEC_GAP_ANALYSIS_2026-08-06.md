# Kleoszalon VIR – arculati és funkcionális megfelelési felmérés

**Felmérés dátuma:** 2026. augusztus 6.  
**Összehasonlítás alapja:** Arculati Kézikönyv; Kleoszalon Kft. Vállalatirányítási Rendszer – Szoftverfejlesztési Specifikáció v2; a backend és frontend `main` ágának aktuális állapota.

## Vezetői összefoglaló

A rendszer már nem prototípus: működik a belépés, az adatbázis-alapú és jogosultságfüggő menü, az időpontkezelés, az ügyfél-CRM, a munkatársi és HR-alapok, a munkaidő-beosztás, a vezetői műszerfal, a készlet és pénzügy több része, az adminisztratív jogosultságmátrix, valamint több riport. A specifikáció szerinti teljes vállalatirányítási rendszerhez azonban a meglévő részfunkciókat egységes, auditált üzleti folyamatokká kell összekapcsolni.

Ebben az etapban a korábbi plusz funkciók megmaradtak, és elkészült a specifikáció hiányzó területeit lefedő adatbázis-alapú modulkeret. Az új menük nem statikus „fejlesztés alatt” oldalak: kereshető, szűrhető, létrehozható, módosítható, inaktiválható és CSV-be exportálható rekordokat kezelnek, mezősémájuk pedig adatbázisból bővíthető. Minden művelethez auditbejegyzés és szerepköralapú jogosultság tartozik.

Ez fontos alap, de nem jelenti azt, hogy a specifikáció mind a 155 oldalának összes automatizmusa elkészült. A mély, több modult összekapcsoló folyamatok – például munkalap → fizetés → készletcsökkentés → jutalék → főkönyvi kimutatás – külön következő fejlesztési etapok.

## 1. Arculati megfelelés

### Kézikönyvi előírás

- Elsődleges arany árnyalatok: `#b69861`, `#c8b187`, `#d5c4a4`, `#e3d8c3`.
- Elsődleges fekete/szürke árnyalatok: `#120c08`, `#5d5a55`, `#84837e`, `#b0afad`.
- Kiemelő magenta árnyalatok: `#ec008c`, `#f173ac`, `#f59ac2`, `#f9c1d9`.
- Logó: eredeti arányban, torzítás, átrajzolás és zsúfolt háttér nélkül.
- Betűhasználat: logóban Gotham/Gotham Bold; digitális felületen Open Sans, Lato, Inter vagy Montserrat; normál betűköz, körülbelül 1,15-ös sorköz.

### Korábbi eltérések

- A menü aktív állapotát és több fő gombot lila szín jelölte, amely nem része a kézikönyvi palettának.
- Több egymással versengő globális színváltozó és árnyékstílus szerepelt a CSS-ben.
- A belépési oldal funkcionális volt, de nem adott prémium Kleopátra-hatást.
- A menücsoportok ikonhasználata és vizuális hierarchiája nem volt egységes.
- Kisebb felbontásokon több oldal saját, egymástól eltérő töréspontot használt.

### Ebben az etapban elvégzett arculati módosítás

- Bevezetésre került egy utolsóként betöltődő, központi Kleopátra brand-réteg a kézikönyv pontos HEX-színeivel.
- A lila navigációs kiemelést magenta, fekete és arany állapotok váltották fel.
- A sötét oldalsáv `#120c08` alapot, arany ikonokat és magenta aktív állapotot használ.
- Egységesítettük a gombok, mezők, fókuszállapotok, kártyák, táblák és modális ablakok megjelenését.
- A login felület prémium, reszponzív, arculati kártyás elrendezést kapott.
- Az új moduloldalak minden felbontáson átrendeződnek; a széles táblák vízszintesen görgethetők.
- A menücsoportok valódi, egységes Lucide ikonokat kaptak.

### Még szükséges arculati munka

1. A régi, oldalspecifikus inline stílusok fokozatos kiváltása közös komponensekkel.
2. A logóvariánsok központi asset-könyvtárba rendezése és minimális környezeti tér automatikus biztosítása.
3. Közös design tokenek használata minden naptár-, pénzügy-, HR- és készletoldalon.
4. WCAG 2.1 AA kontraszt-, billentyűzet- és képernyőolvasó teszt.
5. Mobil/tablet regressziós képernyőkép-tesztek legalább 375, 768, 1280 és 1920 px szélességen.

## 2. Funkcionális állapot és eltérések

| Terület | Jelenlegi állapot | Specifikáció szerinti további munka |
|---|---|---|
| Foglalás és naptár | Naptár, új időpont, munkatárs- és szolgáltatásválasztás, interaktív kezelés | intelligens szabadidőpont-ajánlás, komplex 4+ kezes kezelés, várólista, külső naptárszinkron, teljes értesítési automatika |
| Munkalap | Indítás és alapadatok részben működnek | kötelező állapotgép; szolgáltatás-, termék- és eszközfelhasználás; képesítés-ellenőrzés; lezárás/visszavonás; fizetési átadás |
| Ügyfél/CRM | Ügyféltörzs, adatlap, címkék, jegyzetek, előzmények, import | kérdőívek/nyilatkozatok verziózása, automatikus szegmentálás, kommunikációs napló, duplikációs jóváhagyási folyamat |
| Csapat és HR | Munkatársak, munkakörök, foglalkoztatási és béradatok, import, munkaidő | teljes képzési, toborzási, értékelési, szabadság- és jelenléti folyamat; jogszabályi szabálymotor; bérszámfejtési zárás |
| Pénzügy | műszerfali összesítések és több tranzakciós alap | kasszanyitás/zárás címletenként; bejövő/kimenő számla; előleg/kupon/egyenleg; visszatérítés; könyvelési és NAV-integráció |
| Logisztika | termék-, készlet- és mozgásalapok | szalon → központ → beszállító rendelési workflow; részszállítás; leltár; minimumkészlet; automatikus beszerzési javaslat |
| Panasz/minőség | új auditált panasz- és karbantartási modul | SLA, felelőshöz rendelés, értesítés, kapcsolt vendég/munkalap, jóváhagyás és lezárási bizonyíték |
| Kommunikáció | kampány- és értesítési alapok, új chat/e-mail nyilvántartás | valós idejű WebSocket chat, e-mail postafiók/integráció, sablonmotor, kézbesítési státusz és opt-out |
| Tudásbázis | új kereshető, kategorizált, verziózható alapmodul | dokumentumfeldolgozás, jogosultságos RAG-index, forráshivatkozásos AI-válasz, emberi jóváhagyás, visszajelzés |
| Riport/VIR | vezetői dashboard és riportküldési alapok | minden KPI egységes tényadata; szalon/szakma/munkatárs bontás; ütemezett PDF/Excel; jelentésszerkesztő; célértékek |
| Admin/jogosultság | szerepkör- és menüjogosultság mátrix | mezőszintű jog, jóváhagyási értékhatár, ideiglenes helyettesítés, rendszeres jogosultság-felülvizsgálat |

## 3. Most hozzáadott menük és működő modulalapok

### Működés és minőség

- Teendők és jóváhagyások
- Karbantartások és szervizek
- Elektronikus dokumentumtár
- Belső chat
- Belső e-mail
- Panaszkezelés

### Tudásbázis

- Tudásbázis
- Folyamatok és szabályzatok

### Törzsadatok

- Felhasználói csoportok
- Felhasználók
- Részlegek
- Szolgáltatástípusok
- Terméktípusok
- Eszközök és eszköztípusok
- Kedvezménytörzs
- Szabadságtípusok
- Mennyiségi egységek
- Ártípusok
- Raktárak
- Készletmozgás-típusok
- Pénzügyi tranzakciótípusok
- Vendégszámla-tranzakciótípusok

### Meglévő csoportok bővítése

- Csapat és HR: toborzás, képzések és képesítések, dolgozói értékelések.
- Pénzügy: bejövő számlák, kimenő számlák, vendégszámla-tranzakciók, egyenlegfeltöltés, pénztárnyitás/zárás/ellenőrzés.
- Raktár és készlet: üzleti és központi megrendelések, szalonhasználat.
- Kommunikáció és marketing: hírlevelek, napi akciók.
- Statisztika és VIR: profit, készletmozgás, elvárt bevétel, jelentésszerkesztő.

Az új modulkeret jelenlegi képességei:

- adatbázisból felépülő űrlapok és státuszlisták;
- keresés, státuszszűrés és összesítők;
- létrehozás, módosítás és indoklással végzett inaktiválás;
- telephely-hatókör;
- szerepkörönként külön megtekintés/létrehozás/módosítás/törlés/export jog;
- CSV-export;
- rekordváltozások teljes előtte/utána auditja;
- idempotens, életszerű tesztadatok.

## 4. Adatbázis-fejlesztés

### Most elkészült

- `vir_module_definitions`: adatbázisban bővíthető modul-, mező- és státuszdefiníció.
- `vir_module_records`: közös, telephelyhez rendelhető üzleti rekordtár JSONB részletes adatokkal.
- `vir_record_audit`: létrehozás, módosítás és inaktiválás előtte/utána állapota.
- GIN- és lekérdezési indexek, egyedi modul/azonosító-korlát.
- Menü- és jogosultság-seed, valamint idempotens mintarekordok.

### Következő normalizálási feladat

A közös rekordtár gyorsan tesztelhetővé és adminisztrálhatóvá teszi a hiányzó területeket. A nagy forgalmú vagy szigorú pénzügyi/jogi modulokat a következő etapban saját normalizált táblákra kell bontani:

1. `work_orders`, `work_order_services`, `work_order_products`, `work_order_assets`, `work_order_status_history`.
2. `payments`, `payment_allocations`, `cash_sessions`, `cash_counts`, `refunds`, `guest_ledger`.
3. `purchase_orders`, `purchase_order_lines`, `goods_receipts`, `stock_counts`, `stock_reservations`.
4. `employee_qualifications`, `training_events`, `performance_reviews`, `recruitment_applications`.
5. `complaints`, `complaint_actions`, `maintenance_jobs`, `task_dependencies`.
6. `knowledge_documents`, `knowledge_versions`, `knowledge_chunks`, `ai_answer_feedback`.
7. Közös `outbox_events` az e-mail/SMS/push/webhook megbízható és újrapróbálható kiküldéséhez.

Minden pénzügyi és készletet érintő állapotváltást egy adatbázis-tranzakcióban kell végrehajtani. A riportoknak ugyanezekből a ténytáblákból kell olvasniuk, hogy a műszerfal és az analitika ne térjen el az operatív adatoktól.

## 5. Javasolt megvalósítási sorrend

### Etap A – üzletileg zárt napi folyamat

Foglalás → érkezés → munkalap → szolgáltatás/termékfelhasználás → fizetés → készlet → jutalék → napi zárás. Ez adja a rendszer pénzügyi hitelességét.

### Etap B – HR és jogszabályi teljesség

Munkaidőkeret, pihenőidő, túlóra, távollét, jóváhagyás, jelenléti zárás, bér- és jutalékszámítás, képesítési korlátok.

### Etap C – logisztikai lánc

Minimumkészlet, igénylés, központi jóváhagyás, beszállítói rendelés, részérkeztetés, szalonba küldés, leltár és eltéréskezelés.

### Etap D – kommunikáció és AI

Valós idejű chat, e-mail és értesítési outbox; dokumentumfeltöltés; jogosultságos tudásindex; forráshivatkozásos AI-segéd; AI-művelet előtt emberi megerősítés.

### Etap E – vezetői döntéstámogatás

Egységes KPI-k, célértékek, szalon/szakma/munkatárs bontások, automatikus eltérésjelzés, mentett és ütemezett PDF/Excel riportok.

## 6. Élesítési minimumfeltételek

- A közvetlen Axios-függőség ebben az etapban `1.19.0` verzióra frissült. Az audit ennek ellenére a backend teljes függőségi fájában 18, a régi Create React App alapú frontend eszközláncban 361 tranzitív figyelmeztetést jelez. Ezek jelentős része build/dev eszköz, de a kritikus tételeket külön dependency-modernizációs PR-ban kell megszüntetni; automatikus `--force` frissítés éles rendszerhez nem elfogadható.
- automatikus migráció előtt teljes adatbázis-mentés és visszaállítási próba;
- staging környezetben a migráció kétszeri futtatása hiba és duplikáció nélkül;
- admin, manager, receptionist és employee szerepkör API-jogosultság tesztje;
- telephelyek közötti adatszivárgás elleni integrációs teszt;
- foglalás, munkalap, fizetés, készlet és bér kritikus E2E tesztek;
- auditnapló megváltoztathatatlansága és személyesadat-hozzáférések naplózása;
- reszponzív és hozzáférhetőségi regressziós teszt;
- Render health-check, migrációs log és rollback eljárás dokumentálása.

## 7. Döntés

Az elkészült etap megfelelő alapot ad arra, hogy a specifikációban szereplő menüszerkezet és adminisztrálható törzsadatok azonnal megjelenjenek, miközben a korábban elkészült Altegio-jellegű és extra funkciók változatlanul megmaradnak. A következő fejlesztési prioritás az **Etap A**, mert csak az egymással tranzakciósan összekötött napi üzleti folyamat után tekinthető a forgalom, készlet, jutalék és vezetői kimutatás teljesen hitelesnek.

# Kleoszalon VIR – arculati és funkcionális összevetés

Dátum: 2026. augusztus 6.

Források:

- `Arculati Kézikönyv-2.pdf` (10 oldal)
- `Kleoszalon Kft. Vállalatirányítási Rendszer – Szoftverfejlesztési Specifikáció v2` (155 oldal)
- a backend és frontend `main` ágának jelenlegi állapota

## Vezetői összefoglaló

A meglévő rendszer fontos, működő alapokat tartalmaz: adatbázis-alapú menü és jogosultsági mátrix, foglalás és naptár, CRM, munkatárs/HR, szerződés és bérezés, munkaidő, dashboard, webshop, kijelző és kioszk. Ezeket meg kell őrizni.

A specifikációhoz képest a legnagyobb hiány nem a menüpontok száma, hanem az, hogy több menü mögött csak statikus „fejlesztés alatt” oldal vagy nem mentett mintaadat állt. A jelen fejlesztési etap ezért közös, adatbázisba mentő modulmotort, állapotkezelést, audit-előzményt, tudásbázist, belső chatet és AI-asszisztenst ad a rendszerhez. A speciális üzleti szabályokat a következő domainekben tovább kell mélyíteni.

## Arculati eltérések és korrekciók

| Terület | Korábbi állapot | Kézikönyvi elvárás | Korrekció |
|---|---|---|---|
| Fő színek | több, egymással versengő lila/kék és színátmenet | sötétbarna `#120c08`, arany `#b69861`, magenta `#ec008c`, fehér | egységes, utolsóként betöltött brandréteg |
| Kiegészítő színek | eltérő szürkék és pasztellek | arany: `#c8b187`, `#d5c4a4`, `#e3d8c3`; szürke: `#5d5a55`, `#84837e`, `#b0afad`; magenta: `#f173ac`, `#f59ac2`, `#f9c1d9` | központi CSS-változók |
| Tipográfia | túlzott címbetűköz, eltérő súlyok | Montserrat/Open Sans, normál betűköz és 1,15-ös alap sortáv | egységes globális tipográfia |
| Logó | méret és környezet oldaltól függött | csak hivatalos arányban és színezéssel | `object-fit: contain`, szűrő és torzítás nélkül |
| Menü | lila aktív állapot, következetlen ikonok | sötétbarna alap, arany részletek, magenta kiemelés, egységes ikonok | adatbázis-ikonok megjelenítése, új aktív állapot |
| Bejelentkezés | régi, szögletes kártya | prémium, letisztult, arculathű felület | reszponzív, arany keret, magenta CTA, hivatalos logó |
| Reszponzivitás | több örökölt CSS-rendszer ütközött | minden támogatott felbontáson használható | közös felület-, kártya-, űrlap- és táblastílus |

## Funkcionális lefedettség

| Specifikációs terület | Meglévő, megtartandó funkció | Ebben az etapban hozzáadva | További mélyítés |
|---|---|---|---|
| Foglalás és naptár | foglalás, munkatárs/szolgáltatás, drag-and-drop naptár | meglévő működés változatlan | 4+ kezes erőforrásütközés, láncolt szolgáltatás teljes szabálymotorja |
| Munkalap | lista, létrehozás és részleges műveletek | menük megmaradnak | nyitott vendég miatti napzárási tiltás, teljes lezárási és visszavonási workflow |
| Pénzügy | dashboard és részleges pénzügyi oldalak | bevétel/kiadás, pénztár, bejövő/kimenő számla, fizetés és vendégegyenleg menthető workflow | NAV/számlázó integráció, valós pénztárnap, bizonylatlánc és devizaárfolyam |
| Raktár | terméklista és meglévő készletoldalak | rendelés, bevételezés, kiegészítés, átadás, beszerzés, korrekció és szalonhasználat menthető workflow | automatikus készletkönyvelés, tételsoros bizonylat és pénzügyi feladás |
| Ügyfelek és CRM | ügyféltörzs, profil, import és duplikációkezelés | meglévő funkciók megtartva | kérdőív-verziózás, hozzájárulások és teljes kommunikációs napló |
| Hűség | meglévő menük | hűségprogram, bérlet, ajándékkártya, kedvezmény és egyenleg menthető oldalak | tranzakciós szabálymotor és pénztári beváltás |
| HR és bér | munkatárs, munkakör, szerződés, bércsomag, jutalék, munkaidő és szabadság | álláshirdetés, jelentkezés, interjú/próbanap és értékelés | jogi validációk és külső bérszámfejtő feladás |
| Kommunikáció | meglévő marketing menük | hírlevél, napi akció, panasz, értékelés és moderáció | tényleges e-mail/SMS/WhatsApp/push szolgáltatók és kézbesítési napló |
| Működés | részleges extra menük | feladat, ismétlődés, műszak, jóváhagyás, belső chat és dokumentum | csatolmánytár, külső e-mail-fiók, értesítési szabálymotor |
| Statisztika és VIR | dashboardok és időzített riportok | profit-, készletmozgás-, elvártbevétel- és jelentésszerkesztő konfiguráció | lekérdezésépítő, PDF/XLSX sablonmotor és valós ütemezett kiküldés |
| Tudásbázis és AI | nem volt egységes modul | cikkek, kategóriák, címkék, verzió, keresés, AI-chat forrásjelöléssel | dokumentum-feldolgozás, jogosultsági dokumentumszűrés és értékelési visszacsatolás |

## Új adatbázis- és API-alap

- `vir_module_records`: egységes, telephelyezhető és bővíthető üzleti rekordok.
- `vir_record_history`: létrehozás, módosítás és archiválás előzménye.
- `vir_knowledge_articles`: verziózott, kereshető tudásbázis.
- `vir_conversations`, `vir_messages`: belső és AI-beszélgetések.
- `vir_settings`: központi vagy telephelyi alkalmazásbeállítások.
- `GET/POST/PATCH/DELETE /api/vir-modules/...`: kereshető, szűrhető, CSV-be exportálható moduladatok.
- Az új CRUD-, tudásbázis-, chat- és AI-végpontok a meglévő adminisztrációs jogosultsági mátrix `can_view`, `can_create`, `can_edit` és `can_delete` értékeit szerveroldalon is ellenőrzik.
- `POST /api/vir-modules/assistant`: OpenAI Responses API-val működő, tudásbázisra támaszkodó asszisztens. Kulcs hiányában biztonságos beállítási állapotot jelez.

Az új táblák és rekordok kiegészítő jellegűek; meglévő üzleti táblát vagy funkciót nem törölnek.

## Új adatbázis-alapú menük

- Működés és együttműködés
  - Teendők és jóváhagyások
  - Belső chat
  - Belső és külső e-mail
  - Elektronikus dokumentumok
- Tudásbázis és AI
  - Tudásbázis
  - Kleo AI asszisztens
- Pénzügy
  - Bevételek és kiadások
  - Pénztár nyitás, zárás és ellenőrzés
  - Bejövő és kimenő számlák
  - Fizetések és vendégszámla-tranzakciók
- Raktár
  - Megrendelés, bevételezés, kiegészítés, átadás, beszerzés, korrekció, szalonhasználat
- HR
  - Álláshirdetés, jelentkezés/kiválasztás, dolgozói értékelés
- Kommunikáció
  - Hírlevél, panasz, napi akció, értékelés/moderáció
- Statisztika és VIR
  - Profit, készletmozgás, elvárt bevétel, jelentésszerkesztő
- Törzsadatok és beállítások
  - részleg, eszköz, partner, mértékegység, ártípus, mozgástípus, fizetési mód, alkalmazásbeállítás

Minden új menü bekerül a meglévő adminisztrációs jogosultsági mátrixba, ezért szerepkörönként állítható a láthatóság és a műveleti jogosultság.

## Kötelező következő etapok

1. Pénzügyi és raktári workflow-k tételsoros, könyvelési szintű összekapcsolása.
2. Munkalap napzárási szabály és teljes visszavonási audit.
3. Hírlevél, külső e-mail, SMS/push és számlázó szolgáltatók bekötése.
4. Magyar–angol felület valódi fordítási katalógussal.
5. Offline/PWA működés és szinkronkonfliktus-kezelés.
6. Az API-szintű jogosultság-ellenőrzés kiterjesztése az összes örökölt végpontra is.
7. Automatikus unit-, integrációs és end-to-end tesztek a kritikus folyamatokra.
8. A teljes 155 oldalas specifikációhoz követelmény–teszteset nyomonkövetési mátrix.

## Élesítési feltételek

- backend és frontend production build hibamentes;
- migráció próbafuttatása staging adatbázison;
- admin, vezető, recepciós és munkatárs szerepkör smoke tesztje;
- foglalás, munkalap, pénztár, készlet és bér funkció regressziós tesztje;
- csak jóváhagyott PR merge után automatikus Render telepítés.

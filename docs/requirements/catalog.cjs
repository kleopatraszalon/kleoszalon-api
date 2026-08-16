'use strict';

const SOURCE_DOCUMENT = 'Kleoszalon Kft. Vállalatirányítási Rendszer – Szoftverfejlesztési Specifikáció v2';

function acceptance(requirementId, index, given, when, then, method = 'manual', automationStatus = 'planned', testRefs = []) {
  const suffix = String(index + 1).padStart(2, '0');
  const id = `${requirementId}-AC-${suffix}`;
  return {
    id,
    given,
    when,
    then,
    verification: {
      method,
      test_case_id: `TC-${id}`,
      automation_status: automationStatus,
      test_refs: testRefs,
      evidence_required: true,
    },
  };
}

function requirement({ id, area, title, page, section, statement, criteria, priority = 'must', ownerRole = 'Product Owner', lifecycleStatus = 'approved' }) {
  return {
    id,
    area,
    title,
    type: id.includes('-NFR-') ? 'non-functional' : 'functional',
    source: {
      document: SOURCE_DOCUMENT,
      version: '2',
      page,
      section,
    },
    priority,
    owner_role: ownerRole,
    lifecycle_status: lifecycleStatus,
    statement,
    acceptance_criteria: criteria.map((item, index) => acceptance(id, index, ...item)),
  };
}

module.exports = {
  schema_version: '1.0.0',
  baseline: {
    id: 'KLEO-SRS-V2-TESTABLE-BASELINE',
    approved_on: '2026-08-16',
    language: 'hu-HU',
    scope: 'A v2 specifikáció általános, főfolyamati és nemfunkcionális normatív alapkövetelményei.',
    completeness_note: 'A katalógus a tesztelhetőségi hiányt szünteti meg. A delivery- és automata tesztlefedettséget külön státusz és bizonyíték jelzi.',
  },
  id_policy: {
    pattern: 'KLEO-{GEN|FUN|NFR}-{TERÜLET}-{NNN}',
    immutable: true,
    reuse_forbidden: true,
    acceptance_pattern: '{KÖVETELMÉNY-ID}-AC-{NN}',
    test_case_pattern: 'TC-{ELFOGADÁSIKRITÉRIUM-ID}',
  },
  change_control: {
    pull_request_required: true,
    product_owner_approval_required: true,
    changed_requirement_requires_test_review: true,
    deprecated_ids_are_retained: true,
  },
  requirements: [
    requirement({
      id: 'KLEO-GEN-OPS-001', area: 'Általános működés', title: 'Napzárás csak lezárt vendégekkel', page: 41, section: 'III. Általános követelmények',
      statement: 'A rendszer csak akkor engedheti a nap lezárását, ha az adott üzleti naphoz nem tartozik lezáratlan vendég vagy munkafolyamat.',
      criteria: [
        ['Adott egy üzleti nap legalább egy lezáratlan vendéggel', 'A jogosult felhasználó napzárást indít', 'A rendszer megtagadja a zárást, megnevezi a blokkoló rekordot, és nem hoz létre zárási állapotot', 'integration'],
        ['Adott egy üzleti nap, amelynek minden vendége lezárt', 'A jogosult felhasználó napzárást indít', 'A rendszer pontosan egy zárási rekordot hoz létre időbélyeggel és a végrehajtó felhasználó azonosítójával', 'integration'],
      ],
    }),
    requirement({
      id: 'KLEO-GEN-UI-001', area: 'Általános működés', title: 'Szöveges mezők kezdőbetű-kezelése', page: 41, section: 'III. Általános követelmények',
      statement: 'A rendszer a név jellegű szöveges mezők első nem szóköz karakterét nagybetűsíti, miközben a felhasználó által bevitt vezető szóközt megőrzi.',
      criteria: [
        ['Adott egy név mező „  kovács” értékkel', 'A felhasználó elhagyja a mezőt vagy ment', 'A tárolt és visszaadott érték „  Kovács”, és a két vezető szóköz megmarad', 'unit'],
        ['Adott egy üres vagy csak szóközt tartalmazó név mező', 'A normalizálás lefut', 'A rendszer nem dob hibát és nem szúr be új karaktert', 'unit'],
      ],
    }),
    requirement({
      id: 'KLEO-GEN-SRCH-001', area: 'Általános működés', title: 'Keresési bemenet normalizálása', page: 41, section: 'III. Általános követelmények',
      statement: 'A rendszer a keresőkifejezés végéről eltávolítja a szóközöket és tabulátorokat, a szöveges összehasonlítást pedig kis- és nagybetűtől függetlenül végzi.',
      criteria: [
        ['Adott egy „Kovács   \t” keresőkifejezés és egy „kovács” nevű rekord', 'A felhasználó keresést indít', 'A találati halmaz tartalmazza a rekordot, és a lekérdezés normalizált értéke „Kovács”', 'integration'],
        ['Adott ugyanaz az adathalmaz', 'A felhasználó „KOVÁCS”, „Kovács” vagy „kovács” értékkel keres', 'Mindhárom keresés azonos rekordazonosító-halmazt ad vissza', 'integration'],
      ],
    }),
    requirement({
      id: 'KLEO-GEN-I18N-001', area: 'Általános működés', title: 'Magyar és angol felület', page: 41, section: 'III. Általános követelmények',
      statement: 'A rendszer felhasználói felülete legalább magyar és angol nyelven használható, és a kiválasztott nyelv az új munkamenetben is visszaállítható.',
      criteria: [
        ['Adott egy bejelentkezett felhasználó magyar felülettel', 'A nyelvet angolra állítja', 'A navigáció és az aktív oldal feliratai oldalfrissítés nélkül angolra váltanak', 'e2e'],
        ['Adott egy korábban angol nyelvet választó felhasználó', 'Új munkamenetet indít ugyanazon profillal', 'A rendszer angol felülettel indul, és nem kever magyar kulcsszöveget a navigációba', 'e2e'],
      ],
    }),
    requirement({
      id: 'KLEO-GEN-DATA-001', area: 'Általános működés', title: 'Logikai törlés', page: 41, section: 'III. Általános követelmények',
      statement: 'A rendszer üzleti rekordot normál felhasználói művelettel fizikailag nem törölhet; a rekordot inaktív állapotba helyezi és az alapértelmezett listákból elrejti.',
      criteria: [
        ['Adott egy aktív üzleti rekord', 'A jogosult felhasználó törlést vagy archiválást kér', 'A rekord megmarad az adatbázisban, inaktív állapotot kap, és az alapértelmezett listában nem jelenik meg', 'integration'],
        ['Adott egy inaktivált rekord', 'Egy jogosult auditor az archív nézetet megnyitja', 'A rekord az eredeti azonosítóval, inaktiválási idővel és végrehajtóval visszakereshető', 'integration'],
      ],
    }),
    requirement({
      id: 'KLEO-GEN-AUD-001', area: 'Általános működés', title: 'Részletes és kereshető auditnapló', page: 41, section: 'III. Általános követelmények',
      statement: 'A rendszer a biztonsági és üzleti műveletekhez változtathatatlan auditbejegyzést készít a végrehajtó, kliens, időpont, művelet, érintett rekord és előtte–utána érték rögzítésével.',
      criteria: [
        ['Adott egy hitelesített felhasználó, aki üzleti rekordot módosít', 'A mentés sikeresen lezárul', 'Pontosan egy auditbejegyzés készül felhasználó-, kliens-, idő-, művelet- és rekordazonosítóval, valamint előtte–utána értékkel', 'integration'],
        ['Adott több auditbejegyzés eltérő időponttal, vendéggel és tranzakcióval', 'Az auditor dátum-, idő-, vendég- vagy tranzakciószűrőt alkalmaz', 'A lista kizárólag a szűrők együttes feltételeinek megfelelő bejegyzéseket adja vissza', 'e2e'],
      ],
    }),
    requirement({
      id: 'KLEO-GEN-FLTR-001', area: 'Általános működés', title: 'Oszlopszintű táblázatszűrés', page: 41, section: 'III. Általános követelmények',
      statement: 'A rendszer minden üzleti adattáblázatban az oszlopok felett az adott oszlop adattípusának megfelelő keresési vagy szűrési lehetőséget biztosít.',
      criteria: [
        ['Adott egy legalább három oszlopos üzleti táblázat', 'A felhasználó megnyitja a táblázatot', 'Minden szűrhető oszlop fejlécében elérhető a szöveg-, szám-, dátum- vagy lista típusnak megfelelő vezérlő', 'e2e'],
        ['Adott két aktív oszlopszűrő', 'A felhasználó mindkettőt alkalmazza', 'A megjelenő sorok mindkét feltételnek megfelelnek, a találatszám pedig a szűrt sorok számával egyezik', 'e2e'],
      ],
    }),
    requirement({
      id: 'KLEO-GEN-AUTH-001', area: 'Általános működés', title: 'Automatikus kijelentkeztetés', page: 41, section: 'III. Általános követelmények', ownerRole: 'Security Owner',
      statement: 'A rendszer öt perc felhasználói tétlenség után lezárja a hitelesített munkamenetet, és védett adatot további hitelesítés nélkül nem jelenít meg.',
      criteria: [
        ['Adott egy hitelesített munkamenet felhasználói aktivitás nélkül', 'Az utolsó aktivitástól számított 300 másodperc letelik', 'A kliens kijelentkeztetett állapotba kerül, és a következő védett kérés 401 választ kap', 'security'],
        ['Adott egy hitelesített munkamenet', 'A felhasználó a 300 másodperces határ előtt engedélyezett aktivitást végez', 'A tétlenségi időzítő újraindul, és a munkamenet az aktivitás után további 299 másodpercig nem jár le', 'e2e'],
      ],
    }),
    requirement({
      id: 'KLEO-FUN-AUTH-001', area: 'Bejelentkezés', title: 'Belépési és üzletjogosultsági hibák', page: 42, section: 'IV/A/1. Bejelentkezés a programba', ownerRole: 'Security Owner',
      statement: 'A rendszer megtagadja a belépést hibás hitelesítő adat vagy a kiválasztott üzlethez hiányzó jogosultság esetén, és a hiba okának megfelelő felhasználói üzenetet ad.',
      criteria: [
        ['Adott egy nem létező felhasználónév vagy hibás jelszó', 'A felhasználó belépést kér', 'A rendszer 401 választ ad, nem hoz létre munkamenetet, és általános hitelesítési hibaüzenetet jelenít meg', 'security'],
        ['Adott helyes hitelesítő adat, de a kiválasztott üzlethez nincs jogosultság', 'A felhasználó belépést kér', 'A rendszer 403 választ ad, nem hoz létre üzlethez kötött munkamenetet, és jogosultsági hibaüzenetet jelenít meg', 'security'],
      ],
    }),
    requirement({
      id: 'KLEO-FUN-BOOK-001', area: 'Foglalás', title: 'Személyes vagy telefonos időpontfoglalás', page: 7, section: 'II. Főbb folyamatok / Bejelentkezés szolgáltatásra',
      statement: 'A rendszer ügyintézői foglaláskor vendéget, szolgáltatást, helyszínt, munkatársat és kezdési időpontot rögzít, és csak ütközésmentes időpontot fogad el.',
      criteria: [
        ['Adott egy aktív vendég, szolgáltatás, helyszín, munkatárs és szabad idősáv', 'Az ügyintéző hiánytalan foglalást ment', 'Pontosan egy foglalás jön létre a kiválasztott adatokkal és visszaadott egyedi azonosítóval', 'integration'],
        ['Adott egy már lefoglalt idősáv ugyanazon erőforráshoz', 'Az ügyintéző átfedő foglalást ment', 'A rendszer 409 választ ad, nem hoz létre második foglalást, és megjelöli az ütköző idősávot', 'integration'],
      ],
    }),
    requirement({
      id: 'KLEO-FUN-BOOK-002', area: 'Foglalás', title: 'Online időpontfoglalás', page: 9, section: 'II. Főbb folyamatok / Bejelentkezés online felületről',
      statement: 'A rendszer a nyilvános online felületen csak ténylegesen foglalható időpontokat kínál, és sikeres mentés után egyértelmű visszaigazolást ad.',
      criteria: [
        ['Adott egy szolgáltatás és a hozzá tartozó elérhető erőforrások', 'A vendég lekéri a szabad időpontokat', 'A válasz nem tartalmaz zárt, múltbeli vagy már lefoglalt idősávot', 'integration'],
        ['Adott egy még szabad ajánlott időpont és érvényes vendégadat', 'A vendég jóváhagyja a foglalást', 'A foglalás egyszer jön létre, és a felület foglalási azonosítót, helyet és időpontot jelenít meg', 'e2e'],
      ],
    }),
    requirement({
      id: 'KLEO-FUN-BOOK-003', area: 'Foglalás', title: 'Foglalás lemondása', page: 11, section: 'II. Főbb folyamatok / Bejelentkezés lemondása',
      statement: 'A rendszer ügyintézői és online lemondáskor megőrzi a foglalási rekordot, lemondott állapotot és auditálható lemondási adatokat rögzít.',
      criteria: [
        ['Adott egy aktív foglalás és jogosult ügyintéző', 'Az ügyintéző indoklással lemondja a foglalást', 'A foglalás lemondott állapotú, az idősáv felszabadul, az indok és a végrehajtó pedig auditálva van', 'integration'],
        ['Adott egy aktív foglalás és egyszer használható online kezelési token', 'A vendég a lemondást kétszer küldi be', 'Az első kérés lemondja a foglalást, a második idempotens választ ad és nem hoz létre második eseményt', 'integration'],
      ],
    }),
    requirement({
      id: 'KLEO-FUN-WO-001', area: 'Munkalap', title: 'Munkalap létrehozása és állapotgépe', page: 15, section: 'II. Főbb folyamatok / Munkalapok',
      statement: 'A rendszer a munkalapot kizárólag a definiált állapotátmenetek szerint kezeli, és minden átmenet előtt ellenőrzi a szükséges üzleti adatokat.',
      criteria: [
        ['Adott egy érvényes foglalás a szükséges vendég-, szolgáltatás- és dolgozóadattal', 'A jogosult felhasználó munkalapot nyit', 'Pontosan egy munkalap jön létre kezdő állapotban és a foglalásra hivatkozva', 'integration'],
        ['Adott egy munkalap és egy nem engedélyezett állapotátmenet', 'A felhasználó az átmenetet kéri', 'A rendszer 409 választ ad, az állapot változatlan marad, és az elutasítás oka naplózásra kerül', 'integration'],
      ],
    }),
    requirement({
      id: 'KLEO-FUN-WO-002', area: 'Munkalap', title: 'Munkalap visszavonása', page: 20, section: 'II. Főbb folyamatok / Munkalap visszavonása',
      statement: 'A rendszer munkalap-visszavonáskor tranzakciósan visszafordítja a még visszafordítható kapcsolt készlet- és pénzügyi hatásokat, az eredeti rekordok törlése nélkül.',
      criteria: [
        ['Adott egy visszavonható munkalap kapcsolt készletfoglalással', 'A jogosult felhasználó indoklással visszavonja', 'A munkalap visszavont állapotú, a készletfoglalás feloldódik, és minden változás egy tranzakcióban történik', 'integration'],
        ['Adott egy már pénzügyileg lezárt és nem visszavonható munkalap', 'A felhasználó visszavonást kér', 'A rendszer 409 választ ad, sem készlet-, sem pénzügyi rekordot nem módosít, és közli a blokkoló állapotot', 'integration'],
      ],
    }),
    requirement({
      id: 'KLEO-FUN-FIN-001', area: 'Pénzügy', title: 'Bejövő számla rögzítése', page: 22, section: 'II. Főbb folyamatok / Pénzügy / Számlázás', ownerRole: 'Finance Owner',
      statement: 'A rendszer a bejövő számlát egyedi bizonylatazonosítóval, partnerrel, dátumokkal, pénznemmel és ellenőrzött végösszeggel rögzíti.',
      criteria: [
        ['Adott egy aktív partner és hiánytalan, matematikailag helyes számla', 'A pénzügyi felhasználó elmenti', 'A rendszer egy számlát hoz létre, és a fejléc végösszege megegyezik a tételek számított összegével', 'integration'],
        ['Adott azonos partnerhez és számlaszámhoz már létező bizonylat', 'A felhasználó ugyanazt ismét elmenti', 'A rendszer 409 választ ad és nem hoz létre duplikált számlát', 'integration'],
      ],
    }),
    requirement({
      id: 'KLEO-FUN-FIN-002', area: 'Pénzügy', title: 'Pénztári bevétel és kiadás', page: 24, section: 'II. Főbb folyamatok / Pénztár', ownerRole: 'Finance Owner',
      statement: 'A rendszer nyitott pénztári munkamenetben enged bevételt vagy kiadást rögzíteni, és a pénztáregyenleget a tranzakció típusához tartozó előjellel módosítja.',
      criteria: [
        ['Adott egy nyitott pénztár 10 000 Ft egyenleggel', 'A pénztáros 2 500 Ft bevételt rögzít', 'A tranzakció egyedi azonosítóval létrejön, és az egyenleg 12 500 Ft', 'integration'],
        ['Adott egy zárt pénztári munkamenet', 'A pénztáros bevételt vagy kiadást próbál rögzíteni', 'A rendszer 409 választ ad, és sem tranzakciót, sem egyenlegváltozást nem hoz létre', 'integration'],
      ],
    }),
    requirement({
      id: 'KLEO-FUN-INV-001', area: 'Logisztika', title: 'Raktárközi készletmozgás', page: 26, section: 'II. Főbb folyamatok / Logisztika / Raktárak közötti termék mozgás', ownerRole: 'Inventory Owner',
      statement: 'A rendszer raktárközi átadáskor a forrás- és célkészletet azonos mennyiséggel, egyetlen tranzakcióban módosítja, negatív forráskészlet létrehozása nélkül.',
      criteria: [
        ['Adott 10 darab forráskészlet és 3 darabos átadási kérés', 'A jogosult felhasználó jóváhagyja az átadást', 'A forráskészlet 7, a célkészlet 3 darabbal nő, és a két könyvelés ugyanarra a mozgásazonosítóra hivatkozik', 'integration'],
        ['Adott 2 darab forráskészlet és 3 darabos átadási kérés', 'A felhasználó jóváhagyást kér', 'A rendszer 409 választ ad, egyik raktár készlete sem változik, és hiányként 1 darabot jelez', 'integration'],
      ],
    }),
    requirement({
      id: 'KLEO-FUN-INV-002', area: 'Logisztika', title: 'Bevételezés és beszerzési költség', page: 29, section: 'II. Főbb folyamatok / Bevételezés és új beszerzés', ownerRole: 'Inventory Owner',
      statement: 'A rendszer bevételezéskor tételenként növeli a célraktár készletét, és a beszerzési költséget a kapcsolt bizonylattal együtt megőrzi.',
      criteria: [
        ['Adott egy nyitott beszerzés két, 4 és 6 darabos tétellel', 'A raktáros mindkét tételt teljesen bevételezi', 'A célraktár készlete összesen 10 darabbal nő, és mindkét tétel teljesített állapotú', 'integration'],
        ['Adott egy beszerzés nettó tételárral, adókulccsal és járulékos költséggel', 'A bevételezés lezárul', 'A tárolt bruttó és egységköltség a rögzített komponensekből reprodukálható, az eltérés legfeljebb 1 fillér', 'integration'],
      ],
    }),
    requirement({
      id: 'KLEO-FUN-INV-003', area: 'Logisztika', title: 'Készletkorrekció', page: 32, section: 'II. Főbb folyamatok / Korrekciózás', ownerRole: 'Inventory Owner',
      statement: 'A rendszer készletkorrekciót csak jogosult felhasználótól, kötelező indokkal fogad el, és a korábbi mennyiséget, az eltérést és az új mennyiséget naplózza.',
      criteria: [
        ['Adott 8 darab nyilvántartott és 6 darab tényleges készlet', 'A jogosult felhasználó indoklással korrekciót ment', 'A készlet 6 darab, a naplózott eltérés −2, és az előtte–utána érték visszakereshető', 'integration'],
        ['Adott egy korrekciós kérés indok nélkül', 'A felhasználó mentést kér', 'A rendszer 400 választ ad, a készlet változatlan marad, és nem jön létre korrekciós tétel', 'integration'],
      ],
    }),
    requirement({
      id: 'KLEO-FUN-CRM-001', area: 'Panaszkezelés', title: 'Panasz életciklus és bizonyíték', page: 34, section: 'II. Főbb folyamatok / Panaszkezelés', ownerRole: 'Quality Owner',
      statement: 'A rendszer minden panaszt egyedi azonosítóval, felelőssel, státusszal, határidővel és lezárási bizonyítékkal kezel.',
      criteria: [
        ['Adott egy hiánytalan panaszbejelentés és jogosult ügyintéző', 'Az ügyintéző rögzíti a panaszt', 'A rendszer egyedi azonosítót, nyitott státuszt, felelőst és számított határidőt rendel hozzá', 'integration'],
        ['Adott egy nyitott panasz lezárási bizonyíték nélkül', 'A felelős lezárást kér', 'A rendszer 400 választ ad és a panasz nyitott marad; bizonyítékkal a lezárás időbélyeggel sikerül', 'integration'],
      ],
    }),
    requirement({
      id: 'KLEO-FUN-LOY-001', area: 'Hűség', title: 'Vendégegyenleg feltöltése', page: 35, section: 'II. Főbb folyamatok / Bérletek, Hűségkártyák, Kuponok', ownerRole: 'Finance Owner',
      statement: 'A rendszer vendégegyenleg-feltöltést megváltoztathatatlan főkönyvi tételként rögzít, és a vendég aktuális egyenlegét az elfogadott összeggel növeli.',
      criteria: [
        ['Adott egy 1 000 Ft egyenlegű vendég és 5 000 Ft jóváhagyott feltöltés', 'A pénztáros rögzíti a befizetést', 'Egy feltöltési tétel jön létre, és a vendégegyenleg 6 000 Ft', 'integration'],
        ['Adott egy korábban feldolgozott fizetési hivatkozás', 'Ugyanazzal a hivatkozással új feltöltés érkezik', 'A rendszer idempotens választ ad, és az egyenleget nem növeli meg másodszor', 'integration'],
      ],
    }),
    requirement({
      id: 'KLEO-FUN-PROMO-001', area: 'Marketing', title: 'Napi akciók időbeli érvényessége', page: 36, section: 'II. Főbb folyamatok / Napi akciók', ownerRole: 'Marketing Owner',
      statement: 'A rendszer csak az adott helyszínen, célcsoportban és érvényességi időben aktív napi akciót jeleníti meg és alkalmazza.',
      criteria: [
        ['Adott egy aktív akció a jelenlegi időpontot tartalmazó intervallummal és megfelelő helyszínnel', 'A jogosult vendég vagy ügyintéző lekéri az ajánlatokat', 'Az akció pontosan egyszer megjelenik az alkalmazható kedvezménnyel', 'integration'],
        ['Adott lejárt, jövőbeli vagy más helyszínhez tartozó akció', 'Ugyanaz a felhasználó lekéri az ajánlatokat', 'Az akció nem jelenik meg és a pénzügyi számításban sem kerül alkalmazásra', 'integration'],
      ],
    }),
    requirement({
      id: 'KLEO-FUN-HR-001', area: 'HR', title: 'Jelentkezés pozícióra', page: 38, section: 'II. Főbb folyamatok / HR / Jelentkezés pozícióra', ownerRole: 'HR Owner',
      statement: 'A rendszer a pozícióra jelentkezést a kötelező pályázói adatokkal és dokumentumokkal rögzíti, és a jelentkezőnek visszaigazolást ad.',
      criteria: [
        ['Adott egy aktív pozíció és hiánytalan pályázói adat', 'A jelentkező beküldi a pályázatot', 'Pontosan egy jelentkezés jön létre új státusszal, időbélyeggel és visszaigazolási azonosítóval', 'e2e'],
        ['Adott egy pályázat hiányzó kötelező adatmezővel', 'A jelentkező beküldést kér', 'A rendszer nem hoz létre jelentkezést, és mezőszinten megjelöli az összes hiányzó adatot', 'e2e'],
      ],
    }),
    requirement({
      id: 'KLEO-FUN-HR-002', area: 'HR', title: 'Jelentkező elbírálása és alkalmazottá alakítása', page: 40, section: 'II. Főbb folyamatok / HR / Jelentkezés elbírálása', ownerRole: 'HR Owner',
      statement: 'A rendszer a jelentkező kapcsolatfelvételeit és elbírálási lépéseit megőrzi, elfogadáskor pedig egyetlen alkalmazotti rekordot hoz létre és értesítési feladatot generál.',
      criteria: [
        ['Adott egy jelentkező és telefonos vagy e-mailes kapcsolatfelvétel', 'A HR felhasználó rögzíti az eredményt és belső megjegyzést', 'Az esemény csatornával, időponttal, végrehajtóval és csak belső jogosultsággal látható megjegyzéssel visszakereshető', 'integration'],
        ['Adott egy megfelelt jelentkező, akihez még nincs alkalmazotti rekord', 'A HR felhasználó alkalmazottnak felveszi', 'Egy alkalmazotti rekord és egy könyvelői értesítési feladat jön létre; ismételt kérés nem hoz létre duplikátumot', 'integration'],
      ],
    }),
    requirement({
      id: 'KLEO-NFR-HA-001', area: 'Rendelkezésre állás', title: 'Egy szerver kiesésének elviselése', page: 154, section: 'V/A. Teljesítménnyel kapcsolatos követelmények', ownerRole: 'Platform Owner',
      statement: 'Az éles infrastruktúra egyetlen alkalmazás- vagy adatbázis-kiszolgáló kiesése alatt is fenntartja a kritikus olvasási és írási szolgáltatások elérhetőségét.',
      criteria: [
        ['Adott legalább két egészséges alkalmazáspéldány terheléselosztó mögött', 'Az egyik példányt kontrolláltan leállítják', 'A 10 perces vizsgálat alatt a kritikus kérések legalább 99,9%-a sikeres, és nincs elveszett elfogadott írás', 'resilience'],
        ['Adott az adatbázis dokumentált failover-mechanizmusa és folyamatos próbaírás', 'Az aktív adatbázis-kiszolgáló kiesését szimulálják', 'A helyreállítás a jóváhagyott RTO-n belül megtörténik, az RPO nem lépi túl a jóváhagyott értéket, és a bizonyíték időbélyeggel archivált', 'resilience'],
      ],
    }),
    requirement({
      id: 'KLEO-NFR-SEC-001', area: 'Biztonság', title: 'Titkosított kliens–szerver kapcsolat', page: 154, section: 'V/B. Biztonsági követelmények', ownerRole: 'Security Owner',
      statement: 'Az éles rendszer minden kliens–szerver adatforgalmat érvényes TLS-kapcsolaton továbbít, a titkosítatlan HTTP-kérést pedig nem szolgálja ki alkalmazásadattal.',
      criteria: [
        ['Adott az éles nyilvános végpont', 'A kliens HTTP-kérést küld', 'A válasz HTTPS-re irányít át vagy elutasítja a kérést, és nem tartalmaz védett alkalmazásadatot', 'security'],
        ['Adott a TLS-végpont', 'Automatikus protokoll- és tanúsítványvizsgálat fut', 'Csak TLS 1.2 vagy újabb fogadható el, a tanúsítványlánc és a hosztnév érvényes, lejáratig legalább 14 nap van', 'security'],
      ],
    }),
    requirement({
      id: 'KLEO-NFR-SEC-002', area: 'Biztonság', title: 'Jelszavak BCrypt tárolása', page: 155, section: 'V/B. Biztonsági követelmények', ownerRole: 'Security Owner',
      statement: 'A rendszer felhasználói jelszót kizárólag BCrypt egyirányú kivonatként tárol, és jelszót sem naplóban, sem API-válaszban nem ad vissza.',
      criteria: [
        ['Adott egy új vagy jelszót módosító felhasználó', 'A mentés sikeresen lezárul', 'Az adatbázisban BCrypt-formátumú kivonat található, a nyers jelszó egyetlen tartós mezőben vagy naplóban sem szerepel', 'security'],
        ['Adott egy helyes és egy helytelen jelszó ugyanahhoz a felhasználóhoz', 'A hitelesítés mindkettővel lefut', 'A helyes jelszó elfogadott, a helytelen elutasított, és egyik válasz sem tartalmazza a kivonatot', 'security'],
      ],
    }),
    requirement({
      id: 'KLEO-NFR-SEC-003', area: 'Biztonság', title: 'Szerveroldali kulccsal védett tokenek', page: 155, section: 'V/B. Biztonsági követelmények', ownerRole: 'Security Owner',
      statement: 'A rendszer a kommunikációs tokenek hitelességét kizárólag szerveroldalon kezelt kulccsal biztosítja, és módosított vagy lejárt tokent elutasít.',
      criteria: [
        ['Adott egy érvényes, szerveroldali kulccsal aláírt és nem lejárt token', 'A kliens védett kérést küld', 'A rendszer a tokenhez tartozó jogosultságok szerint feldolgozza a kérést', 'security'],
        ['Adott egy módosított, más kulccsal aláírt vagy lejárt token', 'A kliens védett kérést küld', 'A rendszer 401 választ ad, nem hajt végre üzleti módosítást, és biztonsági eseményt naplóz titok vagy teljes token nélkül', 'security'],
      ],
    }),
    requirement({
      id: 'KLEO-NFR-RES-001', area: 'Hibatűrés', title: 'Átmeneti internetkapcsolat-megszakadás kezelése', page: 155, section: 'V/C. Szoftver minőségével kapcsolatos követelmények', ownerRole: 'Platform Owner',
      statement: 'A rendszer átmeneti hálózati megszakadás után kontrollált újrapróbálással vagy felhasználói folytatással helyreáll, és nem hoz létre duplikált üzleti tranzakciót.',
      criteria: [
        ['Adott egy írási kérés, amelynek válasza hálózati hiba miatt nem érkezik meg', 'A kliens ugyanazzal az idempotenciakulccsal újrapróbálja', 'Legfeljebb egy üzleti tranzakció létezik, és a kliens annak végleges állapotát kapja vissza', 'resilience'],
        ['Adott egy megszakadt kapcsolat olvasási művelet közben', 'A kapcsolat 60 másodpercen belül helyreáll', 'A kliens újrapróbál vagy folytatási lehetőséget ad, nem jelenít meg sikeres mentést, és nem veszít el már elfogadott adatot', 'e2e'],
      ],
    }),
    requirement({
      id: 'KLEO-NFR-QLT-001', area: 'Minőség', title: 'Komponensenkénti automata tesztkapu', page: 155, section: 'V/C. Szoftver minőségével kapcsolatos követelmények', ownerRole: 'Quality Owner',
      statement: 'A kiadási folyamat minden módosított komponenshez unit-, integrációs vagy end-to-end tesztbizonyítékot rendel, és sikertelen automata teszt esetén blokkolja a kiadást.',
      criteria: [
        ['Adott egy követelménykatalógust módosító pull request', 'A CI követelmény-ellenőrző feladata lefut', 'A feladat 10,0/10 pontszámot igazol, és hibás vagy árva azonosító esetén nem sikeres', 'contract', 'automated', ['tests/requirements-traceability.contract.test.js']],
        ['Adott egy módosított komponenshez tartozó sikertelen automata teszt', 'A kiadási workflow értékeli a teszteredményt', 'A kiadási feladat blokkolt állapotú, és a sikertelen teszt neve a futási bizonyítékban látható', 'inspection'],
      ],
    }),
    requirement({
      id: 'KLEO-NFR-QLT-002', area: 'Minőség', title: 'Kiadás előtti manuális ellenőrzés', page: 155, section: 'V/C. Szoftver minőségével kapcsolatos követelmények', ownerRole: 'Quality Owner',
      statement: 'A rendszerverzió élesítése előtt a sikeres automata tesztek után jóváhagyott manuális ellenőrzési jegyzőkönyv készül a kritikus üzleti folyamatokról.',
      criteria: [
        ['Adott egy kiadásra jelölt verzió sikeres automata tesztekkel', 'A kijelölt tesztelő végrehajtja a kritikus manuális teszteseteket', 'A jegyzőkönyv tartalmaz verziót, környezetet, végrehajtót, időpontot, teszteset-azonosítókat, eredményt és bizonyítékhivatkozást', 'inspection'],
        ['Adott hiányzó, sikertelen vagy jóvá nem hagyott manuális jegyzőkönyv', 'Az élesítési döntés megszületik', 'A verzió nem kaphat kiadható státuszt, és a blokkoló tesztesetek azonosítója megjelenik a döntési naplóban', 'inspection'],
      ],
    }),
  ],
};

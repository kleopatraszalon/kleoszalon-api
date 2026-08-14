BEGIN;

INSERT INTO uat_test_cases(
  code,module_key,title,description,expected_result,route,order_index,critical
)
VALUES
('UAT-BOOK-001','booking','Publikus vendégfoglalás végig','Nyisd meg a publikus foglalót, válassz telephelyet, legalább egy szolgáltatást, szakembert vagy Bármely szakember opciót, dátumot és szabad időpontot. Vendégként adj meg teszt nevet és legalább egy kapcsolattartási adatot, majd a végső ellenőrző ablakból erősítsd meg.','A foglalás egyszer jön létre; a sikeroldal az időpontot, szolgáltatásokat és telephelyet mutatja; a rekord a VIR naptárban megjelenik; ugyanarra a szakemberre és időre nem jön létre második aktív foglalás.','/booking',10,true),
('UAT-BOOK-002','booking','Hangalapú foglalás és korreláció','A publikus foglaló hangos segítségével add meg a szalont, szolgáltatást és időpontigényt, majd a felismert adatokat kézzel ellenőrizd és véglegesítsd. Lemondási szándékot hang alapján ne engedj közvetlenül végrehajtani.','A hangértelmezés visszakérdez vagy kitölti a foglalási szándékot, a felhasználó mindig ellenőrizhet és módosíthat; a végleges foglalás voice eredete korrelálható, hangos lemondás nem töröl automatikusan foglalást.','/booking',20,false),
('UAT-BOOK-003','booking','Bejelentkezett ügyfél foglalása','Bejelentkezett ügyfélként indíts foglalást az ügyfélportálról, és használj a profilban már meglévő kapcsolattartási adatokat.','A rendszer nem kér feleslegesen új vendégadatot, a foglalást a bejelentkezett ügyfélhez kapcsolja, és ugyanaz a foglalási/availability logika működik, mint a publikus folyamatban.','/customer/booking',21,true),
('UAT-BOOK-004','booking','Több szolgáltatás és Bármely szakember','Válassz legalább két szolgáltatást egy foglalásba. Először Bármely szakember opcióval keress időpontot, majd ismételd meg konkrét szakember kiválasztásával.','A rendszer a teljes szolgáltatáscsomag időigényével számol, csak olyan kezdési időt kínál, amely végig foglalható; Bármely szakember esetén ténylegesen szabad szakemberhez rendeli a foglalást.','/booking',22,true),
('UAT-BOOK-005','booking','Időpontütközés és 409 helyreállítás','Két böngészőablakban készíts elő ugyanarra a szakemberre és időpontra azonos foglalást. Az elsőt véglegesítsd, majd próbáld a másodikat is elküldeni.','Csak az első foglalás jön létre. A második kérés ütközési választ kap, a felület egyértelműen jelzi, hogy az időpont közben elfogyott, frissíti a szabad időpontokat, és nem hoz létre duplikált rekordot.','/booking',23,true),
('UAT-BOOK-006','booking','Várólista szabad idő nélkül','Olyan szolgáltatás/szakember/dátum kombinációt válassz, ahol nincs megfelelő szabad idő, és iratkozz fel a várólistára teszt kapcsolattartási adattal.','A várólista-bejegyzés egyszer jön létre a kiválasztott telephelyhez, szolgáltatáshoz és preferenciához; a felület sikeres visszajelzést ad, foglalás viszont nem keletkezik.','/booking',24,false),
('UAT-BOOK-007','booking','Foglalás módosítása tokennel','Publikus vendégfoglalás után nyisd meg a sikeroldalon kapott foglaláskezelő linket. Válassz új, valóban szabad időpontot, és csak a külön megerősítés után módosítsd.','A kezelőoldal token alapján hitelesítés nélkül betölti kizárólag az adott foglalás szükséges adatait; az új időpont availability alapján választható; módosítás után a régi idősáv felszabadul, az új lefoglalódik, és az azonos foglalás azonosítója megmarad.','/booking',25,true),
('UAT-BOOK-008','booking','Foglalás lemondása tokennel','A foglaláskezelő linkről indíts lemondást, majd ellenőrizd, hogy explicit megerősítés nélkül nem történik változás. Ezután erősítsd meg a lemondást.','A lemondás csak külön megerősítés után történik meg; a foglalás nem törlődik fizikailag, hanem lemondott állapotba kerül; az idősáv ismét foglalhatóvá válik, a kezelőtoken más foglaláshoz nem ad hozzáférést.','/booking',26,true),
('UAT-BOOK-009','booking','Ajánlott szolgáltatás hozzáadása','Egy szolgáltatás kiválasztása után várd meg a személyre szabott vagy szabályalapú ajánlásokat, majd adj hozzá egy ajánlott szolgáltatást.','Az ajánlás hibája vagy lassúsága nem blokkolja az időpontkeresést. Hozzáadás után a teljes időtartam, ár és availability újraszámolódik, és a hozzáadott szolgáltatás bekerül a végleges foglalásba.','/booking',27,false),
('UAT-BOOK-010','booking','Foglalási adatvédelem és marketing-hozzájárulás','Vendégként tölts ki kapcsolattartási adatokat, de a marketing-hozzájárulást hagyd kikapcsolva. Frissítsd az oldalt ugyanabban a munkamenetben, majd új privát munkamenetben is.','A foglalási választások munkameneten belül visszaállhatnak, de a vendég neve, telefonja és e-mailje nem kerül tartós böngésző-tárolóba. A marketing-hozzájárulás külön, opcionális döntés, és kikapcsolt állapotban is foglalható időpont.','/booking',28,true)
ON CONFLICT(code) DO UPDATE SET
  module_key=EXCLUDED.module_key,
  title=EXCLUDED.title,
  description=EXCLUDED.description,
  expected_result=EXCLUDED.expected_result,
  route=EXCLUDED.route,
  order_index=EXCLUDED.order_index,
  critical=EXCLUDED.critical,
  active=true,
  updated_at=now();

-- Az új acceptance esetek a már nyitott UAT futásokban is azonnal jelenjenek meg.
INSERT INTO uat_test_results(run_id,test_case_id,status,note)
SELECT r.id,c.id,'not_tested','Booking UX véglegesítés utáni acceptance teszt.'
FROM uat_test_runs r
JOIN uat_test_cases c ON c.module_key='booking' AND c.active=true
WHERE r.status='open'
ON CONFLICT(run_id,test_case_id) DO NOTHING;

COMMIT;

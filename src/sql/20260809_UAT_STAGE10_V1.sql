BEGIN;

INSERT INTO uat_test_cases(code,module_key,title,description,expected_result,route,order_index,critical)
VALUES
('UAT10-BOOK-WO-001','workorders','Foglalásból munkalap – egyedi kapcsolat','A naptári foglalásból a Megérkezett/Munkalap művelettel munkalap nyílik. Ugyanahhoz az appointment_id-hoz a műveletet ismételjük.','A foglaláshoz pontosan egy munkalap tartozik; ismételt művelet a meglévő munkalapot nyitja meg, duplikáció nincs.','/appointments/calendar',200,true),
('UAT10-WALKIN-001','workorders','Walk-in munkalap létrehozása','Foglalás nélkül meglévő vagy új vendéggel, munkatárssal új munkalap készül.','A munkalap létrejön appointment_id nélkül, a vendég és munkatárs helyesen kapcsolódik.','/workorders/new',210,true),
('UAT10-ITEM-001','workorders','Szolgáltatás és termék kiválasztása','A munkatárshoz/szalonhoz elérhető szolgáltatás és készleten lévő termék kiválasztása a csoportosított modalból.','A listák nem üresek; a kijelölt szolgáltatás és termék bekerül a munkalapba, ár és időtartam helyes.','/workorders/new',220,true),
('UAT10-MAT-001','inventory','Kötelező anyag és készletkontroll','Szolgáltatáshoz kötelező anyagot és tényleges felhasználási mennyiséget rögzítünk.','Hiányzó kötelező anyag vagy elégtelen készlet blokkol; megfelelő mennyiségnél a lezárás után pontos készletmozgás keletkezik.','/workorders/new',230,true),
('UAT10-LOY-001','loyalty','Hűség és normál fizetés együtt','Kupon/wallet/pont/bérlet/utalvány mellett készpénz vagy bankkártya fizetési sort is rögzítünk.','A kedvezmény és hűségfelhasználás egyszer számolódik, a fennmaradó összeg normál fizetéssel kiegyenlíthető.','/workorders/new',240,true),
('UAT10-PAY-001','finance','Kevert fizetés – 0 Ft eltérés','Egy munkalapot legalább két fizetési móddal egyenlítünk ki.','Fizetendő mínusz rögzített összeg = 0 Ft; csak ekkor engedélyezett a Lezárás.','/workorders/new',250,true),
('UAT10-CLOSE-001','workorders','Végleges lezárási tranzakció','Fizetett in_progress munkalapot véglegesítünk.','status és document_status completed; closed_at kitöltve; munkalap archivált/zárolt; kapcsolt időpont completed.','/workorders',260,true),
('UAT10-STOCK-001','inventory','Lezárás utáni készlet visszaellenőrzése','Termék/anyag felhasználással lezárt munkalap után ellenőrizzük a szalonkészletet.','Csak a tényleges felhasználás kerül levonásra, inventory_movements rekord a munkalapra visszamutat.','/warehouse',270,true),
('UAT10-FIN-001','finance','Munkalap–pénzügy–számla kapcsolat','Lezárt munkalap pénzügyi mozgását és számlakapcsolatát ellenőrizzük.','A fizetés, pénzügyi bizonylat/számlatervezet és forrás munkalap kölcsönösen visszakereshető; összegük konzisztens.','/finance',280,true),
('UAT10-CANCEL-001','booking','Lemondás/no-show pénzügyi védelemmel','Nyitott időpontot lemondunk/no-show-ra állítunk, majd ugyanezt már fizetett munkalap mellett próbáljuk.','Nyitott munkalap konzisztensen cancelled/no_show lesz; fizetett vagy pénzügyileg lezárt munkalapnál 409 és sztornófolyamat szükséges.','/appointments/calendar',290,true),
('UAT10-SCOPE-001','access','Munkalap telephely- és szerepkör-scope','Admin, recepciós, üzletvezető, szalonvezető, munkatárs és ügyfél hozzáférését ellenőrizzük.','Admin minden szalont lát; recepciós/üzletvezető csak saját szalont módosíthat; szalonvezető olvas; munkatárs/ügyfél csak saját kapcsolódó munkalapot lát.','/admin/access-control',300,true),
('UAT10-IMMUT-001','workorders','Lezárt munkalap immutabilitása','Lezárt/archivált munkalap újrafizetését, módosítását és egyszerű visszavonását próbáljuk.','A rendszer 409/403 üzleti hibával elutasítja, és az archív snapshot változatlan marad.','/workorders',310,true),
('UAT10-ADMIN-CL-001','checklists','Admin napi checklist','Admin felhasználó megnyitja a Check listák oldalt és a dashboard Mai feladatok blokkját.','Nincs null employee hiba; Adminisztrátor munkakör és napi/heti/havi Admin checklist látható és teljesíthető.','/knowledge-base/checklists',320,true)
ON CONFLICT(code) DO UPDATE SET
 module_key=EXCLUDED.module_key,title=EXCLUDED.title,description=EXCLUDED.description,
 expected_result=EXCLUDED.expected_result,route=EXCLUDED.route,order_index=EXCLUDED.order_index,
 critical=EXCLUDED.critical,active=true,updated_at=now();

INSERT INTO schema_migrations(version,description)
VALUES('20260809_UAT_STAGE10_V1','10. etap – végponttól végpontig munkalap, pénzügy, készlet és jogosultsági UAT esetek')
ON CONFLICT(version) DO NOTHING;

COMMIT;

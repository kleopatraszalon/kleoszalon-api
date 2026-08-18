import type{KnowledgeMaterial,KnowledgeSource,QuizQuestion}from'./catalog';

export type AcademyLevel='beginner'|'advanced'|'expert';
export type AcademyMaterial=KnowledgeMaterial&{level:AcademyLevel;level_label:string;profession:string;profession_label:string};
export type AcademyProfession={key:string;label:string;roles:string[];category:string;professional_source:string;safety_source:string;beginner:string[];advanced:string[];expert:string[];safety:string[]};

export const academyLevels:{key:AcademyLevel;label:string;description:string}[]=[
 {key:'beginner',label:'Kezdő',description:'Biztonságos önálló alapfeladatok, higiénia, vendégkommunikáció és dokumentáció.'},
 {key:'advanced',label:'Haladó',description:'Összetettebb szakmai döntések, eltéréskezelés, minőség és kockázatértékelés.'},
 {key:'expert',label:'Szakértő',description:'Komplex esetek, auditálható döntések, mentorálás és folyamatfejlesztés.'},
];

export const academyKnowledgeSources2026:KnowledgeSource[]=[
 {code:'SRC-IKK-KKK-ACADEMY',name:'IKK – Képzési és Kimeneti Követelmények (KKK), Programtantervek (PTT)',url:'https://akkreditaltvizsgaztatas.ikk.hu/kkk-ptt',authority:'IKK Nonprofit Zrt.',reviewed_at:'2026-08-18'},
 {code:'SRC-IKK-BEAUTY-ACADEMY',name:'IKK – Szépészet ágazat',url:'https://ikk.hu/szakmakartyak/agazatok/szepeszet',authority:'IKK Nonprofit Zrt.',reviewed_at:'2026-08-18'},
 {code:'SRC-NNGYK-SALON-2026',name:'NNGYK – Szépségápolási szolgáltatási tevékenységek',url:'https://nngyk.gov.hu/hu/jogszabalyok-utmutatok-ugyfel-tajekoztatok/szepsegapolasi-szolgaltatasokra-vonatkozo-jogszabalyok-utmutatok/szepsegapolasi-szolgaltatasi-tevekenysegek.html',authority:'NNGYK',reviewed_at:'2026-08-18'},
 {code:'SRC-NNGYK-COSMETICS-2026',name:'NNGYK – Kozmetikumokra vonatkozó jogszabályok és útmutatók',url:'https://nngyk.gov.hu/hu/?id=671&view=category',authority:'NNGYK',reviewed_at:'2026-08-18'},
 {code:'SRC-ECHA-SDS-2026',name:'ECHA – Safety Data Sheets',url:'https://echa.europa.eu/safety-data-sheets',authority:'European Chemicals Agency',reviewed_at:'2026-08-18'},
 {code:'SRC-ECHA-CLP-2026',name:'ECHA – CLP címkézés és csomagolás',url:'https://echa.europa.eu/hu/regulations/clp/labelling',authority:'European Chemicals Agency',reviewed_at:'2026-08-18'},
 {code:'SRC-EU-COSMETICS-2026',name:'EUR-Lex – 1223/2009/EK kozmetikai rendelet, aktuális konszolidált változat',url:'https://eur-lex.europa.eu/legal-content/HU/TXT/?uri=CELEX%3A32009R1223',authority:'EUR-Lex / Európai Unió',reviewed_at:'2026-08-18'},
 {code:'SRC-EC-SUNBED-2026',name:'Európai Bizottság / SCHEER – UV-szoláriumok egészségügyi kockázatai',url:'https://health.ec.europa.eu/scientific-committees/easy-read-summaries-scientific-opinions/7-conclusions_en',authority:'European Commission / SCHEER',reviewed_at:'2026-08-18'},
 {code:'SRC-EU-GDPR-BREACH-2026',name:'Európai Bizottság – Adatvédelmi incidens és 72 órás szabály',url:'https://commission.europa.eu/law/law-topic/data-protection/rules-business-and-organisations/obligations/what-data-breach-and-what-do-we-have-do-case-data-breach_hu',authority:'European Commission',reviewed_at:'2026-08-18'},
 {code:'SRC-IKK-REHAB-2026',name:'IKK – Rehabilitációs terapeuta / gyógymasszőr kapcsolódó tanulási eredmények',url:'https://ikk.hu/p/jo-gyakorlatok-a-nemzetkozi-egyuttmukodesek-teren',authority:'IKK Nonprofit Zrt.',reviewed_at:'2026-08-18'},
];

const P=(key:string,label:string,roles:string[],category:string,professional_source:string,safety_source:string,beginner:string[],advanced:string[],expert:string[],safety:string[]):AcademyProfession=>({key,label,roles,category,professional_source,safety_source,beginner,advanced,expert,safety});

export const academyProfessions:AcademyProfession[]=[
 P('hair','Fodrász / TOP fodrász / Borbély',['fodrász','fodrasz','top fodrász','top fodrasz','mesterfodrász','mesterfodrasz','borbély','borbely','barber'],'Fodrászat','SRC-IKK-HAIR-2026','SRC-OSHA-HAIR',[
  'A haj és a fejbőr aktuális állapotának felmérése megelőzi a technológia kiválasztását.',
  'A kívánt eredményt, az előzményeket és a reálisan elérhető eredményt a vendéggel egyeztetni kell.',
  'A szolgáltatáshoz csak azonosítható, megfelelő állapotú és rendeltetésszerű termék használható.',
  'A gyártói használati előírásokat, keverési arányt, hatóidőt és biztonsági figyelmeztetést követni kell.',
  'A szolgáltatás végén az otthoni hajápolási és formázási tanácsot a tényleges állapothoz kell igazítani.'
 ],[
  'Színváltoztatásnál az előző kémiai kezelések, a porozitás, az alapszín és a célárnyalat együtt határozza meg a tervet.',
  'Korrekciós szolgáltatás előtt a haj terhelhetőségét és a több lépcsős technológia kockázatát újra kell értékelni.',
  'A formula, a technológiai paraméterek és a tapasztalt reakciók dokumentálása támogatja a reprodukálhatóságot.',
  'A haj vagy fejbőr rendellenes reakciója esetén a folyamatot meg kell szakítani és a helyzetet biztonságosan újraértékelni.',
  'Az ergonómiai terhelést állítható munkahellyel, testhelyzet-váltással és a repetitív műveletek csökkentésével kell mérsékelni.'
 ],[
  'Komplex színkorrekciónál a teljes kémiai előzményből, próbaeredményből és terhelhetőségből kell többfázisú stratégiát készíteni.',
  'Szakértői döntésnél a kívánt esztétikai eredmény nem írhatja felül a haj, fejbőr és munkavállaló biztonsági korlátait.',
  'Ismétlődő minőségi eltérésnél az okot technológia, termék, eszköz, környezet és munkamódszer szerint kell visszakeresni.',
  'Mentoráláskor a tanulónak nemcsak a műveletet, hanem a döntési pontokat, kockázatokat és leállítási feltételeket is értenie kell.',
  'Új technológia bevezetése előtt forrás, gyártói előírás, kockázat, próba és belső dokumentáció alapján kell validálni a folyamatot.'
 ],['A wet-work és a vegyi expozíció csökkentése, megfelelő kesztyű és bőrvédelem alapvető.','Por, aeroszol és gőz esetén a forrásnál történő expozíciócsökkentés és megfelelő szellőzés elsődleges.']),
 P('cosmetic','Kozmetikus / Kozmetikus technikus',['kozmetikus','kozmetikus technikus','beautician','esthetician'],'Kozmetika','SRC-IKK-COS-2026','SRC-NNGYK-COSMETICS-2026',[
  'A kezelés előtt bőrállapot-felmérés és a kezelést befolyásoló vagy kizáró körülmények tisztázása szükséges.',
  'A kezelési tervet a bőrállapothoz, a vendég céljához és a kozmetikus kompetenciahatárához kell igazítani.',
  'A professzionális kozmetikumot rendeltetésszerűen, higiénikusan és a gyártói előírás szerint kell alkalmazni.',
  'A kézi és gépi kezelésnél a munkaterület, az eszköz és a kezelő kézhigiéniája a folyamat része.',
  'A vendégnek érthető otthoni bőrápolási javaslatot kell adni, túlzó gyógyhatás-állítás nélkül.'
 ],[
  'Összetett kezelési tervnél a bőrtípus, aktuális állapot, érzékenység, korábbi reakciók és alkalmazott hatóanyagok együtt értékelendők.',
  'Elektrokozmetikai eszköznél az indikáció, kontraindikáció, gyártói beállítási tartomány és a bőr reakciója együtt határozza meg az alkalmazást.',
  'Új hatóanyag vagy termék bevezetésekor az összetevői és gyártói információt, alkalmazási korlátozást és kompatibilitást át kell tekinteni.',
  'Rendellenes bőrreakciónál a kezelést meg kell szakítani, az alkalmazott termékeket és paramétereket rögzíteni, majd szükség szerint továbbirányítani.',
  'A kezelés eredményét objektív megfigyelésekkel, a vendég visszajelzésével és az utánkövetési tervvel együtt kell értékelni.'
 ],[
  'Szakértői esetértékeléskor külön kell választani a kozmetikai kompetenciába tartozó állapotot az egészségügyi kivizsgálást igénylő eltéréstől.',
  'Komplex kezelési programnál a beavatkozások sorrendjét, terhelését, kölcsönhatásait és regenerációs időigényét együtt kell tervezni.',
  'Minőségi probléma esetén vissza kell keresni a tételt, terméket, eszközparamétert, higiéniai folyamatot és dokumentációt.',
  'Új gépi vagy hatóanyagos protokollt dokumentált forrás, gyártói előírás, kompetencia és ellenőrzött próba alapján kell bevezetni.',
  'Szakmai mentoráláskor a döntési logikát, kontraindikáció-felismerést, dokumentálást és eszkalációt is értékelni kell.'
 ],['A kozmetikum csomagolásának, azonosíthatóságának és lejárati/PAO információjának ellenőrzése használat előtt szükséges.','A keresztkontamináció megelőzéséhez higiénikus adagolás és tiszta eszközút szükséges.']),
 P('nail','Kéz- és lábápoló / Körmös / Pedikűrös',['kéz- és lábápoló','kez- es labapolo','kézápoló','kezapolo','lábápoló','labapolo','körmös','kormos','pedikűrös','pedikuros','nail'],'Kéz- és lábápolás','SRC-IKK-NAIL-2026','SRC-NNGYK-SALON-2026',[
  'A kéz, láb, bőr és köröm állapotát a szolgáltatás megkezdése előtt szemrevételezni kell.',
  'Fertőzésgyanús, sérült vagy a kompetencián túlmutató állapotnál a szolgáltatást módosítani, elhalasztani vagy továbbirányítani kell.',
  'A többször használatos eszközök tisztítási és fertőtlenítési rendjét vendégenként követni kell.',
  'Az egyszer használatos anyagokat nem szabad másik vendégen újra felhasználni.',
  'A termékeket csak rendeltetésük, gyártói előírásuk és biztonságos alkalmazási módjuk szerint szabad használni.'
 ],[
  'Gépi csiszolásnál a fej, fordulatszám, nyomás, hőterhelés és kezelt felület állapota együtt határozza meg a biztonságos technikát.',
  'Anyagfelválás vagy tartóssági hiba esetén az előkészítés, rétegvastagság, kötési paraméter és termék-kompatibilitás együtt vizsgálandó.',
  'Érzékenység vagy irritáció gyanújánál a termékexpozíciót meg kell szakítani és az alkalmazott anyagokat dokumentálni kell.',
  'Lábápolásnál a kockázati állapotok felismerése meghatározza, hogy a szolgáltatás elvégezhető-e a saját kompetencián belül.',
  'Porral és vegyi anyaggal járó munkánál a forrásnál történő elszívás, megfelelő munkaszervezés és szükséges védelem együtt alkalmazandó.'
 ],[
  'Komplex láb- vagy körömállapotnál a kompetenciahatár, fertőzéskockázat, sérülésveszély és vendégbiztonság elsőbbséget élvez az esztétikai céllal szemben.',
  'Ismétlődő tapadási vagy anyaghiba esetén tétel-, eszköz-, lámpa-, előkészítési és technológiai okokra bontott vizsgálat szükséges.',
  'Új anyagrendszer bevezetésénél az összetevői és gyártói információt, kompatibilitást, kötési paramétert és munkavédelmi kockázatot dokumentálni kell.',
  'Szakértői mentorálásnál a higiéniai útvonalat, eszközkezelést, anyagbiztonságot és döntési határokat egyaránt számon kell kérni.',
  'Minőségbiztosításnál az eltérések trendjeiből megelőző intézkedést kell képezni, majd annak hatékonyságát visszaellenőrizni.'
 ],['Vérrel vagy testnedvvel szennyezett felületnél azonnali, előírt fertőtlenítési és elkülönítési folyamat szükséges.','A por- és vegyianyag-expozíciót elsősorban műszaki és szervezési intézkedésekkel kell csökkenteni.']),
 P('massage','Masszőr / Gyógymasszőr',['masszőr','masszor','gyógymasszőr','gyogymasszor','wellness masszőr','wellness masszor'],'Masszázs','SRC-IKK-REHAB-2026','SRC-NNGYK-SALON-2026',[
  'A szolgáltatás célját, a vendég aktuális állapotát és a masszázst kizáró vagy módosító körülményeket a kezelés előtt tisztázni kell.',
  'A szalonban végzett frissítő vagy wellness masszázs nem helyettesít orvosi diagnózist vagy egészségügyi kezelést.',
  'Akut fájdalom, sérülés, rosszullét vagy ismeretlen eredetű tünet esetén a biztonság és a megfelelő továbbirányítás elsődleges.',
  'A testhelyzetet, alátámasztást és alkalmazott fogást a vendég állapotához és komfortjához kell igazítani.',
  'A kezelőfelület, textíliák és kézhigiénia vendégenkénti rendezése a szolgáltatás része.'
 ],[
  'A kezelési tervnél a célterület, terhelhetőség, korábbi reakciók és a választott fogások intenzitása együtt értékelendő.',
  'A kezelés közbeni új fájdalom, szédülés, zsibbadás vagy egyéb rendellenes tünet a terhelés azonnali újraértékelését igényli.',
  'Gyógymasszőri tevékenységnél a végzettséghez és egészségügyi kompetenciához rendelt szakmai határokat követni kell.',
  'Az utánkövetéshez érdemes rögzíteni a kezelési célt, főbb alkalmazott módszereket, reakciót és következő alkalomra vonatkozó megfigyelést.',
  'A kezelő saját ergonómiáját asztalmagassággal, testtömeg-áthelyezéssel és tartós statikus terhelés csökkentésével kell védeni.'
 ],[
  'Komplex vagy rehabilitációs esetben a szükségletfelmérés, cél, terápiás terv és a kompetenciahatár együtt határozza meg a beavatkozást.',
  'Szakértőként meg kell különböztetni a várható átmeneti reakciót a szolgáltatás megszakítását vagy egészségügyi eszkalációt igénylő tünettől.',
  'Ismétlődő panasz esetén a fogás, erő, időtartam, pozicionálás és vendégállapot szerinti okfeltárás szükséges.',
  'Új módszer bevezetése csak megfelelő képzettség, hiteles szakmai forrás, kockázatértékelés és dokumentált belső protokoll mellett indokolt.',
  'Mentorálásnál a technikai kivitelezés mellett a kontraindikáció-felismerést, kommunikációt és leállítási döntést is értékelni kell.'
 ],['A higiénés követelmények és a tiszta textília/eszközhasználat minden vendégnél alapkövetelmény.','A kompetenciahatár átlépése helyett bizonytalan vagy kóros állapotnál megfelelő szakemberhez kell irányítani a vendéget.']),
 P('solarium','Szolárium kezelő',['szolárium kezelő','szolarium kezelo','szolárium','szolarium','tanning'],'Szolárium','SRC-EC-SUNBED-2026','SRC-NNGYK-SALON-2026',[
  'A vendégtájékoztatásnak egyértelművé kell tennie, hogy az UV-szolárium használata egészségügyi kockázattal jár.',
  'Nem szabad a szoláriumhasználatot kockázatmentesnek, egészségmegőrzőnek vagy D-vitamin-pótlásra szükségesnek beállítani.',
  'A berendezés felületének vendégenkénti higiénés előkészítése és a kezelőtér tisztasága kötelező működési alap.',
  'A gyártói üzemeltetési, karbantartási és hibajelzési előírásokat dokumentáltan követni kell.',
  'Rendellenes bőrreakció, rosszullét vagy műszaki hiba esetén a használatot meg kell szakítani és az eseményt jelenteni kell.'
 ],[
  'Az UV-dózis csökkentése nem teszi a szoláriumhasználatot kockázatmentessé, ezért a tájékoztatásban nem szabad „biztonságos barnulást” ígérni.',
  'A szemvédelem egy fontos óvintézkedés, de nem szünteti meg az UV-expozíció bőr- és hosszú távú daganatos kockázatát.',
  'Gyógyszer, fényérzékenységre utaló információ vagy korábbi erős reakció esetén a szolgáltatást nem szabad rutineljárásként kezelni.',
  'A lámpacsere, üzemóra, karbantartás és hibabejelentés nyomon követhetősége a berendezésbiztonság része.',
  'Panasz vagy reakció esetén időpontot, berendezést, körülményeket és megtett intézkedést visszakövethetően rögzíteni kell.'
 ],[
  'Szakértői üzemeltetési kontrollnál a tudományos kockázati tájékoztatásnak elsőbbsége van az értékesítési üzenettel szemben.',
  'A SCHEER megállapítása szerint nem adható olyan UV-irradiancia- vagy dózishatár, amely a szoláriumhasználatot egészségügyi szempontból biztonságossá tenné.',
  'Ismétlődő bőrreakció vagy üzemeltetési eltérés trendjét ki kell vizsgálni, és szükség esetén a berendezést ki kell vonni a használatból.',
  'Marketing- és recepciós tájékoztató anyagokat rendszeresen felül kell vizsgálni, hogy ne tartalmazzanak félrevezető egészségügyi állítást.',
  'A berendezés műszaki dokumentációját, karbantartási bizonyítékait és incidensnaplóját auditálható módon kell kezelni.'
 ],['A higiéniai előkészítés nem csökkenti az UV biológiai kockázatát; a két kockázattípust külön kell kezelni.','A műszaki vagy egészségügyi rendellenességet nem szabad értékesítési nyomás miatt figyelmen kívül hagyni.']),
 P('reception','Recepciós / Ügyfélkapcsolat',['recepciós','recepcios','receptionist','reception','front desk','ügyfélszolgálat','ugyfelszolgalat'],'Recepció','SRC-NNGYK-SALON-2026','SRC-EU-GDPR-BREACH-2026',[
  'Érkeztetés előtt a vendéget, telephelyet, szolgáltatást, időpontot és szakembert pontosan egyeztetni kell.',
  'Csak a feladat elvégzéséhez szükséges vendégadatot szabad megnyitni vagy továbbítani.',
  'Lemondást, késést, módosítást és fontos vendégkérést tényszerűen, visszakövethetően kell rögzíteni.',
  'A recepciós nem adhat szakmai diagnózist; kezelési kérdésnél a megfelelő szakemberhez kell kapcsolnia a vendéget.',
  'Panasznál a tényeket, érintett szolgáltatást, időpontot és kért megoldást rögzíteni, majd felelősnek átadni kell.'
 ],[
  'Ütköző foglalásnál a szolgáltatási idő, erőforrás, szakember és telephely korlátait együtt kell ellenőrizni a megoldás előtt.',
  'Téves címzettnek küldött vendégadat adatvédelmi incidens lehet, ezért a további terjedést azonnal korlátozni és belsőleg jelenteni kell.',
  'Érzékeny vendéghelyzetnél a nyilvános térben elhangzó vagy látható személyes adat mennyiségét minimalizálni kell.',
  'Fizetési vagy bizonylati eltérésnél nem szabad becsléssel korrigálni; a tranzakciót és bizonylatot vissza kell keresni.',
  'Panaszkezelésnél a vállalt határidőt, felelőst és visszajelzést nyomon kell követni a lezárásig.'
 ],[
  'Adatvédelmi incidensnél a belső hatáskorlátozás azonnal indul; a 72 óra nem várakozási idő, hanem kockázatos incidensnél hatósági bejelentési felső határ.',
  'Komplex ügyfélkonfliktusnál a tény, ígéret, jogkör, kompenzáció és eszkaláció különválasztása szükséges.',
  'Ismétlődő foglalási hibákból folyamat- vagy rendszerhibát kell keresni, nem kizárólag egyedi munkatársi hibát.',
  'Recepciós minőségellenőrzésnél a hibaarány, várakozás, no-show kezelés, panasz és adatvédelmi eltérés trendjeit együtt kell értékelni.',
  'Új recepciós folyamatot jogosultság-, adatvédelmi-, pénzügyi- és vendégélmény szempontból is tesztelni kell.'
 ],['A képernyőt és papíralapú vendégadatot illetéktelen személy számára nem szabad hozzáférhetően hagyni.','Az adatvédelmi eseményt nem szabad eltitkolni vagy a következő műszakig halasztani.']),
 P('management','Szalonvezető / Műszakvezető / Üzletvezető',['szalonvezető','szalonvezeto','üzletvezető','uzletvezeto','műszakvezető','muszakvezeto','salon_manager','location_manager','store_manager','branch_manager','manager','vezető','vezeto'],'Vezetés','SRC-NNGYK-SALON-2026','SRC-OSHA-CHEM',[
  'Műszakkezdéskor a személyzet, nyitott foglalások, higiéniai állapot, kritikus készlet és működő eszközök alapellenőrzése szükséges.',
  'Eltéréshez felelőst, határidőt és ellenőrizhető lezárási feltételt kell rendelni.',
  'A vezetőnek biztosítania kell, hogy a munkatárs csak képzettségének, jogosultságának és betanítottságának megfelelő feladatot végezzen.',
  'Panaszt és rendkívüli eseményt tényalapon, bizonyítékokkal és visszakövethető intézkedéssel kell kezelni.',
  'Napzárás előtt a nyitott munkalapok, pénzügyi eltérések és átadandó feladatok rendezése szükséges.'
 ],[
  'Kockázatkezelésnél először a veszély megszüntetését vagy helyettesítését, majd műszaki és szervezési kontrollt kell vizsgálni; PPE nem első választás.',
  'Ismétlődő minőségi hiba esetén a folyamatot, eszközt, anyagot, képzést és munkaszervezést együtt kell vizsgálni.',
  'Adatvédelmi incidensnél a hozzáférést, terjedést és további adatvesztést azonnal korlátozni kell, majd a kockázatot értékelni.',
  'Készlethiánynál a szolgáltatási kockázat, helyettesíthetőség, lejárat és beszerzési idő alapján kell prioritást képezni.',
  'Teljesítményértékelésnél objektív mutatót, minőségi bizonyítékot és fejlesztési akciót kell összekapcsolni.'
 ],[
  'Vezetői auditnál a szabály megléte önmagában nem elég; a tényleges végrehajtás és hatékonyság bizonyítékát is ellenőrizni kell.',
  'Súlyos vagy ismétlődő eltérésnél gyökérok-elemzésből megelőző intézkedést, felelőst, határidőt és visszaellenőrzést kell képezni.',
  'Új szolgáltatás bevezetése előtt kompetencia-, jogi, higiéniai, vegyi, eszköz-, adatvédelmi és pénzügyi kockázatot is értékelni kell.',
  'A vezetői jóváhagyás nem írhat felül kötelező jogi, munkavédelmi, gyártói vagy szakmai biztonsági korlátot.',
  'A szalon tudásrendszerét forrásfelülvizsgálattal, verziókezeléssel, teszteredményekkel és célzott utánképzéssel kell fejleszteni.'
 ],['Veszélyes anyag kockázatánál a megelőzési hierarchia alkalmazását és a munkatársak megfelelő tájékoztatását biztosítani kell.','Higiéniai, műszaki vagy adatvédelmi kritikus eltérésnél a termelési/értékesítési cél nem előzheti meg a biztonságot.']),
 P('inventory','Készlet- és beszerzési munkatárs',['készlet','beszerzés','beszerző','beszerzo','raktár','raktar','raktáros','raktaros','warehouse','procurement'],'Készlet és beszerzés','SRC-NNGYK-COSMETICS-2026','SRC-ECHA-SDS-2026',[
  'Bevételezéskor a terméket, mennyiséget, tételazonosítót, lejáratot vagy felhasználhatósági információt és sértetlenséget ellenőrizni kell.',
  'Lejárt, sérült, visszahívott vagy azonosíthatatlan készletet a felhasználható készlettől el kell különíteni.',
  'Lejáratos készletnél a leghamarabb lejáró még felhasználható tétel elsőbbsége csökkenti a selejtet.',
  'Veszélyes vegyi terméknél a címkének és szükség esetén a biztonsági adatlapnak hozzáférhetőnek kell lennie.',
  'Készletkorrekciót, selejtezést és belső átadást indokkal és visszakövethető bizonylattal kell rögzíteni.'
 ],[
  'Beszerzésnél az ár mellett a megfelelőség, tételkövetés, szállítási feltétel, lejárat, biztonsági információ és beszállítói megbízhatóság is értékelendő.',
  'CLP szerinti veszélyes termék címkéjén a termékazonosító és adott esetben piktogram, figyelmeztetés, H/P mondatok alapvető információk.',
  'Biztonsági adatlapból a veszély, kezelés, tárolás, elsősegély, tűzvédelem és expozíciókontroll információit kell az érintett folyamatba átvezetni.',
  'Kritikus készlethiánynál a helyettesítő termék szakmai kompatibilitását a szolgáltatási felelőssel kell megerősíteni.',
  'Eltérő rendszer- és fizikai készletnél a tranzakciókat, mozgásokat, selejtet és hozzáféréseket vissza kell keresni.'
 ],[
  'Beszállítói minősítésnél a reklamáció, szállítási pontosság, tételkövethetőség, megfelelőségi dokumentum és kockázat trendjeit együtt kell értékelni.',
  'Visszahívásnál a tételt gyorsan azonosítani, zárolni, felhasználási helyét visszakeresni és az érintetteket értesíteni kell.',
  'Új veszélyes anyag bevezetése előtt a kevésbé veszélyes helyettesítés lehetőségét és az expozíciócsökkentést is értékelni kell.',
  'Készletpolitika kialakításánál forgalom, átfutás, minimumkészlet, lejárati kockázat és szolgáltatási kritikalitás alapján kell paraméterezni.',
  'Auditálható raktári folyamatnál minden kritikus mozgásnak azonosítható felhasználóhoz, időponthoz, okhoz és tételhez kell kapcsolódnia.'
 ],['A vegyi kockázat kezelésében a megszüntetés/helyettesítés és a műszaki-szervezési kontroll megelőzi az egyéni védőeszközt.','Ismeretlen, sérült címkéjű vagy azonosíthatatlan vegyi termék nem adható ki rutin felhasználásra.']),
 P('trainer','Szakmai oktató / Mentor',['szakmai oktató','szakmai oktato','oktató','oktato','trainer','mentor'],'Oktatás','SRC-IKK-KKK-ACADEMY','SRC-IKK-BEAUTY-ACADEMY',[
  'A betanítás célját megfigyelhető és értékelhető tanulási eredményként kell megfogalmazni.',
  'A demonstráció során a műveleti sorrendet, döntési pontokat, kockázatokat és hibamegelőzést is láthatóvá kell tenni.',
  'A tanuló önálló gyakorlása előtt meg kell győződni a szükséges higiéniai és munkavédelmi alapokról.',
  'A visszajelzés konkrét viselkedésre vagy eredményre irányuljon, és tartalmazzon javítási lépést.',
  'A tudásellenőrzés kérdéseinek a tényleges munkaköri kompetenciát kell mérniük, nem pusztán definíciók felidézését.'
 ],[
  'Haladó képzésben esetalapú feladattal kell mérni, hogy a tanuló felismeri-e a döntési és leállítási pontokat.',
  'Értékelésnél előre rögzített kritériumot, bizonyítékot és egységes megfelelési küszöböt kell alkalmazni.',
  'Gyakori hibákból célzott ismétlő modult és gyakorlati korrekciót kell készíteni.',
  'Új szakmai anyag csak ellenőrzött forrásból, verzióval és felülvizsgálati dátummal kerüljön a belső tudástárba.',
  'Mentori felügyeletet a tanuló bizonyított kompetenciája alapján fokozatosan lehet csökkenteni.'
 ],[
  'Szakértői vizsgáztatásnál a komplex esetben hozott döntés indoklását, kockázatkezelését és dokumentációját együtt kell értékelni.',
  'A tesztbank minőségét kérdésnehézség, hibaarány, félreérthetőség és tanulási eredmény szerinti lefedettség alapján kell felülvizsgálni.',
  'Kompetenciahiánynál a sikertelen teszt önmagában nem lezárás; célzott tananyag, gyakorlat és újramérés szükséges.',
  'Oktatási anyag frissítésekor a régi verziót archiválni, az új forrást és változás okát pedig dokumentálni kell.',
  'Mentorok közötti eltérő értékelést kalibrációval, közös esetekkel és értékelési rubrikával kell csökkenteni.'
 ],['Oktatásban is kötelező a munkavédelmi és higiéniai szabály; gyakorlási cél nem indokolhat veszélyes kivételt.','A tanuló csak olyan feladatot végezzen önállóan, amelyhez a szükséges kompetenciát és biztonsági ismeretet már igazolta.']),
 P('cashier','Pénztáros / Pénzügyi recepció',['pénztáros','penztaros','cashier','pénzügyi munkatárs','penzugyi munkatars'],'Pénztár és bizonylat','SRC-NAV-ENYUGTA-2026','SRC-EU-GDPR-BREACH-2026',[
  'A fizetési módot és összeget a tényleges tranzakció szerint kell rögzíteni.',
  'A bizonylatot a megfelelő üzleti eseményhez kell kapcsolni, és a duplikált vagy hiányzó bizonylatot ki kell vizsgálni.',
  'Készpénzes eltérésnél a pénztármozgásokat és bizonylatokat vissza kell keresni, nem szabad becsléssel kiegyenlíteni.',
  'Visszatérítés vagy sztornó csak jogosultság, indok és visszakövethető bizonylat mellett történhet.',
  'Pénzügyi bizonylaton szereplő személyes adatot csak feladathoz szükséges mértékben szabad kezelni.'
 ],[
  'Napzárásnál a rendszer szerinti és fizikai pénzeszköz, bankkártyás összesítő és kapcsolódó bizonylatok egyezőségét kell ellenőrizni.',
  '2026. szeptember 1-től a kézi és számítógépes nyugták adatát a NAV előírása szerint kell szolgáltatni.',
  'A nyugtaadat-szolgáltatás napi összesítésben, adómértékek szerinti bontásban történik.',
  'A kibocsátást követő adatszolgáltatási határidő 3 naptári nap, ezért a hibát határidőn belül kell kezelni.',
  'Hibás adózási vagy bizonylati helyzetnél a jogosult pénzügyi/könyvelési felelőst kell bevonni, nem szabad önkényes javítást végezni.'
 ],[
  'Pénzügyi kontrollnál a kivételkezelés, jogosultság, sztornó, visszatérítés és manuális korrekció trendjeit csalás- és hibakockázat szerint kell elemezni.',
  'A KOBAK kézi rögzítési és M2M gépi adatszolgáltatási lehetőség közötti folyamatot a használt bizonylati rendszerhez kell illeszteni.',
  'NAV-adatszolgáltatási hiba esetén a forrásbizonylatot, napi összesítést, adómértéket és beküldési állapotot együtt kell visszakeresni.',
  'Rendszerváltozás előtt pénzügyi regressziós tesztben a fizetés, bizonylat, sztornó, visszatérítés és napzárás teljes láncát ellenőrizni kell.',
  'Auditálható pénztárban a kritikus korrekcióknak azonosítható felhasználóhoz, időponthoz, indokhoz és jóváhagyáshoz kell kapcsolódniuk.'
 ],['Pénztár- és vendégadatot illetéktelen személynek nem szabad megjeleníteni vagy továbbítani.','Adatszolgáltatási határidő vagy rendszerhiba esetén a problémát dokumentálni és felelősnek eszkalálni kell.']),
 P('marketing','Marketing / Kampánymenedzser',['marketing','marketinges','marketing manager','kampánymenedzser','kampanymenedzser','campaign'],'Marketing','SRC-EU-GDPR-BREACH-2026','SRC-NNGYK-COSMETICS-2026',[
  'Kampányhoz csak a célhoz szükséges személyes adatot szabad felhasználni.',
  'A címzettlista, kommunikációs preferencia és alkalmazott jogalap ellenőrzése a kiküldés előtti folyamat része.',
  'Egészségügyi vagy kozmetikai állítást csak megfelelően alátámasztott, nem megtévesztő formában szabad használni.',
  'Kampányteszt során valós vendégadat helyett lehetőség szerint tesztadatot kell használni.',
  'Téves címzett vagy jogosulatlan export adatvédelmi incidens lehet, ezért azonnali belső eszkalációt igényel.'
 ],[
  'Szegmentálásnál az adatminimalizálást és a szükséges célváltozókat kell előnyben részesíteni a korlátlan profilépítéssel szemben.',
  'A/B tesztnél előre rögzített célmutató és megfelelő minta szükséges, utólagos eredményválogatás nélkül.',
  'Kozmetikai kommunikációban a termék- vagy kezelésállítás nem lépheti túl a bizonyítható és jogszerű kommunikáció keretét.',
  'Kampányindítás előtt a linket, céloldalt, kupont, időszakot, telephelyet és célcsoportot teljes folyamatban kell tesztelni.',
  'Leiratkozási vagy kommunikációs preferencia változását a lehető leggyorsabban át kell vezetni az érintett csatornákon.'
 ],[
  'Marketing governance során a célcsoportképzés, export, hozzáférés, automatizmus és megőrzési idő kockázatait rendszeresen felül kell vizsgálni.',
  'Incidens után nem elég a hibás kampány leállítása; a kiváltó rendszer- vagy folyamatokot és megelőző kontrollt is azonosítani kell.',
  'AI-alapú ajánlásnál a felhasznált adat, cél, hozzáférés és téves/érzékeny következtetés kockázatát külön kell kezelni.',
  'Franchise-kampányban a központi és helyi adatkezelési szerepeket, jogosultságokat és felelősségeket egyértelműen kell rögzíteni.',
  'Szakértői kampányauditban a jogszerűség, adatminimalizálás, állítások, technikai működés és üzleti eredmény együtt értékelendő.'
 ],['Címzettlista vagy export hozzáférését csak a feladathoz szükséges személyekre kell korlátozni.','Adatvédelmi incidensnél a terjedés megállítása és a belső kockázatértékelés azonnali feladat.']),
 P('hr','HR / Személyügy',['hr','hr manager','humán erőforrás','human resources','személyügy','szemelyugy'],'HR','SRC-EU-GDPR-BREACH-2026','SRC-OSHA-CHEM',[
  'Munkatársi dokumentumhoz csak a feladathoz szükséges jogosultsággal szabad hozzáférni.',
  'Belépéskor a munkakör, jogosultság, kötelező betanítás és felelős státuszát visszakövethetően kell kezelni.',
  'Kilépéskor a rendszerhozzáféréseket és fizikai jogosultságokat időben vissza kell vonni.',
  'Egészségügyi vagy egyéb érzékeny munkatársi adatot fokozott hozzáférés-védelemmel kell kezelni.',
  'Téves címzettnek küldött HR-dokumentum adatvédelmi incidens lehet, ezért azonnali belső jelentést igényel.'
 ],[
  'Munkaköri kompetenciamátrixban a szükséges képesítést, belső betanítást, tesztet és lejáró/megújítandó jogosultságot együtt kell követni.',
  'Teljesítményértékelésnél előre ismert kritériumot, releváns bizonyítékot és fejlesztési akciót kell használni.',
  'Képzési hiányt a munkaköri kockázat és üzleti hatás alapján kell priorizálni, nem csak az igénylés sorrendje szerint.',
  'Új munkakör létrehozásakor feladat, felelősség, jogosultság, kompetencia és adathozzáférés együttes tervezése szükséges.',
  'HR-riportban a személyes adatok körét és láthatóságát a döntési célhoz kell minimalizálni.'
 ],[
  'HR-auditban a jogosultság életciklusát belépéstől munkakörváltáson át kilépésig bizonyítékokkal kell ellenőrizni.',
  'Ismétlődő kompetenciahiánynál a kiválasztás, betanítás, munkautasítás, mentorálás és tesztelés gyökérokait együtt kell elemezni.',
  'Magas kockázatú munkakörhöz a szükséges szakmai képesítés és belső kompetencia igazolása nélkül nem adható teljes önálló jogosultság.',
  'Adatvédelmi incidens után a hozzáférési modellt, megosztási folyamatot és képzést is felül kell vizsgálni, nem csak az egyedi hibát.',
  'Szakértői HR governance-ben a munkaköri követelmény, képzés, teszteredmény és tényleges teljesítmény közötti eltérést rendszeresen elemezni kell.'
 ],['A munkavállalót érintő munkavédelmi kockázatról és megelőző intézkedésről megfelelő tájékoztatást kell adni.','A személyes adathozzáférés nem jár automatikusan a vezetői státusszal; feladat- és jogosultságalapú korlátozás szükséges.']),
 P('admin','Adminisztrátor / VIR admin',['admin','administrator','rendszergazda','superadmin','super_admin','vir admin','adminisztrátor','adminisztrator'],'Adminisztráció','SRC-EU-GDPR-BREACH-2026','SRC-NAV-ENYUGTA-2026',[
  'Felhasználói jogosultságot a munkaköri szükséglethez kell igazítani, és a felesleges hozzáférést kerülni kell.',
  'Kritikus törzsadat-módosítást és adminisztratív beavatkozást visszakövethető auditnyommal kell kezelni.',
  'Vendég- vagy munkatársi adat exportja csak indokolt célhoz és megfelelő jogosultsággal történhet.',
  'Rendszerhiba esetén a tényt, időpontot, érintett funkciót és hatást dokumentálni kell.',
  'Adatvédelmi incidens gyanúját nem szabad a technikai kivizsgálás végéig visszatartani a belső felelőstől.'
 ],[
  'Szerepkör kialakításánál a legkisebb szükséges jogosultság és a feladatok szétválasztása csökkenti a hibás vagy visszaélésszerű művelet kockázatát.',
  'Éles konfigurációváltozás előtt hatáselemzés, teszt, visszaállítási terv és szükséges jóváhagyás indokolt.',
  'Pénzügyi vagy NAV-funkció módosításakor a teljes üzleti láncot, nem csak az adott képernyőt kell regressziósan ellenőrizni.',
  'Auditnapló esetén az esemény, felhasználó, időpont, objektum és változás tartalma együtt ad visszakövethetőséget.',
  'Hozzáférési hiba vagy téves adatküldés esetén a további hozzáférést/terjedést azonnal korlátozni kell.'
 ],[
  'Szakértői jogosultságauditban az elméleti szerepkört a tényleges effektív hozzáféréssel és kivételjogosultságokkal kell összevetni.',
  'Kritikus konfiguráció változtatását négy szem elvvel vagy más független kontrollal érdemes védeni, ha a kockázat indokolja.',
  'Incidens után a napló, jogosultság, változás, adatáramlás és helyreállítás bizonyítékait időrendben kell összerakni.',
  'Franchise/SaaS környezetben a tenant-szigetelés tesztelése kötelező elem minden olyan funkciónál, amely üzleti adatot olvas vagy módosít.',
  'Szakértői üzemeltetési kontrollnak mérnie kell a hibák ismétlődését, javítás átfutását, regressziót és megelőző intézkedés hatékonyságát.'
 ],['Adminisztratív hozzáférésnél az érzékeny adatok és pénzügyi funkciók fokozott kontrollt igényelnek.','Incidens esetén a bizonyítékok megőrzése mellett elsődleges a további kár és adatterjedés korlátozása.']),
];

const commonCommunication=[
 'A vendéggel vagy belső ügyféllel a szolgáltatás célját, korlátait és következő lépését érthetően egyeztetni kell.',
 'A lényeges szakmai vagy üzleti döntést az eseményhez közel, tényszerűen és visszakövethetően kell dokumentálni.',
 'Bizonytalan vagy kompetenciahatárt érintő helyzetben a megfelelő felelősnek kell eszkalálni, nem improvizálni.',
 'A személyes adatot csak a feladat végrehajtásához szükséges körben szabad használni és megjeleníteni.',
 'Panasz vagy eltérés esetén a tényt, hatást, azonnali intézkedést és további felelőst külön kell rögzíteni.'
];
const commonRisk=[
 'Eltérésnél először a vendég, munkatárs, adat vagy vagyon további veszélyeztetését kell megszüntetni vagy csökkenteni.',
 'A tüneti javítás mellett meg kell keresni, hogy folyamat-, eszköz-, anyag-, képzési vagy jogosultsági ok áll-e a háttérben.',
 'A gyártói, jogi vagy szakmai biztonsági korlátot a rutin, időnyomás vagy értékesítési cél nem írhatja felül.',
 'A korrekciót felelőssel, határidővel és visszaellenőrizhető eredménykritériummal kell lezárni.',
 'Ismétlődő eltérésnél trendet kell vizsgálni és megelőző intézkedést kell bevezetni.'
];
const commonQuality=[
 'Minőségértékelésnél az eredményt, folyamatbetartást, vendég-/ügyfélvisszajelzést és dokumentációt együtt kell vizsgálni.',
 'A korrekció okát és eredményét úgy kell rögzíteni, hogy egy későbbi ellenőrzésből rekonstruálható legyen.',
 'A visszatérő hiba célzott oktatást, folyamatmódosítást vagy műszaki kontrollt indokolhat.',
 'Új eljárás bevezetését próba, ellenőrzési pont és visszamérés kövesse.',
 'Az utánkövetésnek igazolnia kell, hogy a bevezetett intézkedés valóban csökkentette a hibát vagy kockázatot.'
];
const commonExpertAudit=[
 'Szakértői auditban a szabályozás megléte mellett a tényleges végrehajtás bizonyítékát és a kontroll hatékonyságát is ellenőrizni kell.',
 'A kritikus döntés indoklásának visszakövethetőnek kell lennie forrásra, megfigyelésre és kockázatértékelésre.',
 'Mentoráláskor a végrehajtás mellett a döntési pontok és leállítási feltételek megértését is ellenőrizni kell.',
 'Eltérő szakmai gyakorlatot egységes kritériumokkal és kalibrációval kell összehangolni.',
 'A tudásanyagot forrás, verzió, felülvizsgálati dátum és változás oka szerint kell karbantartani.'
];
const commonImprovement=[
 'Folyamatfejlesztés előtt mérni kell a jelenlegi hibát, átfutást vagy kockázatot, hogy a változás hatása összehasonlítható legyen.',
 'A gyökérokot bizonyíték alapján kell kiválasztani, nem a legkézenfekvőbb feltételezés alapján.',
 'A megelőző intézkedéshez mérhető sikerkritériumot és utóellenőrzési időpontot kell rendelni.',
 'A változtatás kockázatát és más folyamatokra gyakorolt mellékhatását bevezetés előtt fel kell mérni.',
 'Sikeres fejlesztést csak dokumentált eredmény és stabil működés után szabad standard folyamattá tenni.'
];

const levelLabel=(level:AcademyLevel)=>academyLevels.find(x=>x.key===level)?.label||level;
const mat=(p:AcademyProfession,level:AcademyLevel,n:number,title:string,category:string,summary:string,source_code:string,learning_points:string[]):AcademyMaterial=>({
 code:`KBA-${p.key.toUpperCase()}-${level==='beginner'?'B':level==='advanced'?'A':'E'}-${String(n).padStart(2,'0')}`,
 title,roles:p.roles,category,summary,learning_points,source_code,level,level_label:levelLabel(level),profession:p.key,profession_label:p.label
});

function materialsForProfession(p:AcademyProfession):AcademyMaterial[]{
 return[
  mat(p,'beginner',1,`${p.label} – szakmai alapok`,p.category,'A biztonságos, önálló alapfeladatokhoz szükséges szakmai döntési pontok.',p.professional_source,p.beginner),
  mat(p,'beginner',2,`${p.label} – higiénia és biztonság`,'Higiénia és munkavédelem','A szolgáltatás vagy munkafolyamat közvetlen higiéniai és biztonsági kontrolljai.',p.safety_source,[...p.safety,'A munkaterületet és eszközöket a feladat előtt ellenőrizni kell.','Rendellenes állapotnál a rutinfeladatot fel kell függeszteni a kockázat tisztázásáig.','A gyártói és belső biztonsági előírásoknak hozzáférhetőnek kell lenniük.']),
  mat(p,'beginner',3,`${p.label} – kommunikáció és dokumentáció`,'Vendégélmény és dokumentáció','Alapvető kommunikáció, adatminimalizálás, eltérés- és panaszrögzítés.','SRC-EU-GDPR-BREACH-2026',commonCommunication),
  mat(p,'advanced',1,`${p.label} – haladó szakmai döntések`,p.category,'Összetettebb helyzetek felismerése, tervezése és biztonságos megoldása.',p.professional_source,p.advanced),
  mat(p,'advanced',2,`${p.label} – eltérések és kockázatkezelés`,'Kockázatkezelés','Azonnali hatáskorlátozás, okfeltárás és megelőző intézkedés.',p.safety_source,commonRisk),
  mat(p,'advanced',3,`${p.label} – minőség és utánkövetés`,'Minőségbiztosítás','Eredményértékelés, korrekció, trendek és utánkövetési bizonyítékok.',p.professional_source,commonQuality),
  mat(p,'expert',1,`${p.label} – komplex szakértői esetek`,p.category,'Komplex helyzeteknél több kockázat és szakmai döntési tényező együttes kezelése.',p.professional_source,p.expert),
  mat(p,'expert',2,`${p.label} – audit, mentorálás és kompetencia`,'Audit és oktatás','Auditálható döntés, kompetenciahatár, mentorálás és tudásverzió-kezelés.','SRC-IKK-KKK-ACADEMY',commonExpertAudit),
  mat(p,'expert',3,`${p.label} – folyamatfejlesztés`,'Folyamatfejlesztés','Gyökérok, megelőző intézkedés, mérhető visszaellenőrzés és standardizálás.',p.safety_source,commonImprovement),
 ];
}

export const academyMaterials:AcademyMaterial[]=academyProfessions.flatMap(materialsForProfession);

const norm=(value:string)=>value.toLocaleLowerCase('hu-HU').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();
export function academyProfessionByKey(key:string|undefined|null){return academyProfessions.find(p=>p.key===String(key||'').trim())}
export function academyProfessionForRole(role:string):AcademyProfession{
 const n=norm(String(role||''));
 const match=academyProfessions.find(p=>p.roles.some(r=>{const a=norm(r);return a&&n.includes(a)}));
 return match||academyProfessionByKey('admin')!;
}
export function academyMaterialsForProfession(key:string){return academyMaterials.filter(x=>x.profession===key)}
export function academyMaterialsForRole(role:string){return academyMaterialsForProfession(academyProfessionForRole(role).key)}

const distractors:Record<AcademyLevel,string[]>={
 beginner:['A lépés elhagyható, ha a munkatárs rutinos.','Elegendő utólag, emlékezetből rendezni a folyamatot.','A vendég vagy üzleti cél kérésére a biztonsági korlát figyelmen kívül hagyható.','Csak akkor kell dokumentálni, ha már panasz érkezett.'],
 advanced:['A rutinos munkavégzés önmagában helyettesíti az ellenőrzést és a dokumentációt.','Az eltérés lezárható a tünet megszüntetésével, az ok visszakeresése nélkül.','A gyorsabb kiszolgálás érdekében a gyártói vagy szakmai korlát egyedi döntéssel felülírható.','A korrekció eredményét nem szükséges visszaellenőrizni, ha azonnal javulást mutat.'],
 expert:['A vezetői jóváhagyás önmagában helyettesíti a szakmai vagy jogi kockázatértékelést.','Az auditban a szabályzat megléte elegendő bizonyíték a tényleges végrehajtás vizsgálata nélkül.','A dokumentált eltérés önmagában megelőző intézkedésnek tekinthető.','A komplex esetben a korábbi rutin fontosabb, mint az aktuális állapotból származó bizonyíték.']
};
const stems:Record<AcademyLevel,string[]>={
 beginner:['Melyik gyakorlat felel meg a tananyagnak?','Melyik eljárás tekinthető helyes alaplépésnek?','Melyik állítás illeszkedik a biztonságos munkavégzéshez?'],
 advanced:['Összetettebb helyzetben melyik döntés illeszkedik a tananyaghoz?','Eltérés vagy kockázat esetén melyik elv a helyes?','Haladó munkavégzésnél melyik gyakorlat visszakövethető és szakmailag indokolt?'],
 expert:['Szakértői felülvizsgálat során melyik állítás a helyes?','Komplex esetben melyik döntési elv felel meg a tananyagnak?','Auditálható szakértői gyakorlatként melyik állítás fogadható el?']
};

function questionFromMaterial(m:AcademyMaterial,point:string,pointIndex:number,globalIndex:number):QuizQuestion{
 const wrong=distractors[m.level];
 const variants=[point,wrong[(globalIndex+1)%wrong.length],wrong[(globalIndex+2)%wrong.length]];
 const shift=globalIndex%3;
 const answers=[variants[(3-shift)%3],variants[(4-shift)%3],variants[(5-shift)%3]];
 const correct=answers.indexOf(point);
 return{
  id:`academy-${m.profession}-${m.level}-${m.code.toLowerCase()}-${pointIndex+1}`,
  roles:m.roles,
  topic:`${m.category} · ${m.level_label}`,
  q:`${m.title}: ${stems[m.level][globalIndex%stems[m.level].length]}`,
  answers,correct,
  explanation:`A kapcsolódó tananyagban rögzített helyes elv: ${point}`,
  source_code:m.source_code
 };
}
export const academyQuizQuestions:QuizQuestion[]=academyMaterials.flatMap((m,mi)=>m.learning_points.map((p,pi)=>questionFromMaterial(m,p,pi,mi*10+pi)));
export function academyQuestionsForProfession(key:string,level:AcademyLevel){return academyQuizQuestions.filter(q=>q.id.startsWith(`academy-${key}-${level}-`))}
export function academyQuestionsForRole(role:string,level:AcademyLevel){return academyQuestionsForProfession(academyProfessionForRole(role).key,level)}

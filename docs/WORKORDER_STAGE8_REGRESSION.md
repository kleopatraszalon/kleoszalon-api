# Munkalap – 8. etap regressziós és jogosultsági teszt

## Cél
A teljes munkalap-folyamat ellenőrzése: foglalás/walk-in → vendég → tételek → anyag/készlet → ellenőrzés → kevert fizetés → lezárás → archiválás.

## Jogosultsági mátrix
| Szerepkör | Lista | Részletek | Saját szalon | Saját munkalap | Módosítás | Fizetés/lezárás |
|---|---|---|---|---|---|---|
| Admin | minden | minden | minden | minden | igen | igen |
| Recepciós | saját szalon | saját szalon | igen | - | igen | igen |
| Üzletvezető | saját szalon | saját szalon | igen | - | igen | igen |
| Szalonvezető | saját szalon | saját szalon | igen | - | nem | nem |
| Munkatárs | saját | saját | csak kapcsolt | igen | nem | nem |
| Ügyfél | saját | saját | - | igen | nem | nem |

## Kötelező regressziós esetek
1. Foglalásból munkalap: a foglalás vendége, szalonja, munkatársa és szolgáltatása átkerül; ugyanahhoz a foglaláshoz nem keletkezhet véletlen duplikált munkalap.
2. Walk-in: foglalás nélkül új munkalap létrehozható meglévő vagy új vendéggel.
3. Normál fizetés: 100% készpénz vagy 100% bankkártya, eltérés = 0, lezárás engedélyezett.
4. Kevert fizetés: több normál fizetési sor összege pontosan a fennmaradó fizetendő összeg.
5. Loyalty: kupon/wallet/pont/bérlet/utalvány + normál fizetés együtt használható; ugyanaz a kedvezmény/felhasználás nem könyvelhető kétszer.
6. Anyag: kötelező anyag hiánya blokkolja az Ellenőrzést; készlethiány blokkolja a lezárást és készletfeltöltési igény indítható.
7. Lezárás: csak in_progress munkalap, hibamentes ellenőrzés és 0 Ft fizetési eltérés mellett.
8. Lezárás utáni állapot: status=completed, document_status=completed, closed_at kitöltve, kapcsolt időpont completed.
9. Archiválás/zárolás: lezárt munkalap módosítása és újabb fizetése tiltott; archív snapshot visszaolvasható.
10. Telephely-scope: recepciós/üzletvezető másik szalon munkalapját nem láthatja és nem módosíthatja.
11. Read-only scope: szalonvezető, munkatárs és ügyfél pénzügyi/módosító művelete 403.
12. Hibás azonosító: érvénytelen UUID 400, nem látható munkalap 404, nem belső 500.

## API ellenőrzési pontok
- GET /api/workorders
- GET /api/workorders/dashboard/summary
- GET /api/workorders/:id
- GET /api/workorders/:id/archive
- PATCH /api/workorders/:id/lifecycle
- pénztári/loyalty cashier végpontok
- véglegesítő/finalization végpont

## Elfogadási kritérium
A 12 kötelező eset mindegyike PASS; nincs 500-as válasz üzleti validációra; jogosultságsértés 403/404; lezárt munkalap immutable; pénzügyi, készlet-, loyalty- és időpontállapot konzisztens.
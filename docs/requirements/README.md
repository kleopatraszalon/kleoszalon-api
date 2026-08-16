# Tesztelhető követelményalap

Ez a könyvtár a **Kleoszalon Kft. Vállalatirányítási Rendszer – Szoftverfejlesztési Specifikáció v2** tesztelhetőségi kiegészítése. A PDF üzleti tartalmát nem írja át; stabil azonosítókat, objektív elfogadási kritériumokat, teszteset-kapcsolatokat és automatikus minőségkaput ad hozzá.

## Mi számít 10/10-nek?

| Pont | Követelmény | Automatikus ellenőrzés |
|---:|---|---|
| 1,0 | Egyedi, szabályos és nem újrahasznosítható követelmény-ID | `catalog.cjs` + validátor |
| 1,0 | Atomi, egyértelmű követelménymondat és pontos PDF-forrás | validátor |
| 2,0 | Legalább két, egyedi ID-jű Given–When–Then elfogadási kritérium | validátor |
| 1,5 | Minden kritériumhoz ellenőrzési módszer és teszteset-ID | validátor |
| 1,5 | Kétirányú követelmény → kritérium → teszteset nyomonkövetés | generált mátrix |
| 1,0 | Prioritás, felelős szerepkör és életciklus-állapot | validátor |
| 1,0 | Kötelező változáskezelési szabály | katalógus + PR-szabály |
| 1,0 | CI-ben futó, eltérés esetén hibára álló kapu | GitHub Actions |

Az elvárt eredmény **10,0/10**. A validátor bármely részpont elvesztésekor hibakóddal áll le.

## Azonosítók

- Követelmény: `KLEO-{GEN|FUN|NFR}-{TERÜLET}-{NNN}`
- Elfogadási kritérium: `{KÖVETELMÉNY-ID}-AC-{NN}`
- Teszteset: `TC-{ELFOGADÁSIKRITÉRIUM-ID}`

Az azonosító kiadás után nem módosítható és nem használható újra. Megszűnt követelményt `deprecated` állapotban kell megtartani.

## Definition of Ready

Követelmény csak akkor fejleszthető, ha:

1. van egyedi ID-ja, PDF-oldal- és szakaszhivatkozása;
2. egy megfigyelhető rendszer-viselkedést ír le;
3. legalább két Given–When–Then kritériuma van, minden kritériumnak saját ID-val;
4. minden kritériumhoz tartozik ellenőrzési módszer és teszteset-ID;
5. ismert a prioritás, a felelős szerepkör és az életciklus-állapot;
6. a Product Owner jóváhagyta.

## Státuszok és bizonyíték

Az `automation_status: planned` azt jelenti, hogy a követelmény **tesztelhető**, de az automata teszt végrehajtási bizonyítéka még nincs kész. Az `automated` státuszhoz legalább egy létező tesztfájl-hivatkozás kötelező. A funkcionális készültséget ezért nem szabad a 10/10 tesztelhetőségi pontszámmal összekeverni.

Manuális, biztonsági, teljesítmény- vagy hibatűrési tesztnél a végrehajtási bizonyítéknak tartalmaznia kell a teszteset-ID-t, verziót, környezetet, végrehajtót, időpontot, eredményt és bizonyítékhivatkozást.

## Módosítási folyamat

1. A követelmény és az összes érintett kritérium ugyanabban a pull requestben változik.
2. A változáskor a kapcsolt teszteket és bizonyítékigényt is felül kell vizsgálni.
3. Futtatás: `npm run requirements:check`.
4. Mátrix frissítése: `npm run requirements:matrix`.
5. A PR csak Product Owner-jóváhagyással és sikeres CI-kapuval egyesíthető.

A [TRACEABILITY.md](./TRACEABILITY.md) generált nézet; kézzel nem szerkesztendő.

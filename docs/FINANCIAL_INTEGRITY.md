# Pénzügyi integritási szabályzat és technikai kapu

Forrás: Kleoszalon VIR Szoftverfejlesztési Specifikáció v2, 19–25. oldal; kapcsolódó készlet–pénzügy folyamatok: 30–33. oldal.

## 10/10 kontrollmodell

| Pont | Kontroll | Kikényszerítés |
|---:|---|---|
| 1 | Minden többtáblás pénzügyi művelet atomi | PostgreSQL `BEGIN/COMMIT/ROLLBACK` |
| 1 | A pénzmozgás-főkönyv nem törölhető és könyvelt tartalma nem írható át | adatbázis-trigger |
| 1 | Visszavonás csak pontos, ellenkező irányú ellenkönyveléssel | közös sztornószolgáltatás + trigger |
| 1 | Egy eredeti tételhez legfeljebb egy sztornó tartozhat | egyedi adatbázis-index |
| 1 | Lezárt időszakra új tétel nem könyvelhető | konfigurálható időszakzár + trigger |
| 1 | Nem engedélyezett negatív számlaegyenleg blokkolt | számlazár + adatbázis-trigger |
| 1 | Átvezetés két lába azonos összegű és ellentétes irányú | halasztott tranzakciós trigger |
| 1 | Hálózati újrapróbálás nem kettőz pénzügyi tételt | kötelező idempotenciakulcs + egyedi index |
| 1 | Visszatérítés, kasszamozgás és főkönyvi tétel összekapcsolt | idegen hivatkozás + egyezőségi riport |
| 1 | Főkönyvi tartozik/követel egyenleg és auditbizonyíték ellenőrzött | halasztott egyenleg-trigger + append-only eseménynapló |

## Kötelező szabályok

- Pénzügyi „törlés” nem létezik. Az eredeti tétel megmarad, a korrekció új ellenkönyvelési tétel.
- Sztornótétel nem sztornózható; új korrekciós üzleti esemény szükséges.
- A sztornó oka legalább három karakter, a végrehajtó és a kapcsolt tétel kötelező.
- Lezárt időszak csak vezetői feloldási indokkal nyitható meg; a feloldás eseménye megmarad.
- Pénzügyi írási kéréshez `Idempotency-Key` fejléc kötelező. Ugyanaz a kulcs ugyanabban a hatókörben nem könyvelhet kétszer.
- Készpénzt érintő művelethez nyitott pénztári műszak szükséges.
- Minden új munkalapfizetés ugyanabban a tranzakcióban kapcsolt bevételi főkönyvi tételt kap; kapcsolt tétel nélkül a tranzakció nem zárható le.
- Ajándékutalvány és vendég-wallet beváltása előrefizetés-felhasználás: auditálódik, de nem hoz létre új bevételt. Az árbevétel az utalvány vagy feltöltés értékesítésekor keletkezik.
- A pénztárzár és a napi fizetések közös adatbázis-zárat használnak; a zárási pillanat mögé nem versenyezhet be későbbi tétel, a zárás összegeit az adatbázis újraszámolja.
- Az egyezőségi riport bármely nem nulla eltérése kiadást blokkoló esemény.

## Üzemeltetés

- Automata ellenőrzés: `npm run test:financial-integrity`.
- Egyezőség: `GET /api/transactions/finance-v5/integrity/reconciliation`.
- Időszakzárak: `GET/POST /api/transactions/finance-v5/integrity/period-locks`.
- Feloldás: `POST /api/transactions/finance-v5/integrity/period-locks/:id/release`.

# Pénztár Stage 14 – VIR specifikáció és Altegio megfelelés

A Stage 14 a már működő Stage 13 pénztári műszakmodellre épül.

## VIR specifikációból lezárt hiányok
- címletenkénti pénztárszámolás és köztes ellenőrzés
- előző záróállás összevetése
- manuális bevétel/kiadás tranzakciótípussal, partnerrel, alkalmazottal és bizonylatszámmal
- több pénzügyi pénztár/számla és átvezetés

## Altegio-paritás
- konfigurált fizetési módok és pénzügyi számla hozzárendelés
- osztott fizetés megtartása
- kártyamárka és tranzakciós díj
- fizetéstörténet
- részleges/teljes refund auditnaplóval
- készpénzes refund csak nyitott műszaknál, kasszakivétként

A további VIR/Altegio gap-ek külön etapokban kerülnek normalizált üzleti folyamatokra: CRM mélyítés, 4Hands/resource booking, panasz/SLA, feladat-jóváhagyás, riportütemezés és értékelések.

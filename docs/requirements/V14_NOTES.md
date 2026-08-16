# KLEO acceptance automation v14 – large finance/security batch

A v14 csomag 10 új acceptance criteriont emel automatizált evidence alá.

- `KLEO-FUN-FIN-002-AC-01/02`: nyitott pénztári műszakban bevétel/kiadás könyvelése, zárt napi kassza fail-closed tiltása.
- `KLEO-NFR-SEC-002-AC-01/02`: BCrypt jelszótárolás és hash-mentes hitelesítési válaszok.
- `KLEO-NFR-SEC-003-AC-01/02`: kizárólag szerveroldali JWT kulcs, módosított/lejárt token 401.
- `KLEO-NFR-RES-001-AC-01`: elveszett válasz utáni kritikus írás idempotens újrapróbálása a nyilvános foglaláslemondási útvonalon.
- `KLEO-NFR-QLT-001-AC-02`: a release-candidate workflow automata teszthibára fail-closed módon blokkol.
- `KLEO-NFR-SEC-001-AC-01/02`: éles Render host HTTP/TLS/tanúsítvány vizsgálata külön külső workflow-val.

Céllefedettség: **70/102 = 68,6%**, ebből 61 inline CI és 9 external workflow evidence.

# Calendar + checklist hotfix

- `appointments` státusz constraint a jelenlegi lifecycle-hoz igazítva (`arrived`, `in_progress`, `completed`, `cancelled`, `no_show` stb.).
- `/api/checklists/my` admin/nem hozzárendelt munkatárs esetén nem generál 404/409 konzolhibát, hanem üres 200-as állapotot ad.
- Smoke teszt ellenőrzi a hotfix jelenlétét.

export type SpecFieldType =
  | "text"
  | "textarea"
  | "number"
  | "date"
  | "datetime-local"
  | "email"
  | "checkbox"
  | "select";

export type SpecField = {
  key: string;
  label: string;
  type: SpecFieldType;
  required?: boolean;
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
};

export type SpecModuleDefinition = {
  module_key: string;
  route: string;
  group: string;
  title: string;
  description: string;
  kind: string;
  statuses: Array<{ value: string; label: string }>;
  fields: SpecField[];
};

const option = (value: string, label: string) => ({ value, label });
const status = (...items: Array<[string, string]>) => items.map(([value, label]) => option(value, label));

const statusSets: Record<string, SpecModuleDefinition["statuses"]> = {
  workflow: status(["draft", "Piszkozat"], ["open", "Nyitott"], ["in_progress", "Folyamatban"], ["completed", "Elkészült"], ["approved", "Jóváhagyva"], ["cancelled", "Visszavonva"]),
  complaint: status(["new", "Új"], ["investigating", "Kivizsgálás alatt"], ["resolved", "Lezárt"], ["rejected", "Elutasítva"]),
  recruitment: status(["draft", "Piszkozat"], ["published", "Közzétéve"], ["interview", "Interjú"], ["trial_day", "Próbanap"], ["hired", "Felvéve"], ["rejected", "Nem felelt meg"], ["closed", "Lezárt"]),
  finance: status(["draft", "Piszkozat"], ["pending", "Függőben"], ["posted", "Könyvelve"], ["paid", "Fizetve"], ["cancelled", "Sztornózva"]),
  stock: status(["draft", "Piszkozat"], ["submitted", "Elküldve"], ["approved", "Jóváhagyva"], ["in_transit", "Szállítás alatt"], ["received", "Bevételezve"], ["posted", "Készletre könyvelve"], ["cancelled", "Visszavonva"]),
  content: status(["draft", "Piszkozat"], ["scheduled", "Ütemezve"], ["published", "Közzétéve"], ["archived", "Archiválva"]),
  moderation: status(["new", "Új"], ["pending_moderation", "Moderációra vár"], ["approved", "Elfogadva"], ["rejected", "Elutasítva"], ["published", "Közzétéve"]),
  master: status(["active", "Aktív"], ["inactive", "Inaktív"]),
};

const fields: Record<string, SpecField[]> = {
  task: [
    { key: "priority", label: "Prioritás", type: "select", options: [option("low", "Alacsony"), option("normal", "Normál"), option("high", "Magas"), option("critical", "Kritikus")] },
    { key: "due_at", label: "Határidő", type: "datetime-local" },
    { key: "department", label: "Részleg", type: "text" },
    { key: "shift", label: "Műszak", type: "select", options: [option("morning", "Délelőtt"), option("afternoon", "Délután"), option("all_day", "Egész nap")] },
    { key: "recurrence", label: "Ismétlődés", type: "select", options: [option("none", "Nem ismétlődik"), option("daily", "Naponta"), option("weekly", "Hetente"), option("monthly", "Havonta"), option("yearly", "Évente")] },
    { key: "approval_required", label: "Vezetői jóváhagyás szükséges", type: "checkbox" },
    { key: "inventory_check", label: "Készletszint-ellenőrzési feladat", type: "checkbox" },
  ],
  complaint: [
    { key: "subject", label: "Panasz tárgya", type: "select", required: true, options: [option("Kolléga miatt", "Kolléga miatt"), option("Várakozás miatt", "Várakozás miatt"), option("Egyéb", "Egyéb")] },
    { key: "channel", label: "Beérkezés csatornája", type: "select", options: [option("email", "E-mail"), option("in_person", "Személyesen"), option("phone", "Telefon") ] },
    { key: "client_name", label: "Vendég neve", type: "text" },
    { key: "employee_name", label: "Érintett munkatárs", type: "text" },
    { key: "attachment_url", label: "Melléklet hivatkozása", type: "text" },
    { key: "guest_notified", label: "Vendég tájékoztatva", type: "checkbox" },
    { key: "due_at", label: "Válaszadási határidő", type: "datetime-local" },
  ],
  job: [
    { key: "position", label: "Pozíció", type: "text", required: true },
    { key: "employment_type", label: "Foglalkoztatási forma", type: "text" },
    { key: "location", label: "Telephely", type: "text" },
    { key: "public", label: "Megjelenjen a weboldalon", type: "checkbox" },
    { key: "due_at", label: "Jelentkezési határidő", type: "datetime-local" },
  ],
  application: [
    { key: "position", label: "Megpályázott pozíció", type: "text", required: true },
    { key: "email", label: "E-mail", type: "email", required: true },
    { key: "phone", label: "Telefonszám", type: "text" },
    { key: "interview_at", label: "Interjú időpontja", type: "datetime-local" },
    { key: "trial_day_at", label: "Próbanap", type: "datetime-local" },
    { key: "cv_url", label: "Önéletrajz hivatkozása", type: "text" },
    { key: "questionnaire_url", label: "Kérdőív válasz", type: "text" },
  ],
  message: [
    { key: "recipient", label: "Címzett / részleg", type: "text", required: true },
    { key: "email", label: "Külső e-mail cím", type: "email" },
    { key: "send_at", label: "Küldés időpontja", type: "datetime-local" },
  ],
  document: [
    { key: "category", label: "Dokumentumtípus", type: "text", required: true },
    { key: "file_url", label: "Fájl hivatkozása", type: "text" },
    { key: "version", label: "Verzió", type: "number" },
    { key: "owner", label: "Felelős", type: "text" },
  ],
  campaign: [
    { key: "segment", label: "Célcsoport", type: "text" },
    { key: "provider", label: "Küldési szolgáltató", type: "select", options: [option("sendgrid", "SendGrid"), option("mailchimp", "Mailchimp"), option("mailgun", "Mailgun"), option("not_configured", "Nincs beállítva")] },
    { key: "send_at", label: "Küldés időpontja", type: "datetime-local" },
  ],
  deal: [
    { key: "amount", label: "Kedvezmény", type: "number" },
    { key: "discount_type", label: "Kedvezmény típusa", type: "select", options: [option("percent", "Százalék"), option("amount", "Fix összeg")] },
    { key: "department", label: "Részleg", type: "text" },
    { key: "start_at", label: "Kezdete", type: "datetime-local" },
    { key: "due_at", label: "Vége", type: "datetime-local" },
  ],
  review: [
    { key: "amount", label: "Értékelés (1–5)", type: "number" },
    { key: "source", label: "Forrás", type: "select", options: [option("kiosk", "Kioszk"), option("web", "Web"), option("internal", "Belső értékelés")] },
    { key: "employee_name", label: "Munkatárs", type: "text" },
    { key: "employee_related", label: "Munkatárshoz kapcsolódik", type: "checkbox" },
    { key: "publish_to_facebook", label: "Jóváhagyás után publikálható", type: "checkbox" },
  ],
  finance: [
    { key: "direction", label: "Irány", type: "select", required: true, options: [option("income", "Bevétel"), option("expense", "Kiadás")] },
    { key: "amount", label: "Összeg", type: "number", required: true },
    { key: "payment_method", label: "Fizetési mód", type: "text" },
    { key: "transaction_type", label: "Tranzakció típusa", type: "text" },
    { key: "reference", label: "Hivatkozási szám", type: "text" },
    { key: "start_at", label: "Teljesítés időpontja", type: "datetime-local" },
  ],
  invoice: [
    { key: "invoice_number", label: "Számlaszám", type: "text", required: true },
    { key: "partner", label: "Partner", type: "text", required: true },
    { key: "amount", label: "Bruttó összeg", type: "number", required: true },
    { key: "currency", label: "Deviza", type: "select", options: [option("HUF", "HUF"), option("EUR", "EUR"), option("USD", "USD")] },
    { key: "exchange_rate", label: "Árfolyam", type: "number" },
    { key: "start_at", label: "Teljesítés", type: "datetime-local" },
    { key: "due_at", label: "Fizetési határidő", type: "datetime-local" },
    { key: "document_url", label: "Számlakép hivatkozása", type: "text" },
  ],
  cash: [
    { key: "operation", label: "Művelet", type: "select", required: true, options: [option("open", "Nyitás"), option("check", "Ellenőrzés"), option("close", "Zárás")] },
    { key: "amount", label: "Rendszer szerinti összeg", type: "number", required: true },
    { key: "actual_amount", label: "Tényleges összeg", type: "number" },
    { key: "difference_reason", label: "Eltérés indoka", type: "textarea" },
  ],
  stock: [
    { key: "source", label: "Forrás raktár / beszállító", type: "text" },
    { key: "destination", label: "Cél raktár / szalon", type: "text" },
    { key: "partner", label: "Beszállító", type: "text" },
    { key: "items", label: "Tételek száma", type: "number" },
    { key: "quantity", label: "Összes mennyiség", type: "number" },
    { key: "amount", label: "Bekerülési érték", type: "number" },
    { key: "due_at", label: "Várható érkezés", type: "datetime-local" },
    { key: "reason", label: "Indoklás", type: "textarea" },
  ],
  report: [
    { key: "report_type", label: "Jelentéstípus", type: "text" },
    { key: "date_from", label: "Időszak kezdete", type: "date" },
    { key: "date_to", label: "Időszak vége", type: "date" },
    { key: "schedule", label: "Automatikus küldés", type: "select", options: [option("none", "Nincs"), option("daily", "Naponta"), option("weekly", "Hetente"), option("monthly", "Havonta")] },
    { key: "recipients", label: "E-mail címzettek", type: "text" },
    { key: "format", label: "Formátum", type: "select", options: [option("pdf", "PDF"), option("xlsx", "Excel"), option("both", "PDF és Excel")] },
  ],
  master: [
    { key: "code", label: "Kód", type: "text", required: true },
    { key: "sort_order", label: "Sorrend", type: "number" },
    { key: "contact", label: "Kapcsolattartó / elérhetőség", type: "text" },
    { key: "parent", label: "Szülő kategória", type: "text" },
  ],
  loyalty: [
    { key: "client_name", label: "Vendég", type: "text" },
    { key: "code", label: "Kód / kártyaszám", type: "text", required: true },
    { key: "amount", label: "Érték / egyenleg", type: "number" },
    { key: "start_at", label: "Érvényesség kezdete", type: "datetime-local" },
    { key: "due_at", label: "Lejárat", type: "datetime-local" },
    { key: "conditions", label: "Felhasználási feltételek", type: "textarea" },
  ],
  settings: [
    { key: "online_booking_discount_percent", label: "Online foglalási kedvezmény (%)", type: "number" },
    { key: "asset_service_warning_days", label: "Szerviz figyelmeztetés (nap)", type: "number" },
    { key: "idle_logout_minutes", label: "Automatikus kijelentkezés (perc)", type: "number" },
    { key: "languages", label: "Nyelvek (vesszővel)", type: "text" },
  ],
};

type Seed = [route: string, moduleKey: string, group: string, title: string, description: string, kind: string, statusKind: string];

const seeds: Seed[] = [
  ["/dashboard/notifications","dashboard.notifications","Vezérlőpult","Értesítések","Határidők, jóváhagyások és rendszerüzenetek közös listája.","task","workflow"],
  ["/finance/transactions","finance.transactions","Pénzügy","Bevételek és kiadások","Pénzügyi tranzakciók rögzítése, keresése és státuszkezelése.","finance","finance"],
  ["/finance/cash-control","finance.cash-control","Pénzügy","Pénztár nyitás, zárás és ellenőrzés","Nyitókészlet, tényleges készlet, eltérés és vezetői jóváhagyás.","cash","finance"],
  ["/finance/incoming-invoices","finance.incoming-invoices","Pénzügy","Bejövő számlák","Beszállítói számlák, devizák, határidők és számlaképek nyilvántartása.","invoice","finance"],
  ["/finance/outgoing-invoices","finance.outgoing-invoices","Pénzügy","Kimenő számlák","Kimenő számlák és teljesítési státuszok kezelése.","invoice","finance"],
  ["/finance/payments","finance.payments","Pénzügy","Fizetések","Beérkező és kimenő pénzügyi teljesítések nyilvántartása.","finance","finance"],
  ["/finance/guest-accounts","finance.guest-accounts","Pénzügy","Vendégszámla tranzakciók","Vendégegyenlegek feltöltése és felhasználása.","finance","finance"],
  ["/finance/transaction","finance.transactions","Pénzügy","Új kiadás vagy bevétel","Pénzügyi tranzakció rögzítése.","finance","finance"],
  ["/finance/invoice","finance.incoming-invoices","Pénzügy","Számlák és bizonylatok","Számlák adatainak és csatolmányainak kezelése.","invoice","finance"],
  ["/finance/invoices/in","finance.incoming-invoices","Pénzügy","Bejövő számlák","Beszállítói számlák kezelése.","invoice","finance"],
  ["/finance/invoices/out","finance.outgoing-invoices","Pénzügy","Kimenő számlák","Kimenő számlák kezelése.","invoice","finance"],
  ["/finance/transactions/guest","finance.guest-accounts","Pénzügy","Vendégszámla tranzakciók","Vendégegyenlegek és feltöltések.","finance","finance"],
  ["/finance/balance/topup","finance.guest-accounts","Pénzügy","Egyenlegfeltöltés","Vendégegyenleg feltöltése.","finance","finance"],

  ["/inventory/orders","inventory.orders","Raktár","Megrendelések","Szalon- és központi rendelések összeállítása, küldése és követése.","stock","stock"],
  ["/inventory/receipts","inventory.receipts","Raktár","Bevételezés","Beszállítótól vagy központból érkező termékek tételes átvétele.","stock","stock"],
  ["/inventory/replenishment","inventory.replenishment","Raktár","Kiegészítés","Hiányzó mennyiségek és pótrendelések kezelése.","stock","stock"],
  ["/inventory/transfers","inventory.transfers","Raktár","Raktárközi átadások","Forrás, cél, szállítás és átvétel egy folyamatban.","stock","stock"],
  ["/inventory/purchases","inventory.purchases","Raktár","Új beszerzés költséggel","Azonnali beszerzés és kapcsolódó pénzügyi kiadás rögzítése.","stock","stock"],
  ["/inventory/adjustments","inventory.adjustments","Raktár","Leltár és készletkorrekció","Készleteltérések dokumentált korrekciója.","stock","stock"],
  ["/inventory/salon-usage","inventory.salon-usage","Raktár","Szalonhasználat és anyagfelhasználás","Belső felhasználás és szolgáltatási anyaglevonás rögzítése.","stock","stock"],
  ["/warehouse/incoming","inventory.receipts","Raktár","Bevételezés","Beérkező készletek kezelése.","stock","stock"],
  ["/inventory/transfer","inventory.transfers","Raktár","Raktárközi mozgás","Raktárközi átadások kezelése.","stock","stock"],
  ["/inventory/purchase","inventory.purchases","Raktár","Új beszerzés költséggel","Beszerzés és költség rögzítése.","stock","stock"],
  ["/inventory/adjustment","inventory.adjustments","Raktár","Készletkorrekció","Leltárkülönbségek kezelése.","stock","stock"],
  ["/inventory/usage","inventory.salon-usage","Raktár","Szalonhasználat","Belső anyagfelhasználás kezelése.","stock","stock"],

  ["/hr/job-postings","hr.job-postings","Csapat és HR","Álláshirdetések","Weboldalon publikálható állások kezelése.","job","recruitment"],
  ["/hr/applications","hr.applications","Csapat és HR","Jelentkezések és kiválasztás","Önéletrajz, kérdőív, interjú, próbanap és felvétel követése.","application","recruitment"],
  ["/hr/applications/review","hr.applications","Csapat és HR","Jelentkezés elbírálása","Jelöltek kiválasztási folyamatának kezelése.","application","recruitment"],
  ["/hr/evaluations","hr.evaluations","Csapat és HR","Dolgozói értékelések","Belső pontok, feladatjóváhagyások és havi értékelések.","review","moderation"],
  ["/modules/team/performance","hr.evaluations","Csapat és HR","Teljesítmény és értékelés","Belső és vendégértékelések kezelése.","review","moderation"],

  ["/operations/tasks","operations.tasks","Működés","Teendők és jóváhagyások","Műszakhoz, részleghez vagy munkatárshoz rendelhető ismétlődő feladatok.","task","workflow"],
  ["/operations/mail","operations.mail","Működés","Belső és külső e-mail","Kollégák és külső címzettek számára előkészített üzenetek.","message","workflow"],
  ["/operations/documents","operations.documents","Működés","Elektronikus dokumentumok","Verziózott belső dokumentumok és hivatkozások nyilvántartása.","document","content"],
  ["/extra/tasks","operations.tasks","Működés","Teendők","Feladatok és jóváhagyások kezelése.","task","workflow"],
  ["/extra/documents","operations.documents","Működés","Elektronikus dokumentumok","Belső dokumentumok kezelése.","document","content"],

  ["/marketing/complaints","operations.complaints","Kommunikáció","Panaszkezelés","Panaszok, mellékletek, kivizsgálás és vendég-visszajelzés.","complaint","complaint"],
  ["/marketing/newsletters","marketing.newsletters","Kommunikáció","Hírlevelek","Központi és szalononkénti listákra ütemezhető kampányok.","campaign","content"],
  ["/marketing/newsletter","marketing.newsletters","Kommunikáció","Hírlevél küldése","Központi és helyi hírlevelek.","campaign","content"],
  ["/marketing/daily-deals","marketing.daily-deals","Kommunikáció","Napi akciók","Szabad kapacitás alapján ütemezhető napi ajánlatok.","deal","content"],
  ["/marketing/reviews","marketing.reviews","Kommunikáció","Értékelések és moderáció","Belső és vendégértékelések, publikálási jóváhagyással.","review","moderation"],

  ["/reports/profit","reports.profit","Statisztika és VIR","Profit táblázat","Bevételek és kiadások különbségének riportbeállításai.","report","content"],
  ["/reports/stock-movements","reports.stock-movements","Statisztika és VIR","Készletmozgások lekérdezése","Mozgástípus, termék, raktár és időszak szerinti kimutatás.","report","content"],
  ["/reports/expected-revenue","reports.expected-revenue","Statisztika és VIR","Elvárt bevételek","Óránkénti, napi és üzletenkénti nullszint-tervezés.","report","content"],
  ["/reports/report-editor","reports.report-editor","Statisztika és VIR","Jelentésszerkesztő","PDF/Excel exporttal és automatikus e-mail küldéssel beállítható jelentések.","report","content"],
  ["/reports/custom","reports.report-editor","Statisztika és VIR","Jelentésszerkesztő","Egyedi jelentések kezelése.","report","content"],

  ["/masterdata/departments","master.departments","Törzsadatok","Részlegek","Szalonrészlegek és felelősségi területek.","master","master"],
  ["/masterdata/assets","master.assets","Törzsadatok","Eszközök és karbantartás","Eszközök, típusok és szervizfigyelmeztetések.","master","master"],
  ["/masterdata/partners","master.partners","Törzsadatok","Partnerek és beszállítók","Szállítói és üzleti partner törzs.","master","master"],
  ["/masterdata/units","master.units","Törzsadatok","Mennyiségi egységek","Készlet- és szolgáltatási mértékegységek.","master","master"],
  ["/masterdata/payment-methods","master.payment-methods","Törzsadatok","Fizetési módok","Pénztárban és online használható fizetési módok.","master","master"],
  ["/masterdata/price-types","master.price-types","Törzsadatok","Ártípusok","Lista-, akciós és egyedi ártípusok.","master","master"],
  ["/masterdata/movement-types","master.movement-types","Törzsadatok","Készletmozgás-típusok","Bevét, kiadás, átadás, korrekció és szalonhasználat típusok.","master","master"],
  ["/masterdata/vacation-types","master.vacation-types","Törzsadatok","Szabadságtípusok","Távolléti és szabadság jogcímek.","master","master"],
  ["/masterdata/discounts","master.discounts","Törzsadatok","Kedvezmények","Kedvezménytípusok és feltételek.","master","master"],

  ["/modules/loyalty/program","loyalty.program","Hűség","Hűségprogram","Pont- és fokozatalapú hűségprogramok.","loyalty","workflow"],
  ["/modules/loyalty/memberships","loyalty.memberships","Hűség","Bérletek és tagságok","Alkalom- és időszakalapú bérletek.","loyalty","workflow"],
  ["/modules/loyalty/gift-cards","loyalty.gift-cards","Hűség","Ajándékkártyák","Érték, lejárat és felhasználási feltételek.","loyalty","workflow"],
  ["/modules/loyalty/discounts","loyalty.discounts","Hűség","Kedvezmények és promóciós kódok","Százalékos és összegalapú kedvezmények.","loyalty","workflow"],
  ["/modules/loyalty/balances","loyalty.balances","Hűség","Ügyfélegyenlegek","Feltöltések és felhasználások.","loyalty","finance"],
  ["/marketing/coupons","loyalty.memberships","Hűség","Bérletek, hűségkártyák és kuponok","Vendéghez rendelt kedvezmények.","loyalty","workflow"],

  ["/settings/application","settings.application","Beállítások","Folyamat- és alkalmazásbeállítások","Online kedvezmény, szervizfigyelmeztetés, nyelvek és automatikus kijelentkezés.","settings","master"],
  ["/settings","settings.application","Beállítások","Rendszerbeállítások","Specifikációs alapértékek telephelyenként.","settings","master"]
];

export const SPEC_MODULE_CATALOG: SpecModuleDefinition[] = seeds.map(
  ([route, module_key, group, title, description, kind, statusKind]) => ({
    route,
    module_key,
    group,
    title,
    description,
    kind,
    statuses: statusSets[statusKind] || statusSets.workflow,
    fields: fields[kind] || [],
  })
);

export function findSpecModuleByRoute(route: string) {
  return SPEC_MODULE_CATALOG.find((item) => item.route === route);
}

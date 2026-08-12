export type ProductTaxonomyInput = {
  name?: string | null;
  category?: string | null;
  brand?: string | null;
  lineName?: string | null;
};

export type ProductTaxonomyResult = {
  typeCode: string;
  typeName: string;
  groupCode: string;
  groupName: string;
  categoryCode: string;
  categoryName: string;
  confidence: number;
  flags: {
    is_service_material: boolean;
    is_retail: boolean;
    is_cleaning: boolean;
    is_hospitality: boolean;
    is_merchandise: boolean;
  };
};

export const TAXONOMY_VERSION = "kleo_taxonomy_v2";

export function normalizeTaxonomyText(value: unknown) {
  return String(value ?? "")
    .replace(/^\uFEFF/, "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const slug = (value: string) =>
  normalizeTaxonomyText(value)
    .toUpperCase()
    .replace(/\s+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 36) || "OTHER";

function result(
  typeCode: string,
  typeName: string,
  groupCode: string,
  groupName: string,
  categoryCode: string,
  categoryName: string,
  confidence: number,
  flags: ProductTaxonomyResult["flags"],
): ProductTaxonomyResult {
  return { typeCode, typeName, groupCode, groupName, categoryCode, categoryName, confidence, flags };
}

const professionalRetail = {
  is_service_material: true,
  is_retail: true,
  is_cleaning: false,
  is_hospitality: false,
  is_merchandise: true,
};
const professionalOnly = {
  is_service_material: true,
  is_retail: false,
  is_cleaning: false,
  is_hospitality: false,
  is_merchandise: false,
};
const operating = {
  is_service_material: false,
  is_retail: false,
  is_cleaning: false,
  is_hospitality: false,
  is_merchandise: false,
};

/**
 * Kleopátra készlettaxonómia.
 * A besorolás nem csak az Altegio kategóriából dolgozik, hanem együtt vizsgálja
 * a termék nevét, márkáját és termékvonalát is. A forráskategória audit célból
 * külön mezőben megmarad, a VIR viszont egységes kanonikus csoportokat használ.
 */
export function classifyProduct(input: ProductTaxonomyInput): ProductTaxonomyResult {
  const category = normalizeTaxonomyText(input.category);
  const source = normalizeTaxonomyText([input.category, input.name, input.brand, input.lineName].filter(Boolean).join(" "));
  const has = (...terms: string[]) => terms.some((term) => source.includes(normalizeTaxonomyText(term)));

  if (has("utalvany", "ajandekkartya", "gift card", "voucher", "promocio")) {
    return result("PROMOTIONAL", "Ajándék és promóció", "GIFT_PROMO", "Ajándékok és utalványok", "GIFT_CARD", "Ajándékkártya és utalvány", 0.99, { ...operating, is_retail: true, is_merchandise: true });
  }

  if (has("irodaszer", "iroda", "papiraru", "nyomtatvany", "boritek", "toll", "etikett", "cimke")) {
    const paper = has("papir", "nyomtatvany", "boritek", "etikett", "cimke");
    return result("OPERATIONS", "Üzemeltetési anyag", "OFFICE_ADMIN", "Irodaszer és adminisztráció", paper ? "PAPER_PRINT" : "OFFICE_SUPPLIES", paper ? "Papíráru és nyomtatvány" : "Irodaszerek", 0.96, operating);
  }

  if (has("tisztitoszer", "tisztito", "mososzer", "mosogato", "ablaktisztito", "felmoso", "sepru", "szemetes", "fertotlenito", "domestos", "air wick")) {
    const disinfect = has("fertotlen", "sanit", "dezinf");
    return result("OPERATIONS", "Üzemeltetési anyag", "CLEANING_HYGIENE", "Tisztítás és higiénia", disinfect ? "DISINFECTION" : "CLEANING", disinfect ? "Fertőtlenítés" : "Tisztítószerek és takarítás", 0.98, { ...operating, is_cleaning: true });
  }

  if (has("kave", "tea", "asvanyviz", "udito", "cukor", "edesito", "szalveta", "pohar", "bufe", "vendeglatas")) {
    const drinks = has("asvanyviz", "udito", "ital");
    const hot = has("kave", "tea", "cukor", "edesito");
    return result("HOSPITALITY", "Vendéglátási termék", "BUFFET_GUEST", "Büfé és vendéglátás", drinks ? "DRINKS" : hot ? "COFFEE_TEA" : "SERVING_SUPPLIES", drinks ? "Italok" : hot ? "Kávé, tea és kiegészítők" : "Vendéglátási kellékek", 0.97, { ...operating, is_hospitality: true });
  }

  if (has("kesztyu", "maszk", "vatta", "vattakorong", "papirlepedo", "lepedo", "eldobhato", "spatula", "alufolia", "folia", "torlo", "applikator", "mikrokefe", "fogyanyag", "fogyasztasi kell")) {
    const ppe = has("kesztyu", "maszk");
    return result("OPERATIONS", "Fogyóanyag", "CONSUMABLES", "Kellékek és fogyóanyagok", ppe ? "PPE" : "DISPOSABLES", ppe ? "Védőeszközök" : "Eldobható kellékek", 0.97, professionalOnly);
  }

  if (has("gyanta", "wax", "cukorpaszta", "sugar paste", "szortelen", "depil")) {
    const sugar = has("cukorpaszta", "sugar paste");
    const after = has("after wax", "utokezelo", "gyantaoldo");
    return result("PROFESSIONAL", "Professzionális felhasználás", "DEPILATION", "Szőrtelenítés", sugar ? "SUGAR_PASTE" : after ? "DEPILATION_AFTERCARE" : "WAX", sugar ? "Cukorpaszta" : after ? "Utókezelés és tisztítás" : "Gyanta és wax", 0.99, professionalOnly);
  }

  if (has("szempilla", "szemoldok", "lash", "brow", "henna", "lifting", "lamination")) {
    const brow = has("szemoldok", "brow", "henna");
    const lift = has("lifting", "lamination");
    return result("PROFESSIONAL_RETAIL", "Professzionális és értékesíthető", "LASH_BROW", "Szempilla és szemöldök", lift ? "LIFT_LAMINATION" : brow ? "BROW" : "LASH", lift ? "Lifting és laminálás" : brow ? "Szemöldök" : "Szempilla", 0.97, professionalRetail);
  }

  if (has("gellakk", "gel lakk", "gel polish", "koromlakk", "mukorom", "nail", "manikur", "pedikur", "base coat", "top coat")) {
    const polish = has("gellakk", "gel lakk", "gel polish", "koromlakk", "base coat", "top coat");
    const builder = has("mukorom", "builder", "acryl", "akril", "polygel", "zsele");
    return result("PROFESSIONAL_RETAIL", "Professzionális és értékesíthető", "NAILS", "Köröm és kéz-/lábápolás", polish ? "GEL_POLISH" : builder ? "NAIL_BUILDING" : "NAIL_CARE", polish ? "Gél lakk és fedők" : builder ? "Műköröm építés" : "Körömápolás", 0.98, professionalRetail);
  }

  if (has("hajfestek", "hajfesték", "hair color", "hair colour", "oxidalo", "oxydant", "developer", "szokito", "bleach", "toner", "sampon", "shampoo", "balzsam", "conditioner", "hajmaszk", "hair mask", "hajlakk", "hair spray", "hajwax", "styling", "hajapolas", "hair care", "haj")) {
    const color = has("hajfestek", "hajfesték", "hair color", "hair colour", "oxidalo", "oxydant", "developer", "szokito", "bleach", "toner");
    const care = has("sampon", "shampoo", "balzsam", "conditioner", "hajmaszk", "hair mask", "hajapolas", "hair care");
    const styling = has("hajlakk", "hair spray", "hajwax", "styling", "mousse", "hab");
    return result("PROFESSIONAL_RETAIL", "Professzionális és értékesíthető", "HAIR", "Hajápolás és hajtechnika", color ? "HAIR_COLOR" : care ? "HAIR_CARE" : styling ? "HAIR_STYLING" : "HAIR_OTHER", color ? "Hajfestés és oxidáció" : care ? "Sampon, balzsam és ápolás" : styling ? "Hajformázás" : "Egyéb hajtermék", 0.96, professionalRetail);
  }

  if (has("smink", "makeup", "make up", "alapozo", "foundation", "korrektor", "concealer", "puder", "powder", "szempillaspiral", "mascara", "szemhej", "eyeshadow", "ruzs", "lipstick", "szajfeny", "dermacolor")) {
    const eye = has("mascara", "szempillaspiral", "szemhej", "eyeshadow", "eyeliner");
    const lip = has("ruzs", "lipstick", "szajfeny", "lip gloss", "ajak");
    return result("PROFESSIONAL_RETAIL", "Professzionális és értékesíthető", "MAKEUP", "Smink és dekor kozmetika", eye ? "EYE_MAKEUP" : lip ? "LIP_MAKEUP" : "FACE_MAKEUP", eye ? "Szemsmink" : lip ? "Ajaksmink" : "Arcsmink", 0.98, professionalRetail);
  }

  if (has("masszazs", "massage", "testapolo", "body lotion", "testkrem", "body cream", "massage oil", "masszazsolaj")) {
    const massage = has("masszazs", "massage", "masszazsolaj", "massage oil");
    return result("PROFESSIONAL_RETAIL", "Professzionális és értékesíthető", "BODY_TREATMENTS", "Testkezelés és masszázs", massage ? "MASSAGE" : "BODY_CARE", massage ? "Masszázsanyagok" : "Testápolás", 0.95, professionalRetail);
  }

  if (has("kozmetika", "arckrem", "face cream", "szerum", "serum", "ampulla", "ampoule", "maszk", "mask", "peeling", "hamlaszto", "tonik", "toner", "lemoso", "cleanser", "micellas", "micellar", "fenyvedo", "sunscreen", "spf", "borapolas", "skin care", "skincare", "krem")) {
    const serum = has("szerum", "serum", "ampulla", "ampoule");
    const mask = has("maszk", "mask", "peeling", "hamlaszto");
    const cleanse = has("tonik", "toner", "lemoso", "cleanser", "micellas", "micellar");
    const sun = has("fenyvedo", "sunscreen", "spf");
    return result("PROFESSIONAL_RETAIL", "Professzionális és értékesíthető", "COSMETICS", "Kozmetika és bőrápolás", serum ? "SERUM_AMPOULE" : mask ? "MASK_PEEL" : cleanse ? "CLEANSING" : sun ? "SUNCARE" : "CREAMS", serum ? "Szérumok és ampullák" : mask ? "Maszkok és hámlasztók" : cleanse ? "Lemosás és tonizálás" : sun ? "Fényvédelem" : "Krémek és alapápolás", 0.94, professionalRetail);
  }

  const original = String(input.category || "").trim();
  const categoryName = original && !["egyeb", "egyéb", "other"].includes(normalizeTaxonomyText(original)) ? original : "Egyéb szépségápolási termék";
  return result("PROFESSIONAL_RETAIL", "Professzionális és értékesíthető", "BEAUTY_OTHER", "Egyéb szépségápolási termékek", `OTHER_${slug(categoryName)}`, categoryName, 0.35, professionalRetail);
}

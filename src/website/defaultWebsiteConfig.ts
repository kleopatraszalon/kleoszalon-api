export type WebsiteCmsConfig = {
  version: number;
  theme: { gold:string; goldSoft:string; magenta:string; magentaSoft:string; text:string; muted:string; background:string; surface:string; headingFont:string; bodyFont:string; radius:number };
  brand: { logoUrl:string; slogan:string };
  header: { bookingLabel:string; showLanguageSwitcher:boolean; facebookUrl:string; instagramUrl:string; tiktokUrl:string; messengerUrl:string };
  home: { heroKicker:string; heroTitlePrefix:string; heroTitleHighlight:string; heroTitleSuffix:string; heroLead:string; heroImageUrl:string; showFranchise:boolean; showApp:boolean; showVouchers:boolean; showNewsletter:boolean; showProducts:boolean; showServices:boolean; appTitle:string; appLead:string; newsletterTitle:string; newsletterLead:string; voucherTitle:string; voucherLead:string; productsTitle:string; productsLead:string; whyTitle:string; whyItems:string[] };
  footer: { privacyLabel:string; privacyUrl:string; cookieLabel:string; cookieUrl:string; complaintsLabel:string; complaintsUrl:string; imprintLabel:string; imprintUrl:string };
};

/** Arculati alapértékek és a jelenlegi kleoszalon.hu fő üzenetei. */
export const DEFAULT_WEBSITE_CONFIG: WebsiteCmsConfig = {
  version: 1,
  theme: { gold:"#b69861", goldSoft:"#e3d8c3", magenta:"#ec008c", magentaSoft:"#f9c1d9", text:"#120c08", muted:"#5d5a55", background:"#ffffff", surface:"#ffffff", headingFont:"Montserrat", bodyFont:"Open Sans", radius:18 },
  brand: { logoUrl:"/images/Logo.jpg", slogan:"Minden ami szépség, csak Neked!" },
  header: { bookingLabel:"Időpontfoglalás", showLanguageSwitcher:true, facebookUrl:"", instagramUrl:"", tiktokUrl:"", messengerUrl:"" },
  home: {
    heroKicker:"KLEOPÁTRA SZÉPSÉGSZALONOK", heroTitlePrefix:"Minden ami ", heroTitleHighlight:"szépség", heroTitleSuffix:", csak Neked!",
    heroLead:"Foglalj időpontot online vagy telefonon, de szalonjainkba bejelentkezés nélkül is bátran betérhetsz.", heroImageUrl:"/images/home.png",
    showFranchise:true, showApp:true, showVouchers:true, showNewsletter:true, showProducts:true, showServices:true,
    appTitle:"Elindult mobil alkalmazásunk!", appLead:"Kövesd foglalásaidat, bérleteidet és vendégszámla-egyenlegedet, és értesülj személyre szabott ajánlatainkról.",
    newsletterTitle:"Iratkozz fel hírlevelünkre – 1500 Ft kedvezményt adunk", newsletterLead:"Értesülj akcióinkról és a regisztrált vendégeinknek szóló ajánlatokról.",
    voucherTitle:"Ajándékutalványaink", voucherLead:"Ajándékozz szépségélményt: utalványaink többek egy darab papírnál, valódi élményt adnak.",
    productsTitle:"KLEOS termékek", productsLead:"Stílusos, letisztult, egyedi megjelenés és a Kleos életérzés – válogass saját márkás termékeinkből.",
    whyTitle:"Miért válassz bennünket?", whyItems:["Mindent egy helyen megtalálsz a magabiztos megjelenésedhez.","Sok szolgáltatás, rugalmas időpontok és hosszú nyitvatartás.","Többféle fizetési mód, folyamatos kedvezmények és kuponok.","Online foglalás, mobilalkalmazás és személyre szabott ajánlatok."]
  },
  footer: {
    privacyLabel:"Adatvédelem", privacyUrl:"https://www.kleoszalon.hu/adatvedelem/", cookieLabel:"Cookie tájékoztató", cookieUrl:"https://www.kleoszalon.hu/cookie-tajekoztato/",
    complaintsLabel:"Panaszkezelési szabályzat", complaintsUrl:"https://www.kleoszalon.hu/panaszkezelesi-szabalyzat/", imprintLabel:"Impresszum", imprintUrl:"https://www.kleoszalon.hu/impresszum/"
  }
};

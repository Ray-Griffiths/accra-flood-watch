/**
 * Twi and Ga, for an application whose users mostly do not read warnings in
 * English by choice.
 *
 * English literacy in Accra is high and far from universal, and it is least
 * universal among exactly the people this is built for. A flood warning that
 * can only be read in a second language is a warning that arrives slower than
 * the water.
 *
 * ## Two rules this file exists to enforce
 *
 * **Translation is by table, never by model.** Every string below is a fixed
 * entry chosen by a key. There is no generation step, so a sentence cannot
 * drift, hallucinate a threshold, or quietly soften a warning between one
 * render and the next. The plan permits Bedrock for phrasing; it has no place
 * in the strings that tell somebody whether a road is passable.
 *
 * **A missing translation falls back to English rather than showing a key.**
 * `flood.level.high` on screen is worse than an English sentence: the English
 * is at least readable by someone, and the key is readable by nobody.
 *
 * ## What is NOT translated yet, and why
 *
 * The per-cell explanation sentences are composed on the server from live
 * numbers ("ground here is about 1.2m above the nearest drain; about 14mm of
 * rain is forecast"). Those remain English until a Twi and Ga speaker has
 * reviewed them. Machine-drafting a safety sentence in a language nobody on
 * the project can check is precisely the failure this file's first rule
 * exists to prevent, and a wrong preposition in a flood warning is not a
 * cosmetic bug.
 *
 * The interface around them — every label, button, level name and disclaimer —
 * is translated here, which is what lets somebody navigate the app at all.
 */

export const LOCALES = ["en", "tw", "ga"] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  tw: "Twi",
  ga: "Gã",
};

/**
 * Locales whose wording has not yet been checked by a native speaker.
 *
 * Shown to the user as a visible notice rather than tracked only in a comment.
 * Somebody reading a draft translation of a flood warning is entitled to know
 * that is what they are reading.
 */
export const DRAFT_LOCALES: readonly Locale[] = ["tw", "ga"];

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/**
 * Every string the interface shows, keyed.
 *
 * English is the complete set and the fallback; the others may be partial
 * while review is in progress, and a gap resolves to English rather than to a
 * key.
 */
type Catalog = Record<string, string>;

const en: Catalog = {
  "app.tagline.fallback": "Accra",
  "status.loading": "Loading flood risk…",
  "status.offline": "Cannot reach the service. Check your connection.",
  "status.zoomIn": "Zoom in to see street-level flood risk.",

  "view.now": "Right now",
  "view.later": "Later today",
  "view.terrain": "When it rains",
  "view.group": "What the map shows",

  "level.low": "Low",
  "level.low.meaning": "No particular concern right now",
  "level.watch": "Watch",
  "level.watch.meaning": "Could develop — stay aware",
  "level.high": "High",
  "level.high.meaning": "Flooding likely — avoid if you can",
  "level.confirmed": "Flooded now",
  "level.confirmed.meaning": "People are reporting water now",

  "terrain.floods-first": "Floods first",
  "terrain.floods-heavy": "Floods in heavy rain",
  "terrain.usually-dry": "Usually stays dry",

  "action.report": "Report water",
  "action.route": "Safe route",
  "action.checkTrip": "Check my trip",
  "action.close": "Close",
  "action.done": "Done",
  "action.tryAgain": "Try again",
  "action.share": "Share this place",

  "report.question": "How deep is the water?",
  "depth.ankle": "Ankle deep",
  "depth.ankle.hint": "Passable on foot",
  "depth.knee": "Knee deep",
  "depth.knee.hint": "Hard to walk through",
  "depth.waist": "Waist deep",
  "depth.waist.hint": "Dangerous — do not wade",
  "depth.impassable": "Impassable",
  "depth.impassable.hint": "Nobody can get through",
  "depth.cleared": "The water has gone",
  "depth.cleared.hint": "This road is passable again",

  "report.privacy":
    "No name, no account, no device id. Your report disappears automatically after 24 hours.",

  "search.placeholder": "Street or landmark…",
  "search.label": "Search for a place",
  "search.confirm": "Tap one to see it on the map and check it is the right place.",
  "search.uncovered": "Outside the area this covers",

  "disclaimer.lead": "This is a community information tool, not an official warning service.",
  "disclaimer.rest":
    "For official warnings consult NADMO and the Ghana Meteorological Agency.",

  "language.label": "Language",
  "language.draft":
    "This translation is a draft and has not yet been checked by a native speaker. Warnings are most reliable in English.",
};

/**
 * Twi (Asante Twi). DRAFT — not reviewed by a native speaker.
 *
 * Deliberately limited to the navigational vocabulary: level names, buttons,
 * depths, the disclaimer. These are short, concrete, and their meaning does
 * not depend on a number that changes.
 */
const tw: Catalog = {
  "status.loading": "Reload nsuyiri ho amanneɛbɔ…",
  "status.offline": "Yɛntumi nkɔ som no so. Hwɛ wo intanɛt.",
  "status.zoomIn": "Pɛe kɛse na hunu abɔnten biara nsuyiri.",

  "view.now": "Seesei ara",
  "view.later": "Ɛnnɛ akyiri",
  "view.terrain": "Sɛ osu tɔ a",
  "view.group": "Deɛ mmepɔ no kyerɛ",

  "level.low": "Ketewa",
  "level.low.meaning": "Biribiara nni hɔ a ɛhaw seesei",
  "level.watch": "Hwɛ yie",
  "level.watch.meaning": "Ebetumi asɛe — hwɛ yie",
  "level.high": "Kɛse",
  "level.high.meaning": "Nsuyiri bɛba — kwati sɛ wobetumi a",
  "level.confirmed": "Nsuyiri wɔ hɔ",
  "level.confirmed.meaning": "Nkurɔfoɔ reka sɛ nsuo wɔ hɔ seesei",

  "terrain.floods-first": "Ɛdi kan yiri",
  "terrain.floods-heavy": "Ɛyiri osutɔ kɛse mu",
  "terrain.usually-dry": "Ɛtaa yɛ wosee",

  "action.report": "Ka nsuo ho asɛm",
  "action.route": "Kwan a ɛho yɛ",
  "action.checkTrip": "Hwɛ m'akwantuo",
  "action.close": "To mu",
  "action.done": "Ɛwie",
  "action.tryAgain": "Sɔ hwɛ bio",
  "action.share": "Kyɛ baabi yi",

  "report.question": "Nsuo no mu dɔ sɛn?",
  "depth.ankle": "Ɛduru nan ase",
  "depth.ankle.hint": "Wobetumi anante mu",
  "depth.knee": "Ɛduru kotodwe",
  "depth.knee.hint": "Ɛyɛ den sɛ wobɛnante mu",
  "depth.waist": "Ɛduru asen",
  "depth.waist.hint": "Ɛyɛ hu — nkɔ mu",
  "depth.impassable": "Wontumi mfa mu",
  "depth.impassable.hint": "Obiara ntumi mfa mu",
  "depth.cleared": "Nsuo no akɔ",
  "depth.cleared.hint": "Wobetumi afa kwan yi so bio",

  "report.privacy":
    "Edin biara nni hɔ, akawnt biara nni hɔ. Wo asɛm no yera nnɔnhwerew 24 akyi.",

  "search.placeholder": "Abɔnten anaa beaeɛ…",
  "search.label": "Hwehwɛ beaeɛ bi",
  "search.confirm": "Mia baako na hwɛ sɛ ɛyɛ beaeɛ a wopɛ no.",
  "search.uncovered": "Ɛwɔ beaeɛ a yɛnhwɛ so",

  "disclaimer.lead": "Yei yɛ mpɔtam amanneɛbɔ adwinnadeɛ, ɛnyɛ aban kɔkɔbɔ som.",
  "disclaimer.rest": "Kɔkɔbɔ ankasa deɛ, kɔ NADMO ne Ghana Meteorological Agency hɔ.",

  "language.label": "Kasa",
  // Bilingual on purpose: a caveat about a translation that only appears in
  // the language being warned about is a caveat its reader cannot read.
  "language.draft":
    "Nkyerɛaseɛ yi nwiee ɛ. Kɔkɔbɔ no mu yɛ nokware paa wɔ Borɔfo kasa mu. " +
    "(This translation is a draft; warnings are most reliable in English.)",
};

/**
 * Gã. DRAFT — not reviewed by a native speaker.
 *
 * Ga is the language of the coastal communities around the Korle Lagoon,
 * which is the outfall this whole catchment drains to and the ground that
 * floods first.
 */
const ga: Catalog = {
  "status.loading": "Miikpɛlɛ nu ni yɔɔ he sane…",
  "status.offline": "Wɔnyɛɛɛ wɔya nitsumɔ lɛ nɔ. Kwɛmɔ o intanɛt.",
  "status.zoomIn": "Fee lɛ agbo koni ona blohu fɛɛ blohu nɔ nu.",

  "view.now": "Amrɔ nɛɛ",
  "view.later": "Ŋmɛnɛ sɛɛ",
  "view.terrain": "Kɛ nugbɔ nɛ",
  "view.group": "Nɔ ni mapa lɛ tsɔɔ",

  "level.low": "Fioo",
  "level.low.meaning": "Nɔ ko bɛ ni haoɔ amrɔ nɛɛ",
  "level.watch": "Kwɛmɔ jogbaŋŋ",
  "level.watch.meaning": "Ebaanyɛ eba — kwɛmɔ jogbaŋŋ",
  "level.high": "Agbo",
  "level.high.meaning": "Nu baaba — kpoo kɛ onyɛ",
  "level.confirmed": "Nu yɛ he amrɔ",
  "level.confirmed.meaning": "Gbɔmɛi miitsɔɔ akɛ nu yɛ he amrɔ",

  "terrain.floods-first": "Eklɛŋklɛŋ ni nu yiɔ",
  "terrain.floods-heavy": "Nu yiɔ kɛ nugbɔ agbo nɛ",
  "terrain.usually-dry": "Bei pii lɛ egbɔɔ",

  "action.report": "Tsɔɔ nu lɛ he sane",
  "action.route": "Gbɛ ni yɔɔ shweshweeshwe",
  "action.checkTrip": "Kwɛmɔ migbɛfaa",
  "action.close": "Ŋmɛɛ naa",
  "action.done": "Egbe naa",
  "action.tryAgain": "Kaa ekoŋŋ",
  "action.share": "Kɛ he nɛɛ aha mɔ ko",

  "report.question": "Nu lɛ kwɔ tɛŋŋ?",
  "depth.ankle": "Eshɛɔ nane naa",
  "depth.ankle.hint": "Obaanyɛ onyiɛ mli",
  "depth.knee": "Eshɛɔ nakutso",
  "depth.knee.hint": "Ewa akɛ onyiɛ mli",
  "depth.waist": "Eshɛɔ hiɛ",
  "depth.waist.hint": "Eyɛ oyaiyeli — kaaya mli",
  "depth.impassable": "Anyɛɛɛ atsɔ mli",
  "depth.impassable.hint": "Mɔ ko nyɛɛɛ atsɔ mli",
  "depth.cleared": "Nu lɛ eho",
  "depth.cleared.hint": "Abaanyɛ atsɔ gbɛ nɛɛ nɔ ekoŋŋ",

  "report.privacy":
    "Gbɛi ko bɛ he, akawnt ko bɛ he. Osane lɛ laajeɔ yɛ ŋmɛlɛtswaa 24 sɛɛ.",

  "search.placeholder": "Blohu loo he ko…",
  "search.label": "Taomɔ he ko",
  "search.confirm": "Mia ekome koni okwɛ akɛ no ji he ni otaoɔ lɛ.",
  "search.uncovered": "Eyɛ he ni wɔkwɛɛɛ nɔ",

  "disclaimer.lead": "Enɛ ji maŋbii ahe sane nitsumɔnɔ, jeee maŋtsɛmɛi akpoo nitsumɔ.",
  "disclaimer.rest": "Kɛ oootao kpoo diɛŋtsɛ lɛ, ya NADMO kɛ Ghana Meteorological Agency ŋɔɔ.",

  "language.label": "Wiemɔ",
  "language.draft":
    "Shishitsɔɔmɔ nɛɛ egbeko naa. Kpoo lɛ yɛ anɔkwale titri yɛ Blɔfo wiemɔ mli. " +
    "(This translation is a draft; warnings are most reliable in English.)",
};

const CATALOGS: Record<Locale, Catalog> = { en, tw, ga };

const STORAGE_KEY = "afw:locale";

let active: Locale = "en";

/**
 * The locale to start in.
 *
 * A stored choice wins. Otherwise the browser's own language is consulted —
 * somebody whose phone is already set to Twi should not have to find a menu —
 * and English is the floor.
 */
export function detectLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    /* Private browsing. Fall through to the browser's preference. */
  }

  for (const tag of navigator.languages ?? []) {
    const base = tag.toLowerCase().split("-")[0];
    if (isLocale(base)) return base;
  }

  return "en";
}

export function getLocale(): Locale {
  return active;
}

export function setLocale(locale: Locale): void {
  active = locale;
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    /* The choice still applies for this session. */
  }
  document.documentElement.lang = locale;
}

/** True when the active locale's wording is still awaiting review. */
export function isDraftLocale(locale: Locale = active): boolean {
  return DRAFT_LOCALES.includes(locale);
}

/**
 * Look up a string.
 *
 * Falls back to English, then to the key itself — the last only if English is
 * missing an entry, which is a programming error rather than a translation
 * gap, and one a visible key makes obvious in testing.
 */
export function t(key: string): string {
  return CATALOGS[active][key] ?? en[key] ?? key;
}

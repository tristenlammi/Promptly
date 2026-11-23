// A guess at the country the person is in, from what the browser already
// knows: its time zone, else the country in its language setting ("en-NZ").
// Nothing is looked up over the network. It only decides which map is offered
// first in the picker ("Probably yours"), so a wrong guess costs nothing.

/** Time zones by country code. Whole areas first ("Australia/"), then single
 *  zones. The big zones of each country, not every alias. */
const ZONES: Record<string, string> = {
  au: "Australia/ Antarctica/Macquarie",
  nz: "Pacific/Auckland Pacific/Chatham",
  gb: "Europe/London Europe/Belfast",
  ie: "Europe/Dublin",
  im: "Europe/Isle_of_Man",
  je: "Europe/Jersey",
  gg: "Europe/Guernsey",
  fr: "Europe/Paris",
  de: "Europe/Berlin Europe/Busingen",
  nl: "Europe/Amsterdam",
  be: "Europe/Brussels",
  lu: "Europe/Luxembourg",
  ch: "Europe/Zurich",
  at: "Europe/Vienna",
  li: "Europe/Vaduz",
  it: "Europe/Rome",
  sm: "Europe/San_Marino",
  va: "Europe/Vatican",
  mt: "Europe/Malta",
  es: "Europe/Madrid Africa/Ceuta Atlantic/Canary",
  pt: "Europe/Lisbon Atlantic/Madeira Atlantic/Azores",
  ad: "Europe/Andorra",
  mc: "Europe/Monaco",
  dk: "Europe/Copenhagen",
  no: "Europe/Oslo",
  se: "Europe/Stockholm",
  fi: "Europe/Helsinki Europe/Mariehamn",
  is: "Atlantic/Reykjavik",
  fo: "Atlantic/Faroe",
  ee: "Europe/Tallinn",
  lv: "Europe/Riga",
  lt: "Europe/Vilnius",
  pl: "Europe/Warsaw",
  cz: "Europe/Prague",
  sk: "Europe/Bratislava",
  hu: "Europe/Budapest",
  si: "Europe/Ljubljana",
  hr: "Europe/Zagreb",
  ba: "Europe/Sarajevo",
  rs: "Europe/Belgrade",
  me: "Europe/Podgorica",
  mk: "Europe/Skopje",
  al: "Europe/Tirane",
  xk: "Europe/Pristina",
  gr: "Europe/Athens",
  bg: "Europe/Sofia",
  ro: "Europe/Bucharest",
  md: "Europe/Chisinau",
  ua: "Europe/Kyiv Europe/Kiev Europe/Uzhgorod Europe/Zaporozhye",
  by: "Europe/Minsk",
  tr: "Europe/Istanbul Asia/Istanbul",
  cy: "Asia/Nicosia Asia/Famagusta Europe/Nicosia",
  ru: "Europe/Moscow Europe/Kaliningrad Europe/Samara Europe/Volgograd Europe/Saratov Europe/Ulyanovsk Europe/Astrakhan Europe/Kirov Asia/Yekaterinburg Asia/Omsk Asia/Novosibirsk Asia/Barnaul Asia/Tomsk Asia/Novokuznetsk Asia/Krasnoyarsk Asia/Irkutsk Asia/Chita Asia/Yakutsk Asia/Khandyga Asia/Vladivostok Asia/Ust-Nera Asia/Magadan Asia/Sakhalin Asia/Srednekolymsk Asia/Kamchatka Asia/Anadyr",
  ge: "Asia/Tbilisi",
  am: "Asia/Yerevan",
  az: "Asia/Baku",
  kz: "Asia/Almaty Asia/Qyzylorda Asia/Qostanay Asia/Aqtobe Asia/Aqtau Asia/Atyrau Asia/Oral",
  uz: "Asia/Tashkent Asia/Samarkand",
  kg: "Asia/Bishkek",
  tj: "Asia/Dushanbe",
  tm: "Asia/Ashgabat",
  il: "Asia/Jerusalem Asia/Tel_Aviv",
  ps: "Asia/Gaza Asia/Hebron",
  lb: "Asia/Beirut",
  jo: "Asia/Amman",
  sy: "Asia/Damascus",
  iq: "Asia/Baghdad",
  ir: "Asia/Tehran",
  sa: "Asia/Riyadh",
  ae: "Asia/Dubai",
  qa: "Asia/Qatar",
  bh: "Asia/Bahrain",
  kw: "Asia/Kuwait",
  om: "Asia/Muscat",
  ye: "Asia/Aden",
  af: "Asia/Kabul",
  pk: "Asia/Karachi",
  in: "Asia/Kolkata Asia/Calcutta",
  lk: "Asia/Colombo",
  np: "Asia/Kathmandu Asia/Katmandu",
  bd: "Asia/Dhaka",
  bt: "Asia/Thimphu",
  mv: "Indian/Maldives",
  mm: "Asia/Yangon Asia/Rangoon",
  th: "Asia/Bangkok",
  la: "Asia/Vientiane",
  kh: "Asia/Phnom_Penh",
  vn: "Asia/Ho_Chi_Minh Asia/Saigon",
  my: "Asia/Kuala_Lumpur Asia/Kuching",
  sg: "Asia/Singapore",
  bn: "Asia/Brunei",
  id: "Asia/Jakarta Asia/Pontianak Asia/Makassar Asia/Jayapura",
  ph: "Asia/Manila",
  tw: "Asia/Taipei",
  cn: "Asia/Shanghai Asia/Urumqi Asia/Chongqing Asia/Harbin",
  mn: "Asia/Ulaanbaatar Asia/Hovd Asia/Choibalsan",
  kr: "Asia/Seoul",
  kp: "Asia/Pyongyang",
  jp: "Asia/Tokyo",
  pg: "Pacific/Port_Moresby Pacific/Bougainville",
  fj: "Pacific/Fiji",
  nc: "Pacific/Noumea",
  us: "America/New_York America/Detroit America/Kentucky/ America/Indiana/ America/Chicago America/Menominee America/North_Dakota/ America/Denver America/Boise America/Phoenix America/Los_Angeles America/Anchorage America/Juneau America/Sitka America/Metlakatla America/Yakutat America/Nome America/Adak Pacific/Honolulu US/",
  ca: "America/Toronto America/Vancouver America/Edmonton America/Winnipeg America/Regina America/Swift_Current America/Halifax America/Moncton America/Glace_Bay America/Goose_Bay America/St_Johns America/Whitehorse America/Dawson America/Dawson_Creek America/Fort_Nelson America/Yellowknife America/Inuvik America/Iqaluit America/Rankin_Inlet America/Resolute America/Cambridge_Bay America/Montreal Canada/",
  mx: "America/Mexico_City America/Cancun America/Merida America/Monterrey America/Matamoros America/Chihuahua America/Ciudad_Juarez America/Ojinaga America/Mazatlan America/Bahia_Banderas America/Hermosillo America/Tijuana",
  gt: "America/Guatemala",
  bz: "America/Belize",
  sv: "America/El_Salvador",
  hn: "America/Tegucigalpa",
  ni: "America/Managua",
  cr: "America/Costa_Rica",
  pa: "America/Panama",
  cu: "America/Havana",
  jm: "America/Jamaica",
  ht: "America/Port-au-Prince",
  do: "America/Santo_Domingo",
  pr: "America/Puerto_Rico",
  co: "America/Bogota",
  ve: "America/Caracas",
  ec: "America/Guayaquil Pacific/Galapagos",
  pe: "America/Lima",
  bo: "America/La_Paz",
  cl: "America/Santiago America/Punta_Arenas Pacific/Easter",
  ar: "America/Argentina/ America/Buenos_Aires",
  uy: "America/Montevideo",
  py: "America/Asuncion",
  br: "America/Sao_Paulo America/Bahia America/Fortaleza America/Recife America/Belem America/Maceio America/Araguaina America/Manaus America/Cuiaba America/Campo_Grande America/Porto_Velho America/Boa_Vista America/Santarem America/Rio_Branco America/Eirunepe America/Noronha",
  sr: "America/Paramaribo",
  gy: "America/Guyana",
  ma: "Africa/Casablanca",
  dz: "Africa/Algiers",
  tn: "Africa/Tunis",
  ly: "Africa/Tripoli",
  eg: "Africa/Cairo",
  sd: "Africa/Khartoum",
  et: "Africa/Addis_Ababa",
  ke: "Africa/Nairobi",
  tz: "Africa/Dar_es_Salaam",
  ug: "Africa/Kampala",
  rw: "Africa/Kigali",
  ng: "Africa/Lagos",
  gh: "Africa/Accra",
  ci: "Africa/Abidjan",
  sn: "Africa/Dakar",
  cm: "Africa/Douala",
  cd: "Africa/Kinshasa Africa/Lubumbashi",
  ao: "Africa/Luanda",
  zm: "Africa/Lusaka",
  zw: "Africa/Harare",
  mz: "Africa/Maputo",
  bw: "Africa/Gaborone",
  na: "Africa/Windhoek",
  za: "Africa/Johannesburg",
  ls: "Africa/Maseru",
  sz: "Africa/Mbabane",
  mg: "Indian/Antananarivo",
  mu: "Indian/Mauritius",
};

let table: { exact: Map<string, string>; areas: [string, string][] } | null = null;

function zones() {
  if (table) return table;
  const exact = new Map<string, string>();
  const areas: [string, string][] = [];
  for (const [code, list] of Object.entries(ZONES)) {
    for (const zone of list.split(" ")) {
      if (zone.endsWith("/")) areas.push([zone, code]);
      else exact.set(zone, code);
    }
  }
  table = { exact, areas };
  return table;
}

/** The country a time zone is in ("Pacific/Auckland" -> "nz"), or null. */
export function countryOfTimeZone(zone: string | null | undefined): string | null {
  if (!zone) return null;
  const { exact, areas } = zones();
  return exact.get(zone) ?? areas.find(([area]) => zone.startsWith(area))?.[1] ?? null;
}

/** The country in a language tag that names one ("en-NZ" -> "nz"), or null. */
export function countryOfLanguage(tag: string | null | undefined): string | null {
  const hit = /^[A-Za-z]{2,3}(?:-[A-Za-z]{4})?-([A-Za-z]{2})\b/.exec(tag ?? "");
  return hit ? hit[1].toLowerCase() : null;
}

/** The two-letter code of the country this browser is probably in, or null.
 *  The time zone wins: plenty of people outside the US keep "en-US". */
export function guessCountry(): string | null {
  let zone: string | null = null;
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch {
    zone = null;
  }
  const byZone = countryOfTimeZone(zone);
  if (byZone) return byZone;
  const tags = typeof navigator === "undefined" ? [] : [...(navigator.languages ?? []), navigator.language];
  for (const tag of tags) {
    const code = countryOfLanguage(tag);
    if (code) return code;
  }
  return null;
}

/** The whole-country map for a country code: a top-level entry that covers
 *  it, preferring the one that covers the fewest other countries. */
export function mapForCountry<T extends { id: string; parent: string | null; kind: string; codes?: string[] }>(regions: T[], code: string | null): T | null {
  if (!code) return null;
  const hits = regions.filter((r) => !r.parent && (r.codes ?? []).includes(code));
  hits.sort((a, b) => (a.codes?.length ?? 0) - (b.codes?.length ?? 0) || Number(a.kind !== "country") - Number(b.kind !== "country"));
  return hits[0] ?? null;
}

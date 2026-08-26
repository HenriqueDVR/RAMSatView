/**
 * Minimal PT/EN dictionary.
 *
 * Both languages exist from the first commit rather than being retrofitted:
 * locals and visitors are both target users and they need different defaults,
 * and threading a locale through an existing component tree later is miserable.
 *
 * Score reasons are generated in English by the Python ingest. Translating
 * those properly means emitting structured reason codes instead of prose - see
 * the note in ingest/scoring/inversion.py. Until then the PT UI shows English
 * reason text, which is honest rather than machine-mangled.
 */

export const LOCALES = ["pt", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "pt";

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

const DICTIONARY = {
  pt: {
    "site.title": "Condicoes na Madeira",
    "site.tagline": "Mar de nuvens, nascer do sol e estado do mar",
    "nav.viewpoints": "Miradouros",
    "nav.beaches": "Praias",
    "score.cloud_sea": "Mar de nuvens",
    "score.visibility": "Visibilidade",
    "score.beach": "Condicoes de banho",
    "score.confidence": "Confianca",
    "label.sunrise": "Nascer do sol",
    "label.deck": "Topo das nuvens",
    "label.temperature": "Temperatura no cume",
    "label.wind": "Vento",
    "label.water": "Agua",
    "label.waves": "Ondas",
    "label.uv": "Indice UV",
    "label.elevation": "Altitude",
    "label.summit": "Cume",
    "verdict.above": "Acima do mar de nuvens",
    "verdict.inside": "Cume dentro da nuvem",
    "verdict.none": "Sem mar de nuvens previsto",
    "profile.title": "Perfil vertical",
    "profile.caption":
      "Perfil vertical: nuvem ate {deck} m, cume a {summit} m",
    "profile.at_summit": "Nuvem no cume {pct}%",
    "state.loading": "A carregar condicoes...",
    "state.error": "Nao foi possivel carregar as condicoes.",
    "state.offline": "Sem ligacao - a mostrar dados guardados",
    "state.stale": "Dados desatualizados",
    "state.updated": "Atualizado ha {n} min",
    "warning.official": "Aviso oficial do IPMA",
    "warning.source": "Ver avisos no IPMA",
    "disclaimer.title": "Isto nao e um aviso de seguranca",
    "disclaimer.body":
      "Estes numeros descrevem condicoes previstas, nao sao uma recomendacao de seguranca. Para trilhos e avisos oficiais consulte sempre o IPMA e o IFCN antes de sair.",
    "footer.data": "Dados",
  },
  en: {
    "site.title": "Madeira Conditions",
    "site.tagline": "Sea of clouds, sunrise and sea state",
    "nav.viewpoints": "Viewpoints",
    "nav.beaches": "Beaches",
    "score.cloud_sea": "Sea of clouds",
    "score.visibility": "Visibility",
    "score.beach": "Swimming conditions",
    "score.confidence": "Confidence",
    "label.sunrise": "Sunrise",
    "label.deck": "Cloud top",
    "label.temperature": "Summit temperature",
    "label.wind": "Wind",
    "label.water": "Water",
    "label.waves": "Waves",
    "label.uv": "UV index",
    "label.elevation": "Elevation",
    "label.summit": "Summit",
    "verdict.above": "Above the cloud sea",
    "verdict.inside": "Summit inside the cloud",
    "verdict.none": "No cloud deck forecast",
    "profile.title": "Vertical profile",
    "profile.caption": "Vertical profile: cloud to {deck} m, summit at {summit} m",
    "profile.at_summit": "Cloud at summit {pct}%",
    "state.loading": "Loading conditions...",
    "state.error": "Could not load conditions.",
    "state.offline": "Offline - showing saved data",
    "state.stale": "Data out of date",
    "state.updated": "Updated {n} min ago",
    "warning.official": "Official IPMA warning",
    "warning.source": "View warnings at IPMA",
    "disclaimer.title": "This is not a safety advisory",
    "disclaimer.body":
      "These numbers describe forecast conditions and are not a safety recommendation. For trails and official warnings, always check IPMA and IFCN before you set out.",
    "footer.data": "Data",
  },
} as const;

export type TranslationKey = keyof (typeof DICTIONARY)["en"];

export function translate(
  locale: Locale,
  key: TranslationKey,
  vars?: Record<string, string | number>
): string {
  const text: string = DICTIONARY[locale][key] ?? DICTIONARY.en[key] ?? key;
  if (!vars) return text;
  return Object.entries(vars).reduce(
    (out, [name, value]) => out.replace(`{${name}}`, String(value)),
    text
  );
}

export function translator(locale: Locale) {
  return (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
}

/** Madeira observes WET/WEST, so local time is what a user should ever see. */
export function formatLocalTime(iso: string, locale: Locale): string {
  return new Date(iso).toLocaleTimeString(locale === "pt" ? "pt-PT" : "en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Atlantic/Madeira",
  });
}

export function formatLocalDate(iso: string, locale: Locale): string {
  return new Date(iso).toLocaleDateString(locale === "pt" ? "pt-PT" : "en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "Atlantic/Madeira",
  });
}

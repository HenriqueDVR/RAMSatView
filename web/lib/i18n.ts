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
    // Fanal: a nevoa e o motivo da visita, nao o que a estraga.
    "verdict.fog": "Floresta na nevoa",
    "verdict.no_fog": "Sem nevoa prevista",
    "calima.slight": "Ligeira bruma do Sara",
    "calima.noticeable": "Poeira do Sara a toldar a vista",
    "calima.heavy": "Calima forte - sem vista",
    "score.colour": "Cor do nascer",
    // --- reasons. The ingest publishes a code and the numbers behind it; the
    // wording lives here, with all the other wording, so the Portuguese half of
    // the site is not explained in English.
    "reason.vis.rain": "Chuva prevista ({mm} mm)",
    "reason.vis.cloud_above": "Nuvens acima do cume ({pct}%)",
    "reason.vis.clear_above": "Ar limpo acima do cume",
    "reason.vis.broken_above": "Nuvens dispersas acima do cume ({pct}%)",
    "reason.vis.cirrus": "Cirros altos - boa cor",
    "reason.wind.strong": "Vento forte ({kmh} km/h)",
    "reason.sea.inside": "Cume provavelmente dentro da nuvem ({pct}% a {m} m)",
    "reason.sea.deck_below":
      "Topo do mar de nuvens perto dos {m} m, abaixo do cume",
    "reason.sea.no_deck": "Sem mar de nuvens previsto abaixo do cume",
    "reason.sea.layer_above": "Camada de nuvens chega aos {m} m, acima do cume",
    "reason.sea.inversion": "Inversao termica presente (+{c} C)",
    "reason.fog.in_forest":
      "Nevoa na floresta ({pct}% a {m} m) - o motivo da visita",
    "reason.fog.patchy": "Nevoa irregular prevista ({pct}%)",
    "reason.fog.clear": "Ar limpo na floresta - sem nevoa prevista",
    "reason.fog.rain":
      "Chuva prevista ({mm} mm) - a nevoa e o atrativo, o aguaceiro nao",
    "reason.colour.empty": "Ceu vazio - limpo, mas sem nada para a luz acender",
    "reason.colour.lid": "Nuvens altas fechadas ({pct}%) - tampa, nao tela",
    "reason.colour.band": "Nuvens altas a {pct}% - a faixa que se acende",
    "reason.colour.some_high": "Algumas nuvens altas ({pct}%)",
    "reason.colour.mid_blocking":
      "Nuvens medias ({pct}%) a bloquear a luz vinda de baixo",
    "reason.colour.deck_floor": "Um mar de nuvens por baixo para apanhar a luz",
    "reason.colour.dust_reds":
      "Um pouco de poeira no ar - vermelhos mais fundos",
    "reason.colour.in_cloud": "Dentro da nuvem - daqui nao se ve o nascer",
    "reason.air.slight": "Ligeira bruma do Sara (AOD {aod})",
    "reason.air.noticeable": "Poeira do Sara a toldar a vista (AOD {aod})",
    "reason.air.heavy": "Calima forte - a vista vai desaparecer (AOD {aod})",
    "reason.air.dust": "poeira {dust} ug/m3",
    "reason.beach.rough": "Mar demasiado agitado para nadar a vontade",
    "reason.beach.calm": "Mar calmo",
    "reason.beach.moderate_swell": "Ondulacao moderada",
    "reason.beach.cold_water": "Agua fria para nadar",
    "reason.beach.chilly_wind": "Vento suficiente para arrefecer fora de agua",
    "reason.beach.high_uv": "UV muito alto - sombra e protetor solar",
    "reason.beach.warning": "Aviso {level} do IPMA em vigor: {type}",
    "profile.title": "Perfil vertical",
    "profile.caption": "Perfil vertical: nuvem ate {deck} m, cume a {summit} m",
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
    "layers.title": "Camadas",
    "layers.satellite": "Satelite",
    "layers.terrain": "Relevo 3D",
    "layers.cloud": "Nuvem",
    "layers.observed": "Nuvem observada",
    "layers.heatmap": "Altitude do topo",
    "legend.title": "Topo das nuvens",
    "legend.none": "Sem nuvem",
    "legend.arieiro": "Areeiro 1818 m",
    "legend.ruivo": "Ruivo 1862 m",
    "sidebar.title": "Locais",
    "layers.show": "Mostrar camadas",
    "time.now": "Agora",
    "time.scrub": "Hora mostrada",
    "time.sunrise": "Nascer do sol",
    "time.observed": "Periodo com imagem de satelite",
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
    // Fanal: the mist is the reason to go, not the thing that spoils it.
    "verdict.fog": "Forest in the mist",
    "verdict.no_fog": "No mist forecast",
    "calima.slight": "Slight Saharan haze",
    "calima.noticeable": "Saharan dust hazing the view",
    "calima.heavy": "Heavy calima - no view",
    "score.colour": "Sunrise colour",
    // --- reasons. The ingest publishes a code and the numbers behind it, and
    // the wording lives here alongside everything else the reader sees.
    "reason.vis.rain": "Rain forecast ({mm} mm)",
    "reason.vis.cloud_above": "Cloud above the summit ({pct}%)",
    "reason.vis.clear_above": "Clear air above the summit",
    "reason.vis.broken_above": "Broken cloud above the summit ({pct}%)",
    "reason.vis.cirrus": "High cirrus - good colour",
    "reason.wind.strong": "Strong wind ({kmh} km/h)",
    "reason.sea.inside": "Summit likely inside the cloud ({pct}% at {m} m)",
    "reason.sea.deck_below": "Cloud deck top near {m} m, below the summit",
    "reason.sea.no_deck": "No cloud deck forecast below the summit",
    "reason.sea.layer_above": "Cloud layer reaches {m} m, above the summit",
    "reason.sea.inversion": "Temperature inversion present (+{c} C)",
    "reason.fog.in_forest":
      "Cloud in the forest ({pct}% at {m} m) - the reason to come",
    "reason.fog.patchy": "Patchy mist forecast ({pct}%)",
    "reason.fog.clear": "Clear air in the forest - no mist forecast",
    "reason.fog.rain":
      "Rain forecast ({mm} mm) - mist is the draw, a downpour is not",
    "reason.colour.empty":
      "Empty sky - clear, but nothing for the light to catch",
    "reason.colour.lid":
      "High cloud closed over ({pct}%) - a lid rather than a canvas",
    "reason.colour.band": "High cloud at {pct}% - the band that lights up",
    "reason.colour.some_high": "Some high cloud ({pct}%)",
    "reason.colour.mid_blocking":
      "Middle cloud ({pct}%) blocking the light from below",
    "reason.colour.deck_floor": "A cloud sea underneath to catch it",
    "reason.colour.dust_reds": "A little dust in the air - deeper reds",
    "reason.colour.in_cloud": "In the cloud - no sunrise to see from here",
    "reason.air.slight": "Slight Saharan haze (AOD {aod})",
    "reason.air.noticeable": "Saharan dust hazing the view (AOD {aod})",
    "reason.air.heavy": "Heavy calima - the view will be gone (AOD {aod})",
    "reason.air.dust": "dust {dust} ug/m3",
    "reason.beach.rough": "Sea too rough to swim comfortably",
    "reason.beach.calm": "Calm sea",
    "reason.beach.moderate_swell": "Moderate swell",
    "reason.beach.cold_water": "Water is cold for swimming",
    "reason.beach.chilly_wind": "Windy enough to feel chilly out of the water",
    "reason.beach.high_uv": "Very high UV - shade and sunscreen",
    "reason.beach.warning": "IPMA {level} warning in force: {type}",
    "profile.title": "Vertical profile",
    "profile.caption":
      "Vertical profile: cloud to {deck} m, summit at {summit} m",
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
    "layers.title": "Layers",
    "layers.satellite": "Satellite",
    "layers.terrain": "3D terrain",
    "layers.cloud": "Cloud",
    "layers.observed": "Observed cloud",
    "layers.heatmap": "Cloud-top altitude",
    "legend.title": "Cloud top",
    "legend.none": "No cloud",
    "legend.arieiro": "Arieiro 1818 m",
    "legend.ruivo": "Ruivo 1862 m",
    "sidebar.title": "Spots",
    "layers.show": "Show layers",
    "time.now": "Now",
    "time.scrub": "Hour shown",
    "time.sunrise": "Sunrise",
    "time.observed": "Covered by satellite imagery",
  },
} as const;

export type TranslationKey = keyof (typeof DICTIONARY)["en"];

export function translate(
  locale: Locale,
  key: TranslationKey,
  vars?: Record<string, string | number>,
): string {
  const text: string = DICTIONARY[locale][key] ?? DICTIONARY.en[key] ?? key;
  if (!vars) return text;
  return Object.entries(vars).reduce(
    (out, [name, value]) => out.replace(`{${name}}`, String(value)),
    text,
  );
}

/** The bound translate function components take as a prop. */
export type Translate = (
  key: TranslationKey,
  vars?: Record<string, string | number>,
) => string;

/**
 * One reason, in the reader's language.
 *
 * Falls back to the bare code rather than an empty line. A score with an
 * unexplained number beside it is exactly what `validate()` refuses to publish
 * on the other side of the pipeline, and a missing translation must not be able
 * to produce one here either - it should look wrong, visibly, rather than
 * silently drop the explanation.
 */
export function reasonText(
  t: Translate,
  reason: { code: string; vars?: Record<string, string | number> },
): string {
  const key = `reason.${reason.code}` as TranslationKey;
  const text = t(key, reason.vars);
  return text === key ? reason.code : text;
}

export function translator(locale: Locale): Translate {
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

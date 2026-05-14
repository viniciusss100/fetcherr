const LANGUAGE_MARKERS: Record<string, { positive: RegExp; penalties: Array<{ pattern: RegExp; penalty: number }> }> = {
  en: {
    positive: /\boriginal\s*\(?eng(?:lish)?\)?\b|\boriginal audio\b.*\beng(?:lish)?\b|\benglish\b|\beng\b|\baudio[: ._-]*eng(?:lish)?\b|\u{1F1EC}\u{1F1E7}/u,
    penalties: [],
  },
  ja: {
    positive: /\bjapanese\b|\bjpn\b|\bnihongo\b|\boriginal\s*\(?jpn(?:ese)?\)?\b|\u{1F1EF}\u{1F1F5}/u,
    penalties: [],
  },
  es: {
    positive: /\besp\b|\bspa\b|\bspanish\b|\bespanol\b|\bespañol\b|\bcastellano\b|\blatino\b|\blatam\b|\boriginal\s*\(?spa(?:nish)?\)?\b|\u{1F1EA}\u{1F1F8}/u,
    penalties: [],
  },
  fr: {
    positive: /\btruefrench\b|\bfrench\b|\bfrancais\b|\bfrançais\b|\bfra\b|\bfre\b|\boriginal\s*\(?fre(?:nch)?\)?\b|\u{1F1EB}\u{1F1F7}/u,
    penalties: [],
  },
  de: {
    positive: /\bgerman\b|\bgerman\s*audio\b|\bdeutsch\b|\bger\b|\bdeu\b|\boriginal\s*\(?ger(?:man)?\)?\b|\u{1F1E9}\u{1F1EA}/u,
    penalties: [],
  },
  it: {
    positive: /\bitalian\b|\bitaliano\b|\bita\b|\boriginal\s*\(?ita(?:lian)?\)?\b|\u{1F1EE}\u{1F1F9}/u,
    penalties: [],
  },
  ko: {
    positive: /\bkorean\b|\bkor\b|\boriginal\s*\(?kor(?:ean)?\)?\b|\u{1F1F0}\u{1F1F7}/u,
    penalties: [],
  },
  zh: {
    positive: /\bmandarin\b|\bcantonese\b|\bchinese\b|\bchs\b|\bcht\b|\bzhs\b|\bzht\b|\bzho\b|\boriginal\s*\(?zho(?:nese)?\)?\b|\u{1F1E8}\u{1F1F3}/u,
    penalties: [],
  },
  pt: {
    positive: /\bportuguese\b|\bportugues\b|\bportuguês\b|\bpor\b|\bpt[ ._-]?br\b|\bdublado\b|\bdublagem\b|\boriginal\s*\(?por(?:tuguese)?\)?\b|\u{1F1F5}\u{1F1F9}|\u{1F1E7}\u{1F1F7}/u,
    penalties: [],
  },
  ru: {
    positive: /\brussian\b|\brus\b|\boriginal\s*\(?rus(?:sian)?\)?\b|\u{1F1F7}\u{1F1FA}/u,
    penalties: [],
  },
  hi: {
    positive: /\bhindi\b|\bhin\b|\burdu\b|\bmalay\b|\btamil\b|\btelugu\b|\bkannada\b|\bmalayalam\b|\boriginal\s*\(?hin(?:di)?\)?\b|\u{1F1EE}\u{1F1F3}/u,
    penalties: [],
  },
  ar: {
    positive: /\barabic\b|\bara\b|\bhebrew\b|\bheb\b|\bfarsi\b|\bpersian\b|\boriginal\s*\(?ara(?:bic)?\)?\b|\u{1F1F8}\u{1F1E6}|\u{1F1E6}\u{1F1EA}|\u{1F1EE}\u{1F1F1}|\u{1F1EE}\u{1F1F7}/u,
    penalties: [],
  },
}

const DEFAULT_LANGUAGE_PENALTIES: Array<{ pattern: RegExp; penalty: number }> = [
  { pattern: /\bdubbing\s*pl\b|\bpolish\b|\bpolski\b|\blektor\b|\u{1F1F5}\u{1F1F1}/u, penalty: 4 },
  { pattern: /\btruefrench\b|\bfrench\b|\bvff\b|\bvfq\b|\bmulti[ ._-]?vf\b|\u{1F1EB}\u{1F1F7}/u, penalty: 4 },
  { pattern: /\brus\b|\brussian\b|\u{1F1F7}\u{1F1FA}/u, penalty: 2 },
  { pattern: /\bukr\b|\bukrainian\b|\u{1F1FA}\u{1F1E6}/u, penalty: 2 },
  { pattern: /\bita\b|\bitalian\b|\u{1F1EE}\u{1F1F9}/u, penalty: 2 },
  { pattern: /\besp\b|\bspa\b|\bspanish\b|\bespanol\b|\bespañol\b|\bcastellano\b|\blatino\b|\blatam\b|\u{1F1EA}\u{1F1F8}/u, penalty: 2 },
  { pattern: /\bhindi\b|\bhin\b|\burdu\b|\bmalay\b|\btamil\b|\btelugu\b|\bkannada\b|\bmalayalam\b|\u{1F1EE}\u{1F1F3}/u, penalty: 2 },
  { pattern: /\bslosinh\b|\bslovenian\b|\bslo\b|\bslv\b|\bczech\b|\bcze\b|\bces\b|\bhungarian\b|\bhun\b|\bslovak\b|\bslk\b|\bsvk\b|\bserbian\b|\bsrp\b|\bcroatian\b|\bcro\b|\bhrv\b|\bbulgarian\b|\bbul\b|\bromanian\b|\bron\b|\brou\b|\u{1F1F8}\u{1F1EE}|\u{1F1E8}\u{1F1FF}|\u{1F1ED}\u{1F1FA}|\u{1F1F8}\u{1F1F0}|\u{1F1F7}\u{1F1F8}|\u{1F1ED}\u{1F1F7}|\u{1F1E7}\u{1F1EC}|\u{1F1F7}\u{1F1F4}/u, penalty: 2 },
  { pattern: /\bturkish\b|\btur\b|\bgreek\b|\bgre\b|\bgerman\b|\bger\b|\bdeutsch\b|\bdeu\b|\bdutch\b|\bnld\b|\u{1F1F9}\u{1F1F7}|\u{1F1EC}\u{1F1F7}|\u{1F1E9}\u{1F1EA}|\u{1F1F3}\u{1F1F1}/u, penalty: 2 },
  { pattern: /\bdanish\b|\bfinnish\b|\bicelandic\b|\bisl\b|\bswedish\b|\bswe\b|\bnorwegian\b|\bnor\b|\u{1F1E9}\u{1F1F0}|\u{1F1EB}\u{1F1EE}|\u{1F1F8}\u{1F1EA}|\u{1F1F3}\u{1F1F4}/u, penalty: 2 },
  { pattern: /\bjapanese\b|\bjpn\b|\bkorean\b|\bkor\b|\bmandarin\b|\bcantonese\b|\bchinese\b|\bchs\b|\bcht\b|\bzhs\b|\bzht\b|\bzho\b|\bthai\b|\btha\b|\bindonesian\b|\bindo\b|\bvietnamese\b|\bvie\b|\btagalog\b|\bfilipino\b|\u{1F1E8}\u{1F1F3}|\u{1F1F9}\u{1F1FC}|\u{1F1EF}\u{1F1F5}|\u{1F1F0}\u{1F1F7}|\u{1F1F9}\u{1F1ED}|\u{1F1FB}\u{1F1F3}|\u{1F1EE}\u{1F1E9}/u, penalty: 2 },
  { pattern: /\barabic\b|\bara\b|\bhebrew\b|\bheb\b|\bfarsi\b|\bpersian\b|\u{1F1F8}\u{1F1E6}|\u{1F1E6}\u{1F1EA}|\u{1F1EE}\u{1F1F1}|\u{1F1EE}\u{1F1F7}/u, penalty: 2 },
  { pattern: /\bportuguese\b|\bportugues\b|\bpor\b|\bpt[ ._-]?br\b|\bdublado\b|\bdublagem\b|\u{1F1F5}\u{1F1F9}|\u{1F1E7}\u{1F1F7}/u, penalty: 2 },
]

function normalizeLanguageCode(value: string): string {
  return value.trim().toLowerCase().replace(/_/g, '-')
}

function languageAliases(language: string): string[] {
  const normalized = normalizeLanguageCode(language)
  switch (normalized) {
    case 'en':
    case 'eng':
    case 'english':
      return ['en', 'eng', 'english']
    case 'ja':
    case 'jpn':
    case 'japanese':
      return ['ja', 'jpn', 'japanese', 'nihongo']
    case 'es':
    case 'spa':
    case 'spanish':
    case 'espanol':
    case 'español':
      return ['es', 'spa', 'spanish', 'espanol', 'español', 'castellano', 'latino', 'latam']
    case 'fr':
    case 'fre':
    case 'fra':
    case 'french':
      return ['fr', 'fre', 'fra', 'french', 'francais', 'français']
    case 'de':
    case 'ger':
    case 'deu':
    case 'german':
      return ['de', 'ger', 'deu', 'german', 'deutsch']
    case 'it':
    case 'ita':
    case 'italian':
      return ['it', 'ita', 'italian', 'italiano']
    case 'ko':
    case 'kor':
    case 'korean':
      return ['ko', 'kor', 'korean']
    case 'zh':
    case 'zho':
    case 'chi':
    case 'chinese':
      return ['zh', 'zho', 'chi', 'chs', 'cht', 'zhs', 'zht', 'chinese', 'mandarin', 'cantonese']
    case 'pt':
    case 'por':
    case 'portuguese':
      return ['pt', 'por', 'portuguese', 'portugues', 'português', 'pt-br', 'ptbr', 'brazilian']
    case 'ru':
    case 'rus':
    case 'russian':
      return ['ru', 'rus', 'russian']
    case 'hi':
    case 'hin':
    case 'hindi':
      return ['hi', 'hin', 'hindi']
    case 'ar':
    case 'ara':
    case 'arabic':
      return ['ar', 'ara', 'arabic']
    default:
      return [normalized]
  }
}

function hasLanguageMarker(text: string, language: string): boolean {
  const aliases = languageAliases(language)
  return aliases.some(alias => {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`\\b${escaped}\\b`, 'u').test(text)
  })
}

function languagePenalty(text: string, preferredLanguage: string): number {
  if (preferredLanguage === 'en' || preferredLanguage === 'eng' || preferredLanguage === 'english') {
    return DEFAULT_LANGUAGE_PENALTIES.reduce(
      (penalty, marker) => penalty + (marker.pattern.test(text) ? marker.penalty : 0),
      0,
    )
  }

  let penalty = 0
  for (const marker of DEFAULT_LANGUAGE_PENALTIES) {
    if (marker.pattern.test(text)) penalty += marker.penalty
  }
  return hasLanguageMarker(text, preferredLanguage) ? 0 : penalty
}

export function hasEnglishAudioMarker(text: string): boolean {
  return hasLanguageMarker(text, 'en')
}

export function hasNonEnglishAudioMarker(text: string): boolean {
  return languagePenalty(text, 'en') > 0
}

export function nonEnglishAudioPenalty(text: string): number {
  return languagePenalty(text, 'en')
}

export function hasPreferredAudioMarker(text: string, preferredLanguage: string): boolean {
  return hasLanguageMarker(text, preferredLanguage)
}

export function hasNonPreferredAudioMarker(text: string, preferredLanguage: string): boolean {
  return languagePenalty(text, preferredLanguage) > 0
}

export function nonPreferredAudioPenalty(text: string, preferredLanguage: string): number {
  return languagePenalty(text, preferredLanguage)
}

export function normalizeAudioLanguage(value: string): string {
  return normalizeLanguageCode(value)
}

export function hasAudioLanguage(languages: string[], preferredLanguage: string): boolean {
  const aliases = languageAliases(preferredLanguage)
  return languages.some(lang => {
    const normalized = normalizeAudioLanguage(lang)
    return aliases.some(alias => normalized === alias || normalized.startsWith(`${alias}-`))
  })
}

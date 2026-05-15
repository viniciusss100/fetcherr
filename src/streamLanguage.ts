import { AUDIO_LANGUAGE_ALIASES, type AudioLanguage } from './config.js'

const ENGLISH_AUDIO_MARKER_RE = /\boriginal\s*\(?eng(?:lish)?\)?\b|\boriginal audio\b.*\beng(?:lish)?\b|\benglish\b|\beng\b|\baudio[: ._-]*eng(?:lish)?\b|\u{1F1EC}\u{1F1E7}/u
const PT_PREMIUM_AUDIO_MARKER_RE = /\b(?:cypher|freddiegellar|dual-bioma|dual-c76|tossato|c0ral|dual-nogroup|dual-pia|dual-xor|dual-xar|g4ris|dual-sigma|andrehsa|riper|sigla|tontom|dual-eck|1-sf|0-sf|rarbr|tupac|alfahd|dual-cza|dual-7sprite7|potatin|dual-fly|franceira)\b/iu
const PT_VERY_STRONG_AUDIO_MARKER_RE = /\bdublado\b|\bdublagem\b|\bpt[ ._-]?br\b|\bpor[ ._-]?br\b|\bbrazilian\b|\bbrasileiro\b|\bportuguese\b|\bportugues\b/iu
const PT_STRONG_AUDIO_MARKER_RE = /\bdual[ ._-]?audio\b|\baudio[ ._-]?dual\b|\bdubbed\b|\bdual\b/iu
const PT_WEAK_AUDIO_MARKER_RE = /\u{1F1E7}\u{1F1F7}/u

const LANGUAGE_MATCH_WEIGHTS: Record<AudioLanguage, number> = {
  en: 2,
  ja: 2,
  es: 2,
  fr: 2,
  de: 2,
  it: 2,
  ko: 2,
  zh: 2,
  pt: 2,
  ru: 2,
  hi: 2,
  ar: 2,
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function markerPattern(language: AudioLanguage): RegExp {
  const aliases = AUDIO_LANGUAGE_ALIASES[language].map(alias => escapeRegex(alias))
  return new RegExp(`(?:${aliases.join('|')})`, 'iu')
}

export function hasAudioLanguageMarker(text: string, language: AudioLanguage): boolean {
  return markerPattern(language).test(text)
}

export function hasEnglishAudioMarker(text: string): boolean {
  return hasAudioLanguageMarker(text, 'en')
}

export function hasPreferredAudioMarker(text: string, language: AudioLanguage): boolean {
  return preferredAudioMarkerScore(text, language) > 0
}

export function hasNonPreferredAudioMarker(text: string, language: AudioLanguage): boolean {
  return (Object.keys(AUDIO_LANGUAGE_ALIASES) as AudioLanguage[]).some(otherLanguage =>
    otherLanguage !== language && hasAudioLanguageMarker(text, otherLanguage),
  )
}

export function preferredAudioPenalty(text: string, language: AudioLanguage): number {
  if (language === 'pt' && PT_PREMIUM_AUDIO_MARKER_RE.test(text)) {
    return 0
  }
  return (Object.keys(AUDIO_LANGUAGE_ALIASES) as AudioLanguage[]).reduce((penalty, otherLanguage) => {
    if (otherLanguage === language) return penalty
    if (!hasAudioLanguageMarker(text, otherLanguage)) return penalty
    return penalty + LANGUAGE_MATCH_WEIGHTS[otherLanguage]
  }, 0)
}

export function preferredAudioMarkerScore(text: string, language: AudioLanguage): number {
  if (language === 'pt') {
    if (PT_PREMIUM_AUDIO_MARKER_RE.test(text)) return 6
    if (PT_VERY_STRONG_AUDIO_MARKER_RE.test(text)) return 5
    if (PT_STRONG_AUDIO_MARKER_RE.test(text)) return 3
    if (PT_WEAK_AUDIO_MARKER_RE.test(text) || hasAudioLanguageMarker(text, language)) return 1
    return 0
  }
  return hasAudioLanguageMarker(text, language) ? 2 : 0
}

export function nonPreferredAudioPenalty(text: string, language: AudioLanguage): number {
  return preferredAudioPenalty(text, language)
}

export function nonEnglishAudioPenalty(text: string): number {
  return preferredAudioPenalty(text, 'en')
}

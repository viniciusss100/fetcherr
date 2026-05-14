import { AUDIO_LANGUAGE_ALIASES, type AudioLanguage } from './config.js'

const ENGLISH_AUDIO_MARKER_RE = /\boriginal\s*\(?eng(?:lish)?\)?\b|\boriginal audio\b.*\beng(?:lish)?\b|\benglish\b|\beng\b|\baudio[: ._-]*eng(?:lish)?\b|\u{1F1EC}\u{1F1E7}/u

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
  return hasAudioLanguageMarker(text, language)
}

export function hasNonPreferredAudioMarker(text: string, language: AudioLanguage): boolean {
  return (Object.keys(AUDIO_LANGUAGE_ALIASES) as AudioLanguage[]).some(otherLanguage =>
    otherLanguage !== language && hasAudioLanguageMarker(text, otherLanguage),
  )
}

export function preferredAudioPenalty(text: string, language: AudioLanguage): number {
  return (Object.keys(AUDIO_LANGUAGE_ALIASES) as AudioLanguage[]).reduce((penalty, otherLanguage) => {
    if (otherLanguage === language) return penalty
    if (!hasAudioLanguageMarker(text, otherLanguage)) return penalty
    return penalty + LANGUAGE_MATCH_WEIGHTS[otherLanguage]
  }, 0)
}

export function nonEnglishAudioPenalty(text: string): number {
  return preferredAudioPenalty(text, 'en')
}

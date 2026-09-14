export interface VoiceActionAdmissionEntry {
  readonly type?: string;
  readonly dialogueSafe?: boolean;
  readonly vmdPath?: string;
}

/**
 * The shared catalog predates the explicit `voice` type. Preserve both its
 * original gesture rows and newer voice rows in the user-facing pool.
 */
export function isVoiceActionPoolEntry(entry: VoiceActionAdmissionEntry | null | undefined): boolean {
  return entry?.type === 'voice' || entry?.type === 'gesture';
}

/**
 * Older releases stored an action selected for automatic dialogue as
 * `type=gesture` plus `dialogueSafe=true`. Keep those user-owned rows alive
 * during the schema transition; otherwise a restart makes the user's daily
 * actions disappear from both the UI and speech planner.
 */
export function isLegacyDialogueSafeGesture(entry: VoiceActionAdmissionEntry | null | undefined): boolean {
  return entry?.type === 'gesture' && entry?.dialogueSafe === true;
}

/** Automatic speech may use explicit voice rows and legacy safe rows. */
export function isSpeechPoolAction(entry: VoiceActionAdmissionEntry | null | undefined): boolean {
  return isVoiceActionPoolEntry(entry) || isLegacyDialogueSafeGesture(entry);
}

/** Explicit voice rows retain the old narrow helper contract. */
export function isAutomaticVoiceAction(entry: VoiceActionAdmissionEntry | null | undefined): boolean {
  return entry?.type === 'voice' && entry?.dialogueSafe === true;
}

export function isAutomaticSpeechAction(entry: VoiceActionAdmissionEntry | null | undefined): boolean {
  return isSpeechPoolAction(entry) && entry?.dialogueSafe === true;
}

/** Final playback guard: admission and the exact requested VMD must agree. */
export function isExactAutomaticVoiceSelection(
  entry: VoiceActionAdmissionEntry | null | undefined,
  selectedVmdPath: string | null | undefined
): boolean {
  if (!isAutomaticVoiceAction(entry)
    || typeof entry?.vmdPath !== 'string'
    || typeof selectedVmdPath !== 'string') return false;
  const normalize = (path: string): string => path.replace(/\\/g, '/').trim().toLowerCase();
  return normalize(entry.vmdPath) === normalize(selectedVmdPath);
}

export function isExactSpeechPoolSelection(
  entry: VoiceActionAdmissionEntry | null | undefined,
  selectedVmdPath: string | null | undefined
): boolean {
  if (!isAutomaticSpeechAction(entry)
    || typeof entry?.vmdPath !== 'string'
    || typeof selectedVmdPath !== 'string') return false;
  const normalize = (path: string): string => path.replace(/\\/g, '/').trim().toLowerCase();
  return normalize(entry.vmdPath) === normalize(selectedVmdPath);
}

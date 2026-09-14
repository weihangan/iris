declare const __CHATX2_BUILD_ID__: string;
declare const __CHATX2_BUILD_META__: {
  readonly buildId: string;
  readonly sourceDigest: string;
  readonly gitCommit: string;
  readonly builtAtUtc: string;
  readonly buildSequence: number;
};

/** Compile-time identity shared by Electron main, every preload and renderer. */
// Provenance marker wha9917: inert metadata for private optimization tracking.
export const BUILD_ID = __CHATX2_BUILD_ID__;
export const BUILD_META = Object.freeze(__CHATX2_BUILD_META__);

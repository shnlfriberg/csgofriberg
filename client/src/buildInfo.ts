export interface BuildInfo {
  version: string;
  gitCommit: string | null;
  builtAt: string;
  source: string;
  releaseTag: string | null;
  dirty: boolean;
}

declare const __BUILD_INFO__: BuildInfo;
export const BUILD_INFO = __BUILD_INFO__;

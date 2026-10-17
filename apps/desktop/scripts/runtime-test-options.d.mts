export const RUNTIME_TEST_FILE_WORKERS: 2;
export function runtimeTestArguments(
  tsxPath: string,
  tests: string[],
  options?: { ci?: boolean; rerunState?: string },
): string[];
export const RUNTIME_TEST_CI_ATTEMPTS: 2;
export const RUNTIME_TEST_CI_TIMEOUT_MS: 240000;
export const WINDOWS_NATIVE_TEST_PRIORITY: readonly string[];
export function orderRuntimeTestFiles(
  files: string[],
  platform?: string,
): string[];
export function runtimeTestGroups(
  files: string[],
  platform?: string,
): { name: string; files: string[] }[];
export function runRuntimeTestGroups(options: {
  executable: string;
  tsxPath: string;
  groups: { name: string; files: string[] }[];
  env: NodeJS.ProcessEnv;
  ci?: boolean;
  receiptDirectory: string;
  stdio?: 'inherit' | 'pipe';
}): {
  exitCode: number;
  receipts: {
    name: string;
    files: string[];
    status: string;
    attempts: { exitCode: number | null; signal: NodeJS.Signals | null }[];
    flaky?: true;
  }[];
};

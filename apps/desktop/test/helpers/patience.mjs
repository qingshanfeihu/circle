// A CI runner is several times slower than a developer machine, and the
// Windows and Intel macOS runners slower still. A wait for a condition uses
// this; a check of how fast something happens must not.
export const patience = (ms) => (process.env.CI ? ms * 3 : ms);

import { CheckpointStore } from './checkpoint_store.js';
import { readLegacyPlans, type MigrationReport } from './legacy_sessions.js';
export function migrateLegacy(
  home: string,
  store: CheckpointStore,
): MigrationReport {
  const report: MigrationReport = { imported: [], skipped: [], errors: [] };
  try {
    const source = readLegacyPlans(
      home,
      store.importedLegacyKeys(),
      new Set(store.list(undefined, true).map((session) => session.id)),
    );
    report.errors.push(...source.errors);
    report.skipped.push(...source.skipped);
    for (const plan of source.plans) {
      try {
        const result = store.importLegacy(plan);
        report[result].push(plan.session.thread_id);
      } catch (error) {
        report.errors.push({
          thread: plan.session.thread_id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    report.errors.push({
      thread: '',
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return report;
}

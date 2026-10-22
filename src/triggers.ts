const COLLECTION_HANDLER = "runMvpShadow";
const WATCHDOG_HANDLER = "runMvpWatchdog";
const CONTINUATION_HANDLER = "continueMvpShadow";
const CONTINUATION_DELAY_MS = 60_000;
export const COLLECTION_INTERVAL_HOURS = 2;

export interface TriggerPlan {
  create: boolean;
  deleteIndexes: number[];
}

export function planSingleTrigger(existingCount: number): TriggerPlan {
  if (!Number.isInteger(existingCount) || existingCount < 0) {
    throw new Error("existingCount must be a non-negative integer");
  }
  return {
    create: existingCount === 0,
    deleteIndexes: Array.from(
      { length: Math.max(existingCount - 1, 0) },
      (_, index) => index + 1,
    ),
  };
}

export interface TriggerInstallResult {
  active: number;
  created: boolean;
  removedDuplicates: number;
}

export interface MvpTriggerInstallResult {
  collection: TriggerInstallResult;
  watchdog: TriggerInstallResult;
}

function ensureHandlerTrigger(
  handler: string,
  create: () => GoogleAppsScript.Script.Trigger,
): TriggerInstallResult {
  const matchingTriggers = ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === handler);
  const plan = planSingleTrigger(matchingTriggers.length);
  for (const index of plan.deleteIndexes) {
    ScriptApp.deleteTrigger(matchingTriggers[index]);
  }
  if (plan.create) {
    create();
  }
  return {
    active: 1,
    created: plan.create,
    removedDuplicates: plan.deleteIndexes.length,
  };
}

function replaceHandlerTrigger(
  handler: string,
  create: () => GoogleAppsScript.Script.Trigger,
): TriggerInstallResult {
  const matchingTriggers = ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === handler);
  create();
  for (const trigger of matchingTriggers) {
    ScriptApp.deleteTrigger(trigger);
  }
  return {
    active: 1,
    created: true,
    removedDuplicates: Math.max(matchingTriggers.length - 1, 0),
  };
}

export function ensureMvpTriggers(): MvpTriggerInstallResult {
  return {
    collection: replaceHandlerTrigger(
      COLLECTION_HANDLER,
      () => ScriptApp.newTrigger(COLLECTION_HANDLER)
        .timeBased()
        .everyHours(COLLECTION_INTERVAL_HOURS)
        .create(),
    ),
    watchdog: ensureHandlerTrigger(
      WATCHDOG_HANDLER,
      () => ScriptApp.newTrigger(WATCHDOG_HANDLER).timeBased().everyDays(1).create(),
    ),
  };
}

export function ensureMvpContinuationTrigger(): TriggerInstallResult {
  return ensureHandlerTrigger(
    CONTINUATION_HANDLER,
    () => ScriptApp.newTrigger(CONTINUATION_HANDLER)
      .timeBased()
      .after(CONTINUATION_DELAY_MS)
      .create(),
  );
}

export function deleteMvpContinuationTriggers(): number {
  const matchingTriggers = ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === CONTINUATION_HANDLER);
  for (const trigger of matchingTriggers) {
    ScriptApp.deleteTrigger(trigger);
  }
  return matchingTriggers.length;
}

export function deleteMvpTriggers(): number {
  const matchingTriggers = ScriptApp.getProjectTriggers()
    .filter((trigger) => [COLLECTION_HANDLER, WATCHDOG_HANDLER, CONTINUATION_HANDLER]
      .includes(trigger.getHandlerFunction()));
  for (const trigger of matchingTriggers) {
    ScriptApp.deleteTrigger(trigger);
  }
  return matchingTriggers.length;
}
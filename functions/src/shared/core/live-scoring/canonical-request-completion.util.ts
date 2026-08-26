export interface CanonicalRequestCompletionDecision {
  needsFollowUp: boolean;
  satisfied: boolean;
  completionState: 'superseded' | 'satisfied' | 'not-applicable';
}

export function decideCanonicalRequestCompletion(input: {
  resultStatus: 'success' | 'skipped' | 'error';
  taskSourceVersion: string;
  latestRequestedSourceVersion: string;
}): CanonicalRequestCompletionDecision {
  const taskSourceVersion = input.taskSourceVersion.trim();
  const latestRequestedSourceVersion =
    input.latestRequestedSourceVersion.trim();
  const hasLatestRequest = latestRequestedSourceVersion.length > 0;
  const satisfied = input.resultStatus === 'success' &&
    taskSourceVersion.length > 0 &&
    taskSourceVersion === latestRequestedSourceVersion;
  const needsFollowUp = hasLatestRequest && !satisfied;

  return {
    needsFollowUp,
    satisfied,
    completionState: needsFollowUp
      ? 'superseded'
      : satisfied
        ? 'satisfied'
        : 'not-applicable',
  };
}

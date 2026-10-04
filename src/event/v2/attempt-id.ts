/** Builds a deterministic identity for one tool execution within a Run stream. */
export function toolExecutionAttemptId(
  streamId: string | undefined,
  stepId: string,
  toolCallId: string,
): string {
  return `tool-attempt:${JSON.stringify([streamId ?? 'initial', stepId, toolCallId])}`;
}

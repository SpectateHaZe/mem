/** The settings layer decodes an empty Binary path to this command name, meaning "resolve on PATH". */
const PATH_COMMAND_FALLBACK = "opencode";

export function resolveOpenCodeBinaryPath(input: {
  readonly configuredPath: string | undefined;
  readonly bundledPath: string | undefined;
  readonly bundledPathExists: boolean;
}): string | undefined {
  const configured = input.configuredPath?.trim();
  if (configured !== undefined && configured.length > 0 && configured !== PATH_COMMAND_FALLBACK) {
    return configured;
  }
  const bundled = input.bundledPath?.trim();
  if (input.bundledPathExists && bundled !== undefined && bundled.length > 0) {
    return bundled;
  }
  return configured !== undefined && configured.length > 0 ? configured : undefined;
}

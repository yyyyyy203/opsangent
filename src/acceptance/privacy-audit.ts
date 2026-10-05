const CREDENTIAL_VALUE = /\bBearer\s+[^\s"',;}]+|\b(?:sk|rk|pk|gh[pousr]|xox[baprs])[-_][A-Za-z0-9_-]{16,}|\bAKIA[0-9A-Z]{16}\b/iu;
const WINDOWS_PRIVATE_PATH = /(?:^|[\s("'=])(?:[A-Z]:[\\/]|\\\\[^\\/\s]+[\\/][^\\/\s]+[\\/])[^\s"'<>]*/iu;
const UNIX_PRIVATE_PATH = /(?:^|[\s("'=])\/(?:home|Users|var|etc|opt|tmp|mnt|workspace|app|data)\/[^\s"'<>]*/iu;
const FILE_URI = /\bfile:\/\//iu;
const INTERNAL_ADDRESS = /(?:https?:\/\/)?(?:localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|[\w.-]*\.internal)(?::\d+)?(?:\/\S*)?/iu;
const FORBIDDEN_FIELD = /(?:authorization|cookie|password|passwd|secret|access[_-]?token|refresh[_-]?token|api[_-]?key|system[_-]?prompt|storage[_-]?key|private[_-]?key|credential|headers)/iu;

export function containsSensitivePublicContent(value: string, sensitiveValues: readonly string[] = []): boolean {
  return sensitiveValues.some((secret) => secret.length > 0 && value.includes(secret))
    || CREDENTIAL_VALUE.test(value)
    || WINDOWS_PRIVATE_PATH.test(value)
    || UNIX_PRIVATE_PATH.test(value)
    || FILE_URI.test(value)
    || INTERNAL_ADDRESS.test(value);
}

export function isForbiddenPublicFieldName(key: string, sensitiveValues: readonly string[] = []): boolean {
  if (key === 'rawSha256') return false;
  return /^raw/iu.test(key)
    || sensitiveValues.some((secret) => secret.length > 0 && key.includes(secret))
    || containsSensitivePublicContent(key)
    || FORBIDDEN_FIELD.test(key);
}

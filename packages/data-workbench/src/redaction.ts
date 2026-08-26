export function redactSensitiveDetails(message: string): string {
  return message
    .replace(
      /^(\s*(?:cookie|token|authorization|api[_-]?key|password)\s*[:=]).*$/gim,
      "$1[REDACTED]",
    )
    .replace(
      /("(?:cookie|token|authorization|api[_-]?key|password)"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
      "$1\"[REDACTED]\"",
    )
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(
      /([?&](?:signature|sig|token|api[_-]?key|access[_-]?key|x-amz-signature|ossaccesskeyid)=)[^&#\s]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /\b(cookie|token|authorization|api[_-]?key|password)\b\s*([:=])\s*[^\s,;]+/gi,
      "$1$2[REDACTED]",
    );
}

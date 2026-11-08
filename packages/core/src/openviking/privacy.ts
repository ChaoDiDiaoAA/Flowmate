// shortcut: detects explicit credential markers, use structured sensitivity metadata when it is available.
export function hasCredentialMarker(text: string): boolean {
  return /(?:\b(?:password|passcode|api[ _-]?key)|密码|口令|验证码)["'`”’]?[ \t]*[:=：＝][ \t]*(?:["'`“‘][ \t]*)?[^\s"'`“”‘’,;}\]]/i.test(text)
    || /\bauthorization["'`”’]?[ \t]*[:=：＝][ \t]*["'`“‘]?bearer[ \t]+[a-z0-9._+/~-]/i.test(text)
    || /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/i.test(text);
}

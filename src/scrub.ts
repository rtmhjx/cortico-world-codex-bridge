/** Redact credentials from public conversation text before it leaves the source. */
export function scrubText(text: string): string {
  const key = '(?:api[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|authorization|password|passwd|secret|client[_-]?secret|session[_-]?cookie|cookie)';
  return text
    .replace(new RegExp(`(["']?${key}["']?\\s*[:=]\\s*)(["'])(?:\\\\.|(?!\\2)[\\s\\S])*\\2`, 'gi'), '$1$2[REDACTED]$2')
    .replace(/(\b(?:cookie|set-cookie)\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+={0,2}/gi, 'Bearer [REDACTED]')
    .replace(new RegExp(`(\\b${key}\\s*[:=]\\s*)(?!["']|Bearer\\b)([^\\s,;\\]}>]+)`, 'gi'), '$1[REDACTED]')
    .replace(/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]');
}

/** A clipped public prefix must not leak an unterminated quoted credential. */
export function scrubTextPrefix(text:string,truncated:boolean):string {
  const safe=scrubText(text);
  if(!truncated)return safe;
  const key='(?:api[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|authorization|password|passwd|secret|client[_-]?secret|session[_-]?cookie|cookie)';
  return safe.replace(new RegExp(`(["']?${key}["']?\\s*[:=]\\s*)(["'])(?:\\\\.|(?!\\2)[\\s\\S])*$`,'gi'),'$1$2[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]*/g,'[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*){0,2}/g,'[REDACTED]');
}

/** New passwords must fit bcrypt's UTF-8 input, rather than silently truncate. */
export function validNewPassword(value: string): boolean {
  return value.length >= 10 && new TextEncoder().encode(value).length <= 72;
}

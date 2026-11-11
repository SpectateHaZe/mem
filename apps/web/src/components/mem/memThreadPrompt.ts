/** The shortest unambiguous tail of a thread id, for naming a thread in prose. */
export function shortThreadId(threadId: string): string {
  const separator = Math.max(threadId.lastIndexOf(":"), threadId.lastIndexOf("_"));
  const tail = threadId.slice(separator + 1);
  const visible = tail.length > 0 ? tail : threadId;
  return visible.length <= 8 ? visible : visible.slice(0, 8);
}

/**
 * The unsent opener Mem gets when the owner asks about a thread: a name and an id so Mem can find
 * it, then a colon so the owner only has to finish the sentence.
 */
export function memThreadSeed(title: string | null, threadId: string): string {
  const name = title?.trim();
  return `About "${name && name.length > 0 ? name : "this thread"}" (${shortThreadId(threadId)}): `;
}

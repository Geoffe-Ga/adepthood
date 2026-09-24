/**
 * Best-effort clipboard write that survives the absence of
 * ``expo-clipboard``. The web bundle hits ``navigator.clipboard``
 * (works on RN web); React Native targets fall through to the rejection
 * branch and the caller renders its own fallback. Pulled into a tiny
 * helper so tests can mock it without touching globals, and shared so a
 * second feature need not import another feature's component to copy text.
 */
interface ClipboardHost {
  clipboard?: { writeText?: (_v: string) => Promise<void> };
}

export async function copyToClipboard(value: string): Promise<boolean> {
  const host: ClipboardHost =
    typeof navigator === 'undefined' ? {} : (navigator as unknown as ClipboardHost);
  const writer = host.clipboard?.writeText;
  if (!writer) return false;
  try {
    await writer.call(host.clipboard, value);
    return true;
  } catch {
    return false;
  }
}

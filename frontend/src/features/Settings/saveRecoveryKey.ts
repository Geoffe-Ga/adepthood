import { Platform, Share } from 'react-native';

const DOWNLOAD_TITLE = 'Adepthood private vault recovery key';
const DOWNLOAD_NAME = 'adepthood-private-vault-recovery-key.txt';

function recoveryDocument(recoveryKey: string): string {
  return [
    DOWNLOAD_TITLE,
    '',
    recoveryKey,
    '',
    'Keep this file somewhere only you can reach. Adepthood cannot replace this key.',
  ].join('\n');
}

interface ClipboardHost {
  clipboard?: { writeText?: (_value: string) => Promise<void> };
}

/** Copy only in direct response to a user action; never retain a second copy. */
export async function copyRecoveryKey(recoveryKey: string): Promise<boolean> {
  const host: ClipboardHost =
    typeof navigator === 'undefined' ? {} : (navigator as unknown as ClipboardHost);
  const writeText = host.clipboard?.writeText;
  if (!writeText) return false;
  try {
    await writeText.call(host.clipboard, recoveryKey);
    return true;
  } catch {
    return false;
  }
}

interface DownloadAnchor {
  href: string;
  download: string;
  click: () => void;
  remove: () => void;
}

interface WebDownloadHost {
  Blob?: new (_parts: string[], _options: { type: string }) => unknown;
  URL?: {
    createObjectURL?: (_value: unknown) => string;
    revokeObjectURL?: (_value: string) => void;
  };
  document?: {
    createElement?: (_tag: 'a') => DownloadAnchor;
    body?: { appendChild: (_anchor: DownloadAnchor) => void };
  };
}

function saveOnWeb(contents: string): boolean {
  const host = globalThis as unknown as WebDownloadHost;
  const createObjectURL = host.URL?.createObjectURL;
  const revokeObjectURL = host.URL?.revokeObjectURL;
  const createElement = host.document?.createElement;
  const body = host.document?.body;
  if (!host.Blob || !createObjectURL || !revokeObjectURL || !createElement || !body) return false;

  const objectUrl = createObjectURL(
    new host.Blob([contents], { type: 'text/plain;charset=utf-8' }),
  );
  try {
    const anchor = createElement.call(host.document, 'a');
    anchor.href = objectUrl;
    anchor.download = DOWNLOAD_NAME;
    body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return true;
  } finally {
    revokeObjectURL.call(host.URL, objectUrl);
  }
}

/** Download on web or open the OS save/share sheet on iOS and Android. */
export async function saveRecoveryKeyLocally(recoveryKey: string): Promise<boolean> {
  const contents = recoveryDocument(recoveryKey);
  if (Platform.OS === 'web') return saveOnWeb(contents);
  try {
    const result = await Share.share({ message: contents, title: DOWNLOAD_TITLE });
    return result.action !== Share.dismissedAction;
  } catch {
    return false;
  }
}

/**
 * A file from the phone — a PDF or a picture — for screens that take documents.
 *
 * `expo-document-picker` is required lazily: it is a native module, and a build
 * made before it was added has no such module, so a top-level import would take
 * the whole screen down rather than just this one button.
 */
type DocumentPickerModule = {
  getDocumentAsync: (options: { type: string[] }) => Promise<{
    assets?: { mimeType?: string; name: string; size?: number; uri: string }[] | null;
    canceled: boolean;
  }>;
};

export type PickedDocument = { fileName?: string | null; fileSize?: number; mimeType?: string; uri: string };

/** Null when cancelled. Throws when this build has no file picker at all. */
export async function pickDocument(
  types: string[] = ["application/pdf", "image/jpeg", "image/png", "image/webp"],
): Promise<PickedDocument | null> {
  let picker: DocumentPickerModule;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    picker = require("expo-document-picker") as DocumentPickerModule;
  } catch {
    throw new Error("This app version cannot open files. Use the camera instead.");
  }

  const result = await picker.getDocumentAsync({ type: types });
  const file = result.canceled ? null : result.assets?.[0];

  return file ? { fileName: file.name, fileSize: file.size, mimeType: file.mimeType, uri: file.uri } : null;
}

import type { ReactNode } from "react";

/** One piece of text in both languages; the Nepali falls back to the English. */
export function L({ en, ne }: { en: ReactNode; ne?: ReactNode }) {
  return (
    <>
      <span className="guide-en">{en}</span>
      <span className="guide-ne" lang="ne">
        {ne ?? en}
      </span>
    </>
  );
}

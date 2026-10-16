import { DocumentScreen } from "@/components/document-screen";

/**
 * About Us. Values render as paragraphs rather than bullets, which is the one
 * layout choice the website makes differently on this page and the reason
 * `DocumentScreen` takes a variant at all.
 */
export default function AboutScreen() {
  return (
    <DocumentScreen
      icon="business"
      page="about"
      webPath="about"
      title="About {siteName}"
      variant="paragraphs"
    />
  );
}

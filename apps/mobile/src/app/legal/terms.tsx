import { DocumentScreen } from "@/components/document-screen";

/**
 * Terms & Regulations. Same arrangement as the privacy screen beside it — the
 * clauses are the platform's configured copy, so a user is told the same terms
 * whichever client they read them in.
 */
export default function TermsScreen() {
  return (
    <DocumentScreen
      icon="scale"
      legalDocument="terms"
      page="terms"
      webPath="terms"
      title="Terms & Regulations"
    />
  );
}

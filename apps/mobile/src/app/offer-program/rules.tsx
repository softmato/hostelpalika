import { DocumentScreen } from "@/components/document-screen";

/**
 * The Resident Offer Program rules — the platform's configured copy, shared with
 * `/resident-offer-program` on the website. Public, because the moments a
 * resident most wants to read them (a payment confirmation email, a parent
 * paying the rent) are moments they are not signed in. The programme's front
 * door is `offer-program/index.tsx`; this is its "How it works".
 */
export default function OfferProgramRulesScreen() {
  return (
    <DocumentScreen
      icon="sparkles"
      page="offerProgram"
      title="How it works"
      webPath="resident-offer-program"
    />
  );
}

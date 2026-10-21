/**
 * Builds the printed hostel agreement — `marketing/agreement/hostel-register-agreement.pdf` —
 * from the same terms and letterhead as the agreement owners sign in the app
 * (`hostel-agreement-terms.ts`, `hostel-agreement-document.ts`), so the paper
 * and the digital copy can never say different things.
 *
 *   npm run build:paper-agreement
 *
 * Re-run after changing the terms. Replaces the old HTML → Chrome pipeline in
 * `marketing/agreement/source/`.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";

import { renderPaperAgreement } from "@/modules/hostels/hostel-agreement-document";
import { agreementTerms, type AgreementParties } from "@/modules/hostels/hostel-agreement-terms";

// The company as the letterhead prints it; the field team fills in the owner by hand.
const company = {
  address: "Mid-Baneshwor, Kathmandu",
  email: "work@softmato.com",
  legalName: "Softmato Technology Private Limited",
  pan: "623692242",
  phone: "9819748466",
  supportPhone: "9819748466",
};
const parties: AgreementParties = {
  company,
  hostel: { address: "", name: "" },
  owner: { email: "", name: "", phone: "" },
};

const bytes = await renderPaperAgreement({
  companySigners: "Jiwan Mijhar (Founder) & Siddhant Yadav (Founder)",
  issuer: { ...company, productName: "HostelPalika", vatRegistered: false },
  parties,
  terms: agreementTerms(parties, "paper"),
});
const out = path.resolve(import.meta.dirname, "../../../marketing/agreement/hostel-register-agreement.pdf");

writeFileSync(out, bytes);
console.log(`Wrote ${out} (${bytes.length} bytes)`);

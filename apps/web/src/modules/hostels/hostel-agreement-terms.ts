/**
 * The HostelPalika service agreement an owner signs on the last KYC step.
 *
 * Written in plain words on purpose: most owners read English as a second
 * language, and an agreement they cannot follow protects nobody. Short
 * sentences, everyday words, one promise per point. It says what each side
 * gets, what each side promises, how the data is kept safe and how an owner
 * leaves with everything they put in.
 *
 * The facts follow the paper agreement (`marketing/agreement/source/agreement.html`)
 * — the same fees, notice days and limits — so the two never disagree.
 *
 * Plain ASCII only: the PDF is set in a standard font (WinAnsi), and the text
 * is hashed, so a curly quote would be both a missing glyph and a different
 * fingerprint on two machines.
 *
 * Changing a point changes only agreements signed after the change: every
 * signature keeps a copy of the text it was given (`HostelAgreementSignature`).
 */

export type AgreementParties = {
  company: {
    address: string;
    email: string;
    legalName: string;
    pan: string;
    phone: string;
    supportPhone: string;
  };
  hostel: { address: string; name: string };
  owner: { email: string; name: string; phone: string };
};

export type AgreementSection = { heading: string; points: string[] };

export const AGREEMENT_TITLE = "HostelPalika Service Agreement";

export function agreementIntro(parties: AgreementParties) {
  return (
    `This agreement is between ${parties.company.legalName}, the company that runs HostelPalika ` +
    `("HostelPalika", "we", "us"), and ` +
    (parties.owner.name ? `${parties.owner.name}, the owner of ${parties.hostel.name}` : "the owner of the hostel named above") +
    ` ("you", "your hostel"). It says what each of us gives, what each of us ` +
    "promises, and how your data is kept safe. We wrote it in simple words so it is easy to read."
  );
}

/** `paper`: the printed copy, signed by hand (`scripts/build-paper-agreement.mts`). */
export function agreementTerms(parties: AgreementParties, how: "electronic" | "paper" = "electronic"): AgreementSection[] {
  const { company } = parties;
  const support = [company.supportPhone || company.phone, company.email].filter(Boolean).join(" or ");

  return [
    {
      heading: "1. What you get from HostelPalika",
      points: [
        "A hostel portal on the website and on the mobile app for rooms, residents, rent, receipts, food, attendance, notices, complaints and repairs.",
        "A public page for your hostel on hostelpalika.com, with the Verified badge after our team checks your KYC.",
        "Logins for your wardens and cooks, as your plan allows.",
        "Every update and new feature we add to your plan, at no extra cost.",
        "Help from our support team whenever you need it.",
      ],
    },
    {
      heading: "2. What HostelPalika gets",
      points: [
        "The fee for the plan you choose.",
        "A share of online booking fees, as shown on hostelpalika.com on the day of the booking (now 40% for us and 60% for you).",
        "True information about your hostel, so residents can trust what they see.",
      ],
    },
    {
      heading: "3. Your plan and payments",
      points: [
        "Your plan starts on the day your hostel goes live and is counted in Bikram Sambat months.",
        "Each plan period is paid before it starts. An invoice is due by the end of the 3rd day after we send it.",
        "Pay only to HostelPalika: through the link in your invoice email, or our official QR or bank account. You get an official receipt for every payment. We are not responsible for money given to anyone without our receipt.",
        "If a plan stays unpaid, we remind you first. After a written notice, your portal pauses 3 days later, except the billing page. Paying in full opens it again at once. Nothing is deleted while it is paused.",
        "A new price never changes a period you have already paid for.",
        "Plan fees are not returned once a period has started. A payment made twice or charged by mistake is returned in full.",
      ],
    },
    {
      heading: "4. Your residents' money",
      points: [
        "Rent, deposits and fees that your residents pay go straight to your own eSewa, Khalti, bank or QR. HostelPalika never holds this money.",
        "For online bookings, the guest pays the booking fee to us, and we send your share to the payout account you gave us.",
        "You set your own fees and rules, and you keep your own accounts and pay your own taxes.",
      ],
    },
    {
      heading: "5. Your data belongs to you",
      points: [
        "Everything your hostel puts into HostelPalika - residents, rooms, payments, receipts, documents and photos - belongs to your hostel.",
        "We use your data only to run HostelPalika for you. We never sell it, and we never show it to another hostel.",
        "We share it only with the services we need to run the platform (like hosting, email and payments), or when the law asks us to.",
        "You collect your residents' and guardians' details, ID documents and photos with their consent, as the Individual Privacy Act, 2075 asks.",
      ],
    },
    {
      heading: "6. How we keep your data safe",
      points: [
        "ID cards and documents are kept in private storage. Only your hostel's logins and our verification team can open them.",
        "Data always travels encrypted (HTTPS), and private details like admission forms are also encrypted when stored.",
        "Every login has its own role: a warden or a cook sees only what that role allows.",
        "You can lock the app with your PIN and your fingerprint.",
        "We keep backup copies of your data, so it can be brought back if something goes wrong.",
        "If we find a security problem that affects your data, we tell you as soon as we know, and within 72 hours.",
      ],
    },
    {
      heading: "7. Help and support",
      points: [
        `You can reach us at ${support || "the contacts on hostelpalika.com"}.`,
        "We run HostelPalika with care, fix faults as fast as we can, and tell you before a big change.",
        "No main feature of your plan is taken away during a period you have already paid for.",
        "We are not responsible when internet, power, mobile networks, app stores or payment services fail.",
      ],
    },
    {
      heading: "8. What you promise",
      points: [
        "You have every registration and licence the law asks for to run your hostel.",
        "Your listing is true: real photos, real prices and real free beds.",
        "You do not refuse anyone because of their caste, religion or ethnicity.",
        "You keep your logins private. Whatever is done from your hostel's logins, including your wardens' and cooks', is your responsibility.",
        "You do not use HostelPalika for anything illegal, or for spam.",
      ],
    },
    {
      heading: "9. If you want to leave HostelPalika",
      points: [
        `You can leave at any time. Just stop renewing your plan, or write to us at ${company.email || "our email"}.`,
        "Ask us before you leave, or within 30 days after, and we hand over a full copy of your hostel's data: residents, rooms, payments, receipts, invoices, food menus, notices and every file you uploaded.",
        "You get it free of charge, in files you can open anywhere (Excel or CSV, PDF, and the original files).",
        "After the handover we delete your data, except the records the law asks us to keep, like tax and payment records.",
        "Any amount already due must still be paid.",
        "If we end this agreement when it is not your fault, we return the unused full months of a plan you paid for in advance.",
      ],
    },
    {
      heading: "10. If we have to end this agreement",
      points: [
        "We may pause or end this agreement, after a written notice, for an unpaid plan, false information, illegal use or a serious break of this agreement.",
        "Even then, you can still ask for your data as in point 9.",
      ],
    },
    {
      heading: "11. Limits",
      points: [
        "We are not part of any disagreement between your hostel and its residents, guardians, staff or service providers.",
        "We are not responsible for loss caused by wrong information that your hostel enters.",
        "The most we can owe you is the plan fees you paid in the 12 months before a claim.",
      ],
    },
    {
      heading: "12. Changes to this agreement",
      points: [
        "If we change this agreement, we email you at least 15 days before the change.",
        "If you do not agree with a change, you can leave and take your data as in point 9.",
      ],
    },
    {
      heading: "13. Other terms",
      points: [
        "Each of us keeps the other's private business information secret.",
        "The HostelPalika Terms and Privacy Policy on hostelpalika.com also apply. Where they differ, this agreement wins.",
        "An email sent to the address in this agreement counts as a written notice.",
        "This agreement follows the laws of Nepal. We will first try to solve any disagreement by talking. If that does not work, the courts of Kathmandu decide.",
      ],
    },
    {
      heading: "14. Signing",
      points: [
        "You confirm that you are over 18, that you own or run this hostel, that the details you gave us are true, and that you read and understood this agreement and sign it by your own choice.",
        how === "paper"
          ? "Both of us sign below, and each keeps a copy."
          : "You sign by drawing your signature and typing your name in the HostelPalika app or website. HostelPalika signs by approving your KYC. We both agree this is as good as signing on paper.",
      ],
    },
  ];
}

export type ReceiptVerification =
  | { found: false }
  | {
      amount: number;
      certificationCode: string;
      found: true;
      hostelName: string;
      issuedAt: string;
      period: string | null;
      receiptNumber: string;
      /** First name and last initial — enough to match a printout, no more. */
      residentName: string;
      voidedAt: string | null;
    };

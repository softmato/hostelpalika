import { z } from "zod";

/**
 * A new branch is two answers, like a quick sign-up: its name and the short
 * label the owner tells it apart by. The branch's own KYC carries the rest.
 */
export const branchRequestSchema = z.object({
  name: z.string().trim().min(2).max(160),
  branchLabel: z.string().trim().min(1).max(40),
});

export type BranchRequestInput = z.infer<typeof branchRequestSchema>;

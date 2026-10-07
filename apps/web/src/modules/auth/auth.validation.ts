import { z } from "zod";

import { objectIdSchema } from "@/lib/validators";
import { temporaryCredentialUsernameSchema } from "@/modules/auth/temporary-credential.validation";

/**
 * `identifier` is an email address **or** a temporary-access username issued
 * from Settings. The two namespaces are told apart by `@`, which an email
 * always has and a temporary username never may — so this accepts either shape
 * and `login()` routes on that one character.
 */
export const loginSchema = z.object({
  identifier: z
    .string()
    .trim()
    .refine(
      (value) =>
        value.includes("@")
          ? z.string().email().safeParse(value).success
          : temporaryCredentialUsernameSchema.safeParse(value).success,
      "Enter a valid email address or temporary access username.",
    ),
  password: z.string().min(1, "Password is required."),
});

export type LoginInput = z.infer<typeof loginSchema>;

export const otpChannelSchema = z.enum(["email"]);

export const otpPurposeSchema = z.enum(["registration"]);

export const otpRequestSchema = z
  .object({
    channel: otpChannelSchema,
    identifier: z.string().trim().email("Expected a valid email address."),
    purpose: otpPurposeSchema.default("registration"),
  })
  .superRefine((input, context) => {
    const result = z.string().email().safeParse(input.identifier);

    if (!result.success) {
      context.addIssue({
        code: "custom",
        message: "Expected a valid email address.",
        path: ["identifier"],
      });
    }
  });

export const otpVerifySchema = z.object({
  challengeId: objectIdSchema,
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Expected a 6-digit OTP code."),
});

export const registerSchema = z
  .object({
    email: z.string().trim().email(),
    name: z.string().trim().min(2, "Name is required.").max(120),
    otpChallengeId: objectIdSchema,
    password: z.string().min(8, "Password must be at least 8 characters."),
  })
  .refine((input) => Boolean(input.email), {
    message: "Email is required.",
    path: ["email"],
  });

export const googleAuthSchema = z.object({
  idToken: z.string().trim().min(20, "Google ID token is required."),
});

export type GoogleAuthInput = z.infer<typeof googleAuthSchema>;
export type OtpRequestInput = z.infer<typeof otpRequestSchema>;
export type OtpVerifyInput = z.infer<typeof otpVerifySchema>;

/** The app-lock PIN: four digits, like the bank apps. */
const lockPinSchema = z.string().regex(/^\d{4}$/, "Enter 4 digits.");

/** What changing or removing an existing PIN accepts as "it is me" — see `lock-pin.service.ts`. */
export const lockPinProofSchema = z.object({
  challengeId: objectIdSchema.optional(),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Expected a 6-digit code.")
    .optional(),
  currentPin: lockPinSchema.optional(),
  password: z.string().min(1).max(200).optional(),
});

export type LockPinProof = z.infer<typeof lockPinProofSchema>;

export const setLockPinSchema = lockPinProofSchema.extend({ pin: lockPinSchema });

export const verifyLockPinSchema = z.object({ pin: lockPinSchema });
export type RegisterInput = z.infer<typeof registerSchema>;

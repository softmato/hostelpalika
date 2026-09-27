import { z } from "zod";

import { payoutAccountInputSchema } from "@/modules/bookings/payout-account.validation";
import { shortStaysInputSchema } from "@/modules/bookings/short-stay";
import { foodRoutineSaveSchema } from "@/modules/food/food.validation";
import { platformHostelCreateSchema } from "@/modules/hostels/hostel.validation";

/**
 * The one shape a hostel registration has, whichever desk it arrives at.
 *
 * Two forms post it: the public one an owner fills in themselves, and the team
 * one a field agent fills in sitting with that owner. They ask for the same
 * facts because they *are* the same facts — a hostel does not have a different
 * number of beds depending on who typed it in — and a single schema is what
 * stops the two drifting into asking for different things and storing different
 * subsets.
 *
 * ## What this fixes on the way past
 *
 * The public form has always collected an alternate phone, a landmark, a map
 * link, a year established and a total capacity, and posted all five. The old
 * schema declared none of them, so zod stripped them silently and they reached
 * the database as nothing at all. They are declared here, and the model now has
 * somewhere to put them.
 *
 * ## Why the plan is optional
 *
 * The two desks choose a plan at different moments, and both are deliberate:
 *
 * - **Public** — no plan at submission. The owner picks one later, from the
 *   progress page, and may do so before verification finishes so that paying is
 *   a single click the moment it does.
 * - **Team** — the plan is a step *inside* the form, because the agent is with
 *   the owner and about to take money for it.
 *
 * So `plan` is absent on one path and present on the other, which is an
 * optional field rather than two schemas. The registration service, not the
 * schema, decides what a missing plan means for each source.
 */

/** Discounted cycles, matching the plans catalogue's own three. */
export const billingCycleSchema = z.enum(["monthly", "halfYearly", "annual"]);

export const registrationPlanChoiceSchema = z.object({
  cycle: billingCycleSchema.default("monthly"),
  /** Catalogue id. Validated against the live catalogue in the service. */
  planId: z.string().trim().min(1).max(40),
});

/**
 * Who is applying.
 *
 * `email` stays optional because a team agent may be registering a hostel whose
 * owner does not use email — the agent's own contact details reach us anyway,
 * through the account that filed it. Everything the old schema demanded is
 * still demanded.
 */
const applicantSchema = z.object({
  /** Kept as text: it is a stated age, not a computed one, and may be blank. */
  age: z.string().trim().max(3).optional(),
  email: z.string().trim().email().optional(),
  gender: z.enum(["Male", "Female", "Other"]).optional(),
  /** Which government ID was uploaded, so the reviewer knows what to expect. */
  idProofType: z.string().trim().max(80).optional(),
  name: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(7).max(24),
});

/**
 * The registration *fields*, unrefined.
 *
 * Kept as a plain object because `.superRefine` returns a `ZodEffects`, and a
 * `ZodEffects` cannot be `.extend`ed — the team schema below adds two keys to
 * this and needs it to still be an object. The cross-field checks are attached
 * to each exported schema instead, so both desks get them and neither desk owns
 * them.
 */
const registrationFields = platformHostelCreateSchema
  .omit({ ownerId: true })
  .extend({
    /** A second number to try. Collected by both forms, stored on the hostel. */
    alternatePhone: z.string().trim().min(7).max(24).optional(),
    applicant: applicantSchema,
    /** How many cooks the kitchen runs. Informs the plan's seat caps. */
    cookCount: z.coerce.number().int().min(0).max(100).optional(),
    /** "Opposite the campus gate" — how directions are actually given here. */
    landmark: z.string().trim().max(240).optional(),
    /**
     * A maps link, stored as pasted. Not parsed into coordinates: a shortened
     * `maps.app.goo.gl` cannot be resolved without a network call, and what the
     * owner actually handed us is the honest thing to keep.
     */
    mapLink: z.string().trim().max(500).optional(),
    /** The business's PAN/VAT number. Nepal issues nine digits. */
    panNumber: z
      .string()
      .trim()
      .regex(/^\d{9}$/, "A PAN/VAT number is 9 digits.")
      .optional(),
    plan: registrationPlanChoiceSchema.optional(),
    /**
     * "Do you offer short stays?" Each daily rate is checked against its room's
     * floor on the server before the hostel is created (`registrationShortStays`).
     */
    shortStays: shortStaysInputSchema.optional(),
    /*
     * The weekly food routine, seeded at registration.
     *
     * It is the same payload the hostel's own kitchen screen posts — the schema
     * is imported rather than restated, minus `hostelId`, which on this path is
     * the hostel being created and cannot be named by the client. A hostel that
     * publishes with its meal timings already on it is the difference between a
     * listing a resident can read and one that says "ask the hostel".
     *
     * Optional because only the team form sends it today: an agent is sitting
     * with the owner and can ask what time dinner is, and an owner filling in
     * the public form at midnight cannot be asked to plan a week before they are
     * even verified.
     */
    foodRoutine: foodRoutineSaveSchema.omit({ hostelId: true }).optional(),
    /**
     * Where booking payouts go (docs/BOOKINGS.md). Optional: bookings stay off
     * until it is verified, and it can be added later from Payment Setup.
     */
    payoutAccount: payoutAccountInputSchema.optional(),
    /**
     * The discount a referred resident gets off the admission fee, and the
     * refundable deposit taken at joining.
     *
     * Neither belongs on the hostel document: they belong to the **rate card**,
     * which is the only thing that prices a resident
     * (`finance/fee-schedule.service.ts`). They are collected at registration
     * because the alternative is a hostel that publishes, takes its first
     * resident and raises a joining invoice with no deposit line on it — and the
     * deposit is half of what that resident hands over on day one, since
     * `raiseAdmissionInvoice` puts the admission fee and the deposit on one
     * invoice.
     *
     * Whole rupees, matching `feeScheduleCreateSchema`: the rate card refuses a
     * fraction at three separate gates, so accepting one here would only move
     * the refusal further from the person who typed it.
     */
    referralAdmissionDiscount: z.coerce.number().int().min(0).max(1_000_000).optional(),
    securityDeposit: z.coerce.number().int().min(0).max(1_000_000).optional(),
    /** Beds across the whole building, as stated. */
    totalCapacity: z.coerce.number().int().min(0).max(10_000).optional(),
    yearEstablished: z
      .string()
      .trim()
      .regex(/^\d{4}$/, "Year established should be four digits.")
      .optional(),
  });

/**
 * The cross-field checks both desks get: the rate card's arithmetic, and that a
 * ROOM photo belongs to a room type that was actually submitted.
 *
 * `resolveHostelPhotos` narrows the per-room strip by matching `photo.roomType`
 * against `roomConfigurations[].roomType` exactly. A photo tagged "Four Sharing"
 * on a hostel that submitted "4 Sharing" is not an error anywhere — it simply
 * never appears again, which is the worst kind of wrong because the agent who
 * uploaded it watched it succeed.
 *
 * Checking it here, once, covers both desks and every future caller of the
 * contract; checking it in the form would only cover the form.
 */
function refineRegistration(
  input: Pick<
    z.infer<typeof registrationFields>,
    "photos" | "pricing" | "referralAdmissionDiscount" | "roomConfigurations"
  >,
  ctx: z.RefinementCtx,
) {
  /*
   * A referral discount larger than the fee it comes off would make the joining
   * invoice negative — money owed *to* somebody for moving in. The rate card
   * already refuses this (`feeScheduleCreateSchema`), but it refuses it when the
   * card is written, which on the team path is after the hostel is published and
   * the plan invoice is raised. Refusing it here keeps the whole registration
   * one atomic answer.
   */
  if ((input.referralAdmissionDiscount ?? 0) > (input.pricing?.admissionFee ?? 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A referral discount cannot be more than the admission fee.",
      path: ["referralAdmissionDiscount"],
    });
  }

  const known = new Set(input.roomConfigurations.map((room) => room.roomType));

  input.photos.forEach((photo, index) => {
    if (photo.kind !== "ROOM") {
      return;
    }

    if (!photo.roomType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A room photo has to say which room type it is of.",
        path: ["photos", index, "roomType"],
      });

      return;
    }

    if (!known.has(photo.roomType)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `"${photo.roomType}" is not one of the room types on this hostel.`,
        path: ["photos", index, "roomType"],
      });
    }
  });
}

export const hostelRegistrationSchema =
  registrationFields.superRefine(refineRegistration);

export type HostelRegistrationInput = z.infer<typeof hostelRegistrationSchema>;
export type RegistrationPlanChoice = z.infer<typeof registrationPlanChoiceSchema>;

/**
 * The team form's post.
 *
 * Same body, plus what the agent collected. The payment is part of the
 * submission rather than a step after it because the money and the paperwork
 * happen in the same conversation — and because an agent who submitted the form
 * and then lost signal before recording the cash would leave a published hostel
 * with no trace of the money that was handed over.
 *
 * A hostel does not publish unpaid: cash has to be more than zero, and online
 * has to be a paid prepayment (checked in `registerTeamHostelApplication`,
 * because only the server can ask Softmato). Part payment is allowed; the rest
 * becomes the due.
 */
export const teamHostelRegistrationSchema = registrationFields
  .extend({
    payment: z.object({
      /** Whole rupees actually taken. Always zero for online — read off the prepayment. */
      amount: z.coerce.number().int().min(0).max(10_000_000),
      /**
       * `CASH` is filed with Softmato as a claim for the amount the agent typed
       * and books when their admin confirms it. `SOFTMATO` records nothing
       * here: the owner pays through Softmato checkout straight after. So an
       * online choice always arrives with a zero amount, checked below before
       * anything is written rather than halfway through the registration.
       */
      method: z.enum(["SOFTMATO", "CASH"]),
      /**
       * The online payment taken on the Plan & payment step, before publishing
       * (`team-prepayment.service.ts`). Its amount is read from that row on the
       * server, never from this payload.
       */
      prepaymentId: z.string().trim().max(64).optional(),
      /** A slip number the agent wrote down. */
      reference: z.string().trim().max(120).optional(),
    })
      .refine((payment) => payment.method === "CASH" || payment.amount === 0, {
        message: "Online payments are made through Softmato checkout, not typed in.",
        path: ["amount"],
      })
      .refine((payment) => payment.method === "SOFTMATO" || payment.amount > 0, {
        message: "Enter the cash collected. A hostel does not publish unpaid.",
        path: ["amount"],
      })
      .refine((payment) => payment.method === "SOFTMATO" || !payment.prepaymentId, {
        message: "An online payment cannot be filed as cash.",
        path: ["prepaymentId"],
      }),
    /** The team form always names a plan — it is a step in the form. */
    plan: registrationPlanChoiceSchema,
    /**
     * The agent has seen that this owner already has a live hostel and says
     * this is a separate building.
     *
     * Only lifts the *same owner* refusal. It cannot lift *same building*: a
     * hostel already listed under this name in this area is refused whatever
     * the agent ticks, because two listings for one building split its
     * residents, reviews and plan across two records.
     */
    confirmSecondHostel: z.boolean().optional(),
  })
  .superRefine(refineRegistration);

export type TeamHostelRegistrationInput = z.infer<typeof teamHostelRegistrationSchema>;

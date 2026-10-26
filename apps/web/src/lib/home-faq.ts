import { PLATFORM_NAME } from "@hostel/shared/brand/brand";

import type { HostelSummary } from "@/app/_components/public-hostel-types";
import { formatNpr } from "@/lib/json-ld";

/**
 * The home page's questions — the two halves of the platform, in the words each
 * side searches with. Students and parents ask what a hostel costs and whether
 * the listings are real; owners ask what the software does and what it costs.
 *
 * Every number is computed from what the page already shows (its hostels, the
 * cities with listings, the cheapest plan), and a question whose answer would
 * need data that is not there is left out rather than answered vaguely. The
 * same entries are printed on the page and in its FAQPage markup.
 */
export function homeFaq(input: {
  /** Directory badges in the plans catalogue, e.g. Gold hostel on Max. */
  badges: Array<{ label: string; plan: string }>;
  cities: Array<{ count: number; name: string }>;
  fromPrice: number;
  hostels: HostelSummary[];
}) {
  const real = input.hostels.filter((hostel) => !hostel.isDemoData && hostel.price > 0);
  const faq: Array<{ answer: string; question: string }> = [
    {
      answer: `Open Hostels on ${PLATFORM_NAME} and filter by city, area, boys, girls or co-living, rent, room type, food and facilities — or start from a city page such as Hostels in Kathmandu, or the hostel map. Compare up to three hostels side by side, then call the hostel or send an inquiry from its page to arrange a visit.`,
      question: "How do I find a hostel in Nepal?",
    },
  ];

  const kathmandu = real.filter((hostel) => /kathmandu/i.test(hostel.city)).map((hostel) => hostel.price);
  if (kathmandu.length) {
    const low = Math.min(...kathmandu);
    const high = Math.max(...kathmandu);
    faq.push({
      answer: `On ${PLATFORM_NAME}, hostels in Kathmandu start from ${formatNpr(low)} a month${
        high > low ? `, and starting rents go up to ${formatNpr(high)}` : ""
      }. Rent depends on the room — shared rooms cost less than single rooms — and on whether meals are included. Each hostel's page shows the rent for every room type.`,
      question: "How much does a hostel cost in Kathmandu per month?",
    });
  }

  const listed = input.cities.filter((city) => city.count > 0);
  if (listed.length) {
    faq.push({
      answer: `Verified hostels are listed in ${listed
        .map((city) => `${city.name} (${city.count})`)
        .join(", ")}. New cities appear as soon as their first hostel is verified.`,
      question: `Which cities have hostels on ${PLATFORM_NAME}?`,
    });
  }

  faq.push(
    {
      answer: `Yes. A hostel goes live only after the ${PLATFORM_NAME} team has checked its registration documents, and a review can only be written by a resident who actually stayed there.`,
      question: `Are the hostels on ${PLATFORM_NAME} verified?`,
    },
    {
      answer: `Searching, comparing and contacting hostels is free. If you book a bed online, the booking fee and when it is refunded are explained on How booking works.`,
      question: `Is ${PLATFORM_NAME} free for students and parents?`,
    },
    ...(input.badges.length
      ? [
          {
            answer: `They are directory badges that come with a hostel's paid plan — ${input.badges
              .map((badge) => `${badge.label} with the ${badge.plan} plan`)
              .join(", ")} — and they place the hostel first in the default listing. A badge is not a rating: compare rent, rooms and residents' reviews before you choose.`,
            question: `What do the ${input.badges.map((badge) => badge.label).join(" and ")} badges mean?`,
          },
        ]
      : []),
    {
      answer: `${PLATFORM_NAME} is also hostel management software. Owners, wardens, cooks, residents and parents each get their own login in one app: rent billed in Bikram Sambat months, eSewa and Khalti payment proof checked against the invoice, food menus, night attendance, notices and complaints. Your hostel also gets a public page, a pin on the map and a place in search.`,
      question: `I run a hostel — what does ${PLATFORM_NAME} do for me?`,
    },
    {
      answer: `Plans start from ${formatNpr(input.fromPrice)} a month, and paying for six months or a year costs less per month. Residents and parents never pay for ${PLATFORM_NAME}; their accounts come with the hostel's plan.`,
      question: "How much does hostel management software cost?",
    },
    {
      answer: `Every account has its own 4-digit app-lock PIN; the app opens with the PIN or a fingerprint, and each web portal asks for the PIN too. Residents' personal profiles are encrypted before they are stored, and everyone sees only what their role allows — a parent sees only their own child.`,
      question: "Is hostel and resident data safe?",
    },
  );

  return faq;
}

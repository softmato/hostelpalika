import { describe, expect, it } from "vitest";

import type { ProviderJob } from "@/lib/provider-api";
import {
  completedJobCount,
  isOpenJob,
  isOverdueJob,
  jobActions,
  jobAddress,
  jobCategoryIcon,
  jobPlace,
  jobTone,
  jobUrgencyLabel,
  openJobCount,
  overdueJobCount,
  sortProviderJobs,
  urgentJobCount,
} from "@/lib/provider-jobs";

function job(overrides: Partial<ProviderJob> = {}): ProviderJob {
  return {
    category: "PLUMBING",
    createdAt: "2026-08-10T10:00:00.000Z",
    description: "",
    hostelArea: "Baneshwor",
    hostelCity: "Kathmandu",
    hostelName: "Sunrise Hostel",
    hostelPhone: "9812345678",
    id: "j-1",
    inMyTrade: true,
    location: "Room 204",
    minimumCharge: 200,
    priority: "MEDIUM",
    scheduledFor: null,
    status: "PENDING",
    title: "Leaking tap",
    voiceNoteAssetId: null,
    ...overrides,
  };
}

describe("sortProviderJobs", () => {
  /*
   * The server returns newest-created first, which is right for an audit list
   * and wrong for somebody standing outside a building deciding what to do.
   */
  it("puts open work above closed work", () => {
    const sorted = sortProviderJobs([
      job({ id: "done", status: "COMPLETED" }),
      job({ id: "open", status: "PENDING" }),
    ]);

    expect(sorted.map((row) => row.id)).toEqual(["open", "done"]);
  });

  it("orders open work by when it is due", () => {
    const sorted = sortProviderJobs([
      job({ id: "friday", scheduledFor: "2026-08-21T04:00:00.000Z", status: "SCHEDULED" }),
      job({ id: "today", scheduledFor: "2026-08-17T04:00:00.000Z", status: "SCHEDULED" }),
    ]);

    expect(sorted.map((row) => row.id)).toEqual(["today", "friday"]);
  });

  /*
   * A date is a commitment; urgency within a day is a tiebreak. So Friday's
   * URGENT job does not jump ahead of today's LOW one.
   */
  it("does not let urgency outrank a nearer commitment", () => {
    const sorted = sortProviderJobs([
      job({
        id: "friday-urgent",
        priority: "URGENT",
        scheduledFor: "2026-08-21T04:00:00.000Z",
        status: "SCHEDULED",
      }),
      job({
        id: "today-low",
        priority: "LOW",
        scheduledFor: "2026-08-17T04:00:00.000Z",
        status: "SCHEDULED",
      }),
    ]);

    expect(sorted[0]?.id).toBe("today-low");
  });

  it("breaks a tie on the same day by urgency", () => {
    const sorted = sortProviderJobs([
      job({ id: "low", priority: "LOW", scheduledFor: "2026-08-17T04:00:00.000Z" }),
      job({ id: "urgent", priority: "URGENT", scheduledFor: "2026-08-17T04:00:00.000Z" }),
    ]);

    expect(sorted.map((row) => row.id)).toEqual(["urgent", "low"]);
  });

  it("falls back to created date when nothing is scheduled", () => {
    const sorted = sortProviderJobs([
      job({ createdAt: "2026-08-15T10:00:00.000Z", id: "newer" }),
      job({ createdAt: "2026-08-02T10:00:00.000Z", id: "older" }),
    ]);

    expect(sorted.map((row) => row.id)).toEqual(["older", "newer"]);
  });

  it("sinks a job with no usable date rather than floating it to the top", () => {
    const sorted = sortProviderJobs([
      job({ createdAt: null, id: "undated", scheduledFor: null }),
      job({ id: "dated" }),
    ]);

    expect(sorted.map((row) => row.id)).toEqual(["dated", "undated"]);
  });

  it("leaves an empty list alone", () => {
    expect(sortProviderJobs([])).toEqual([]);
  });
});

describe("jobActions", () => {
  /*
   * Saying "contacted" twice is not a state change, and a button that no-ops
   * teaches people to distrust the one beside it.
   */
  it("offers Contacted only from PENDING", () => {
    expect(jobActions(job({ status: "PENDING" })).canContact).toBe(true);
    expect(jobActions(job({ status: "CONTACTED" })).canContact).toBe(false);
    expect(jobActions(job({ status: "SCHEDULED" })).canContact).toBe(false);
  });

  it("offers Complete from every open status and none of the closed ones", () => {
    expect(jobActions(job({ status: "PENDING" })).canComplete).toBe(true);
    expect(jobActions(job({ status: "SCHEDULED" })).canComplete).toBe(true);
    expect(jobActions(job({ status: "COMPLETED" })).canComplete).toBe(false);
    expect(jobActions(job({ status: "CANCELLED" })).canComplete).toBe(false);
  });
});

describe("jobAddress", () => {
  it("reads from the most specific part outward", () => {
    expect(jobAddress(job())).toBe("Room 204, Sunrise Hostel, Baneshwor, Kathmandu");
  });

  it("drops the parts the hostel never filled in", () => {
    expect(jobAddress(job({ hostelArea: "", location: "" }))).toBe(
      "Sunrise Hostel, Kathmandu",
    );
  });
});

describe("openJobCount", () => {
  it("counts only work that is still open", () => {
    expect(
      openJobCount([job(), job({ status: "COMPLETED" }), job({ status: "SCHEDULED" })]),
    ).toBe(2);
    expect(isOpenJob(job({ status: "CANCELLED" }))).toBe(false);
  });
});

describe("jobCategoryIcon", () => {
  it("gives every schema category its own icon", () => {
    // The eleven values of `maintenanceCategorySchema`. A category that falls
    // through to the default here means the table has drifted from the server.
    const categories = [
      "APPLIANCE",
      "CARPENTRY",
      "CLEANING",
      "ELECTRICAL",
      "HEALTH",
      "INTERNET",
      "OTHER",
      "PAINTING",
      "PLUMBING",
      "ROOM_REPAIR",
      "WATER",
    ];

    for (const category of categories) {
      expect(jobCategoryIcon(category)).toBeTruthy();
    }

    expect(jobCategoryIcon("PLUMBING")).toBe("water");
    expect(jobCategoryIcon("ELECTRICAL")).toBe("flash");
  });

  it("falls back to a tool rather than nothing for an unknown category", () => {
    expect(jobCategoryIcon("ROOFING")).toBe("construct");
    expect(jobCategoryIcon("")).toBe("construct");
  });
});

describe("urgentJobCount", () => {
  it("counts open high and urgent work only", () => {
    expect(
      urgentJobCount([
        job({ id: "a", priority: "URGENT", status: "PENDING" }),
        job({ id: "b", priority: "HIGH", status: "SCHEDULED" }),
        job({ id: "c", priority: "LOW", status: "PENDING" }),
      ]),
    ).toBe(2);
  });

  it("ignores urgent work that is already done", () => {
    // A completed emergency is a record, not something to look at today.
    expect(
      urgentJobCount([job({ priority: "URGENT", status: "COMPLETED" })]),
    ).toBe(0);
  });
});

describe("completedJobCount", () => {
  it("counts only completed jobs, not cancelled ones", () => {
    expect(
      completedJobCount([
        job({ id: "a", status: "COMPLETED" }),
        job({ id: "b", status: "CANCELLED" }),
        job({ id: "c", status: "PENDING" }),
      ]),
    ).toBe(1);
  });
});

describe("jobTone", () => {
  it("paints an urgent open job red and a high one amber", () => {
    expect(jobTone(job({ priority: "URGENT" }))).toBe("danger");
    expect(jobTone(job({ priority: "HIGH" }))).toBe("warning");
  });

  it("leaves ordinary open work on the brand", () => {
    expect(jobTone(job({ priority: "MEDIUM" }))).toBe("brand");
    expect(jobTone(job({ priority: "LOW" }))).toBe("brand");
  });

  /* A finished emergency is not an emergency. */
  it("greys out closed work whatever its priority was", () => {
    expect(jobTone(job({ priority: "URGENT", status: "COMPLETED" }))).toBe("neutral");
    expect(jobTone(job({ priority: "URGENT", status: "CANCELLED" }))).toBe("neutral");
  });
});

describe("jobUrgencyLabel", () => {
  it("names only the priorities that are a claim", () => {
    expect(jobUrgencyLabel(job({ priority: "URGENT" }))).toBe("Urgent");
    expect(jobUrgencyLabel(job({ priority: "HIGH" }))).toBe("High");
    expect(jobUrgencyLabel(job({ priority: "MEDIUM" }))).toBeNull();
    expect(jobUrgencyLabel(job({ priority: "LOW" }))).toBeNull();
  });

  it("says nothing about a closed job", () => {
    expect(jobUrgencyLabel(job({ priority: "URGENT", status: "COMPLETED" }))).toBeNull();
  });
});

describe("jobPlace", () => {
  it("is the spot and the building, without the area and the city", () => {
    expect(jobPlace(job())).toBe("Room 204 · Sunrise Hostel");
  });

  it("drops an empty location rather than leading with a separator", () => {
    expect(jobPlace(job({ location: "" }))).toBe("Sunrise Hostel");
  });
});

describe("isOverdueJob", () => {
  const now = new Date("2026-08-17T10:00:00.000Z");

  /*
   * The hostel wrote a date, not a deadline to the minute — so a job scheduled
   * for today is not overdue at any hour of today.
   */
  it("does not call today's job overdue", () => {
    expect(
      isOverdueJob(job({ scheduledFor: "2026-08-17T04:00:00.000Z", status: "SCHEDULED" }), now),
    ).toBe(false);
  });

  it("calls a job scheduled before today overdue", () => {
    expect(
      isOverdueJob(job({ scheduledFor: "2026-08-14T04:00:00.000Z", status: "SCHEDULED" }), now),
    ).toBe(true);
  });

  it("never calls closed or unscheduled work overdue", () => {
    expect(
      isOverdueJob(
        job({ scheduledFor: "2026-08-14T04:00:00.000Z", status: "COMPLETED" }),
        now,
      ),
    ).toBe(false);
    expect(isOverdueJob(job({ scheduledFor: null }), now)).toBe(false);
  });

  it("counts the overdue ones", () => {
    expect(
      overdueJobCount(
        [
          job({ id: "late", scheduledFor: "2026-08-14T04:00:00.000Z", status: "SCHEDULED" }),
          job({ id: "soon", scheduledFor: "2026-08-19T04:00:00.000Z", status: "SCHEDULED" }),
        ],
        now,
      ),
    ).toBe(1);
  });
});

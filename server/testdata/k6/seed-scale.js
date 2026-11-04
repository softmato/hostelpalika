// Grows one real hostel on a throwaway clone so load tests see a hostel bigger
// than any in production today: residents ×16, 24 months of rent each (paid,
// with its settled event, balance and receipt), 60 days of attendance, and 300
// notifications for its owner. Run with mongosh against the clone ONLY:
//
//   docker exec -i hostelpalika-mongo-1 mongosh --quiet hp_p10_load < testdata/k6/seed-scale.js
//
// Refuses any database not named hp_p10_*.
if (!/^hp_p10_/.test(db.getName())) throw new Error("seed-scale runs on hp_p10_* clones only");

const HOSTEL = ObjectId("6ac08f8877e6621dc6267baa");
const OWNER = db.hostels.findOne({ _id: HOSTEL }).ownerId;
const FACTOR = 16, MONTHS = 24, DAYS = 60;
const base = db.residents.find({ hostelId: HOSTEL, status: "ACTIVE", isDeleted: false }).toArray();
const now = new Date();
let n = 0;
const residents = [];
for (let k = 1; k < FACTOR; k++) {
  for (const r of base) {
    const c = Object.assign({}, r, { _id: new ObjectId(), userId: null, phone: "98" + String(10000000 + n++).padStart(8, "0"), email: null });
    residents.push(c);
  }
}
db.residents.insertMany(residents, { ordered: false });
const all = residents.concat(base);
print("residents", all.length);

function periodOf(i) { // BS months back from 2083-07
  let y = 2083, m = 7 - i;
  while (m < 1) { m += 12; y -= 1; }
  return y + "-" + String(m).padStart(2, "0");
}
let inv = [], ev = [], bal = [], rc = [], seq = 0;
const flush = () => {
  if (inv.length) db.invoices.insertMany(inv, { ordered: false });
  if (ev.length) db.paymentevents.insertMany(ev, { ordered: false });
  if (bal.length) db.invoicebalances.insertMany(bal, { ordered: false });
  if (rc.length) db.receipts.insertMany(rc, { ordered: false });
  inv = []; ev = []; bal = []; rc = [];
};
for (const r of residents) {
  for (let i = 1; i <= MONTHS; i++) {
    const at = new Date(now.getTime() - i * 30 * 864e5);
    const amount = r.monthlyFee || 9000;
    const iid = new ObjectId(), eid = new ObjectId();
    inv.push({ _id: iid, hostelId: HOSTEL, residentId: r._id, period: periodOf(i), kind: "MONTHLY_RENT",
      lines: [{ description: "Monthly rent", bedType: r.bedType || null, amount, basis: "OVERRIDE", feeScheduleId: null }],
      totalAmount: amount, currency: "NPR", dueDate: at, status: "PAID", referenceCode: "LEE-S" + seq,
      legacyPaymentId: null, dunning: { lastNotifiedAt: null, chaseCount: 0, stage: "NONE" }, fineWaived: false,
      issuedAt: at, createdAt: at, updatedAt: at, __v: 0 });
    ev.push({ _id: eid, hostelId: HOSTEL, invoiceId: iid, residentId: r._id, referenceCode: "LEE-S" + seq, amount, currency: "NPR",
      direction: "CREDIT", source: "CASH", provider: "CASH", providerTxnId: null, statementImportId: null, confirmation: "STAFF",
      status: "SETTLED", idempotencyKey: "seed:" + eid, occurredAt: at, observedAt: at, settledAt: at,
      reversedByEventId: null, reversesEventId: null, reviewFlags: [], createdAt: at, updatedAt: at, __v: 0 });
    bal.push({ _id: new ObjectId(), invoiceId: iid, hostelId: HOSTEL, residentId: r._id, settledAmount: amount, lastEventId: eid, lastComputedAt: at, version: 1, createdAt: at, updatedAt: at, __v: 0 });
    rc.push({ _id: new ObjectId(), hostelId: HOSTEL, residentId: r._id, eventId: eid, invoiceId: iid, paymentId: null, month: null,
      receiptNumber: "RCP-SEED-" + seq, issuedAt: at, issuedBy: OWNER, amount, voidedAt: null, voidedBy: null, voidReason: null,
      replacedByReceiptId: null, createdAt: at, __v: 0 });
    seq++;
  }
  if (inv.length >= 2000) flush();
}
flush();
print("invoices", db.invoices.countDocuments({ hostelId: HOSTEL }));

let logs = [];
for (const r of all) {
  for (let d = 0; d < DAYS; d++) {
    const at = new Date(now.getTime() - d * 864e5);
    logs.push({ _id: new ObjectId(), hostelId: HOSTEL, residentId: r._id, day: new Date(at.toISOString().slice(0, 10)), status: "PRESENT",
      firstSeenAt: at, lastSeenAt: at, createdAt: at, updatedAt: at, __v: 0 });
  }
  if (logs.length >= 5000) { db.attendancelogs.insertMany(logs, { ordered: false }); logs = []; }
}
if (logs.length) db.attendancelogs.insertMany(logs, { ordered: false });
print("attendancelogs", db.attendancelogs.countDocuments({ hostelId: HOSTEL }));

const notes = [];
for (let i = 0; i < 300; i++) {
  const at = new Date(now.getTime() - i * 3600e3);
  notes.push({ _id: new ObjectId(), userId: OWNER, hostelId: HOSTEL, kind: "SYSTEM", title: "Seed " + i, body: "Load test row",
    readAt: i < 20 ? null : at, createdAt: at, updatedAt: at, __v: 0 });
}
db.notifications.insertMany(notes);
print("done");

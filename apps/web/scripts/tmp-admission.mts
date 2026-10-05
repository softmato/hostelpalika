import nextEnv from "@next/env";
nextEnv.loadEnvConfig("D:/hostel-management-software");
const W = "../src";
const { connectToDatabase } = await import(`${W}/lib/db.ts`);
const intake = await import(`${W}/modules/residents/resident-intake.service.ts`);
const { ResidentModel } = await import("@hostel/db/models/Resident");
const mongoose = (await import("mongoose")).default;
await connectToDatabase();
const r: any = await ResidentModel.findById("6ac3c3260133353b25b52b78").lean();
const quote = await intake.getIntakeQuote(r.hostelId, { moveInDate: r.moveInDate, roomType: r.roomType });
console.log("quote", JSON.stringify(quote));
if (process.argv.includes("--write")) {
  const result = await intake.raiseAdmissionInvoice({
    dueDate: r.moveInDate, hostelId: r.hostelId, principal: { userId: r.createdBy.toString() } as any, quote, residentId: r._id,
  });
  console.log("result", JSON.stringify(result));
}
await mongoose.disconnect();

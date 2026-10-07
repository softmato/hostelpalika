import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const html = readFileSync("public/receipt-sheet.html", "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
type Message = { id: number; action: string; path?: string; method?: string; body?: Record<string, unknown>; enabled?: boolean };
type Read = { fields: Record<string, unknown>; text?: boolean; refusal?: string | null; notPayment?: boolean; systemDocument?: boolean; bank?: { key: string; name: string } | null };
function sheet(options: { auto?: boolean; eligible?: boolean; readFails?: boolean; upload?: Promise<string>; saveFails?: boolean; alreadySaved?: { amount: number; by: string; where?: string | null }; role?: string; category?: string | null; read?: Read; invoices?: { id: string; month: string; dueAmount: number }[] } = {}) {
  type Element = { value: string; textContent: string; innerHTML: string; className: string; placeholder: string; required: boolean; hidden: boolean; disabled: boolean; checked: boolean; options: { length: number }; add(option: { value: string }): void; onclick?: () => void; onchange?: () => void; onsubmit?: (event: { preventDefault(): void }) => void; checkValidity(): boolean; reportValidity(): boolean };
  const elements = new Map<string, Element>();
  const valid = (id: string) => id === "rform"
    ? Number(elements.get("ramount")!.value) > 0 && (!elements.get("rtxn")!.required || Boolean(elements.get("rtxn")!.value.trim()))
    : Number(elements.get("amount")!.value) > 0 && Boolean(elements.get("what")!.value.trim());
  // Whatever the markup hides at load starts hidden here too.
  for (const [, tag, id] of html.matchAll(/<([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    elements.set(id, { value: id === "category" ? "OTHER" : id === "method" ? "BANK" : "", textContent: "", innerHTML: "", className: "", placeholder: "", required: false, hidden: /\shidden\b/.test(tag), disabled: false, checked: false,
      options: { length: 0 }, add(option) { this.options.length += 1; if (!this.value) this.value = option.value; },
      checkValidity: () => valid(id), reportValidity: () => valid(id) });
  }
  const messages: Message[] = [];
  const window = { ReceiptBridge: { postMessage(raw: string) {
    const message = JSON.parse(raw) as Message; messages.push(message);
    void Promise.resolve().then(async () => {
      try {
        let value: unknown = null;
        if (message.action === "init") value = { fileName: "bank.pdf", requestId: "receipt-same-file" };
        if (message.action === "preference") value = options.auto ?? false;
        if (message.action === "hostel") value = "hostel1";
        if (message.action === "upload") value = await (options.upload ?? Promise.resolve("asset1"));
        if (message.path === "/auth/me") value = { user: { id: "user1", role: options.role ?? "HOSTEL_ADMIN", hostelIds: ["hostel1"] } };
        if (message.path === "/hostel-admin/expenses/receipt/read") {
          if (options.readFails) throw new Error("Reader unavailable");
          value = { fields: { amount: 300, method: "ESEWA" }, description: "Groceries", category: options.category ?? null, autoSaveEligible: options.eligible ?? true, alreadySaved: options.alreadySaved ?? null };
        }
        if (message.path === "/resident/finance/invoices") value = { invoices: options.invoices ?? [{ id: "a".repeat(24), month: "2083-05", dueAmount: 1200 }, { id: "b".repeat(24), month: "2083-06", dueAmount: 5661 }] };
        if (message.path?.startsWith("/resident/finance/evidence/")) value = options.read ?? { fields: { amount: 5661, method: "ESEWA", transactionCode: "1SPLIYU" }, text: true, refusal: null };
        if (message.path?.endsWith("/claims")) value = { created: true, eventId: "e1", status: "PENDING" };
        if (message.path === "/hostel-admin/expenses" && options.saveFails) throw new Error("Connection dropped");
        window.receiptReply({ id: message.id, value });
      } catch (error) { window.receiptReply({ id: message.id, error: (error as Error).message }); }
    });
  } }, receiptReply: (reply: { id: number; value?: unknown; error?: string }) => { void reply; } };
  class Option { constructor(public text: string, public value: string) {} }
  runInNewContext(script, { window, document: { getElementById: (id: string) => elements.get(id), documentElement: { classList: { add() {} } }, querySelector: () => ({ scrollHeight: 400 }) }, ResizeObserver: class { observe() {} }, Option, URLSearchParams, URL, location: { search: "", origin: "https://receipt.invalid" }, setTimeout: () => 0, console });
  const el = (id: string) => elements.get(id)!;
  return { messages, el, save: () => el("form").onsubmit!({ preventDefault() {} }), send: () => el("rform").onsubmit!({ preventDefault() {} }), options };
}
const saves = (s: ReturnType<typeof sheet>) => s.messages.filter(m => m.path === "/hostel-admin/expenses");
describe("bundled receipt sheet", () => {
  it("fills first and waits for Save, even with a confident read", async () => {
    const s = sheet(); await vi.waitFor(() => expect(s.el("amount").value).toBe(300));
    expect(saves(s)).toHaveLength(0);
    s.save(); s.save();
    await vi.waitFor(() => expect(s.el("done").hidden).toBe(false));
    expect(saves(s)).toHaveLength(1);
    expect(saves(s)[0].body).toMatchObject({ amount: 300, paidBy: "ESEWA", photoAssetId: "asset1", sharedReceipt: true, clientRequestId: "receipt-same-file" });
  });
  it("auto-saves only when opted in and the server says the receipt is clear", async () => {
    const s = sheet({ auto: true }); await vi.waitFor(() => expect(saves(s)).toHaveLength(1));
    const uncertain = sheet({ auto: true, eligible: false });
    await vi.waitFor(() => expect(uncertain.el("amount").value).toBe(300));
    expect(saves(uncertain)).toHaveLength(0);
  });
  it("shows an already-added receipt and never offers Save, even with auto-save on", async () => {
    const s = sheet({ auto: true, alreadySaved: { amount: 2400, by: "Hari", where: "Sunrise Main" } });
    await vi.waitFor(() => expect(s.el("done").hidden).toBe(false));
    expect(s.el("doneTitle").textContent).toBe("Already added");
    expect(s.el("doneText").textContent).toContain("Hari in Sunrise Main");
    expect(s.el("save").hidden).toBe(true);
    expect(saves(s)).toHaveLength(0);
  });
  it("fills the category and bank read off the receipt and marks them Auto", async () => {
    const s = sheet({ category: "GROCERIES" }); await vi.waitFor(() => expect(s.el("amount").value).toBe(300));
    expect(s.el("category").value).toBe("GROCERIES");
    expect(s.el("categoryAuto").hidden).toBe(false);
    expect(s.el("methodAuto").hidden).toBe(false);
    const plain = sheet(); await vi.waitFor(() => expect(plain.el("amount").value).toBe(300));
    expect(plain.el("category").value).toBe("OTHER");
    expect(plain.el("categoryAuto").hidden).toBe(true);
  });
  it("keeps a resident's receipt in the sheet: proof upload, read, matched month, claim", async () => {
    const s = sheet({ role: "RESIDENT" });
    await vi.waitFor(() => expect(s.el("send").hidden).toBe(false));
    expect(s.messages.some(m => m.action === "upload" && (m as { kind?: string }).kind === "PAYMENT_PROOF")).toBe(true);
    expect(s.messages.some(m => m.path?.endsWith("/read?format=json"))).toBe(true);
    // The amount names the month: Rs 5,661 is Aswin's balance, not the older Rs 1,200.
    expect(s.el("rinvoice").value).toBe("b".repeat(24));
    expect(s.el("ramount").value).toBe(5661);
    expect(s.el("rmethodAuto").hidden).toBe(false);
    // Residents never get the auto-save switch, and never leave for the app.
    expect(s.el("form").hidden).toBe(true);
    expect(s.messages.some(m => m.action === "preference" || m.action === "handoff")).toBe(false);
    s.send(); s.send();
    await vi.waitFor(() => expect(s.el("doneTitle").textContent).toBe("Sent to your hostel"));
    const claims = s.messages.filter(m => m.path?.endsWith("/claims"));
    expect(claims).toHaveLength(1);
    expect(claims[0].path).toBe(`/resident/finance/invoices/${"b".repeat(24)}/claims`);
    expect(claims[0].body).toMatchObject({ amount: 5661, paymentMethod: "ESEWA", proofImageAssetId: "asset1", transactionCode: "1SPLIYU" });
  });
  it("stops a receipt the claim would be refused for, without a Send button", async () => {
    const s = sheet({ role: "RESIDENT", read: { fields: { amount: 3799 }, text: true, refusal: "That receipt shows the money went to BILL NEPAL SERVICES." } });
    await vi.waitFor(() => expect(s.el("done").hidden).toBe(false));
    expect(s.el("doneTitle").textContent).toBe("Can’t use this receipt");
    expect(s.el("doneText").textContent).toContain("BILL NEPAL SERVICES");
    expect(s.el("send").hidden).toBe(true);
    expect(s.messages.some(m => m.path?.endsWith("/claims"))).toBe(false);
    expect(s.messages.some(m => m.action === "notice")).toBe(true);
  });
  it("asks how a resident paid when the receipt does not say", async () => {
    const s = sheet({ role: "RESIDENT", read: { fields: { amount: 5661 }, text: true } });
    await vi.waitFor(() => expect(s.el("send").hidden).toBe(false));
    expect(s.el("rmethodAuto").hidden).toBe(true);
    s.send();
    expect(s.el("error").textContent).toBe("Choose how you paid.");
    expect(s.el("menu").hidden).toBe(false);
    expect(s.messages.some(m => m.path?.endsWith("/claims"))).toBe(false);
  });
  it("Cancel during upload prevents the later read and save", async () => {
    let finish!: (value: string) => void;
    const s = sheet({ auto: true, upload: new Promise(resolve => { finish = resolve; }) });
    await vi.waitFor(() => expect(s.messages.some(m => m.action === "upload")).toBe(true));
    s.el("cancel").onclick!(); finish("asset1");
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(saves(s)).toHaveLength(0);
    expect(s.messages.some(m => m.path?.endsWith("/receipt/read"))).toBe(false);
  });
  it("retries a failed read without uploading the file twice", async () => {
    const options = { readFails: true }; const s = sheet(options);
    await vi.waitFor(() => expect(s.el("error").textContent).toBe("Reader unavailable"));
    options.readFails = false; s.el("retry").onclick!();
    await vi.waitFor(() => expect(s.el("amount").value).toBe(300));
    expect(s.messages.filter(m => m.action === "upload")).toHaveLength(1);
  });
  it("reuses the same idempotency key after a lost save response", async () => {
    const options = { saveFails: true }; const s = sheet(options);
    await vi.waitFor(() => expect(s.el("amount").value).toBe(300)); s.save();
    await vi.waitFor(() => expect(s.el("error").textContent).toBe("Connection dropped"));
    options.saveFails = false; s.save();
    await vi.waitFor(() => expect(saves(s)).toHaveLength(2));
    expect(saves(s)[0].body?.clientRequestId).toBe(saves(s)[1].body?.clientRequestId);
  });
});

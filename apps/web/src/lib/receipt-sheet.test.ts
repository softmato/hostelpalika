import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const html = readFileSync("public/receipt-sheet.html", "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
type Message = { id: number; action: string; path?: string; method?: string; body?: Record<string, unknown>; enabled?: boolean };
function sheet(options: { auto?: boolean; eligible?: boolean; readFails?: boolean; upload?: Promise<string>; saveFails?: boolean; alreadySaved?: { amount: number; by: string; where?: string | null }; role?: string } = {}) {
  const elements = new Map<string, { value: string; textContent: string; hidden: boolean; disabled: boolean; checked: boolean; onclick?: () => void; onsubmit?: (event: { preventDefault(): void }) => void; checkValidity(): boolean; reportValidity(): boolean }>();
  for (const id of [...html.matchAll(/id="([^"]+)"/g)].map(match => match[1])) {
    elements.set(id, { value: id === "category" ? "OTHER" : "", textContent: "", hidden: ["error", "form", "done", "picker", "pick", "login", "retry"].includes(id), disabled: false, checked: false,
      checkValidity: () => Number(elements.get("amount")!.value) > 0 && Boolean(elements.get("what")!.value.trim()),
      reportValidity: () => Number(elements.get("amount")!.value) > 0 && Boolean(elements.get("what")!.value.trim()) });
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
          value = { fields: { amount: 300, method: "ESEWA" }, description: "Groceries", autoSaveEligible: options.eligible ?? true, alreadySaved: options.alreadySaved ?? null };
        }
        if (message.path === "/hostel-admin/expenses" && options.saveFails) throw new Error("Connection dropped");
        window.receiptReply({ id: message.id, value });
      } catch (error) { window.receiptReply({ id: message.id, error: (error as Error).message }); }
    });
  } }, receiptReply: (reply: { id: number; value?: unknown; error?: string }) => { void reply; } };
  runInNewContext(script, { window, document: { getElementById: (id: string) => elements.get(id), documentElement: { classList: { add() {} } }, querySelector: () => ({ scrollHeight: 400 }) }, ResizeObserver: class { observe() {} }, URLSearchParams, URL, location: { search: "", origin: "https://receipt.invalid" }, setTimeout: () => 0, console });
  const el = (id: string) => elements.get(id)!;
  return { messages, el, save: () => el("form").onsubmit!({ preventDefault() {} }), options };
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
  it("hands a resident's receipt to the app before uploading anything", async () => {
    const s = sheet({ role: "RESIDENT" });
    await vi.waitFor(() => expect(s.messages.some(m => m.action === "handoff")).toBe(true));
    expect(s.messages.some(m => m.action === "upload")).toBe(false);
    expect(s.el("error").hidden).toBe(true);
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

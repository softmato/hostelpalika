import { crc32 } from "node:zlib";

/**
 * A ZIP written as it streams, files stored as they are (no compression).
 *
 * For handing back a hostel's uploaded files (docs/HOSTEL_LEAVE_PLATFORM.md):
 * photos and PDFs are already compressed, so deflating them again buys nothing
 * and costs CPU the request does not have. Each entry's size and CRC are not
 * known until its bytes have passed, so every entry carries a data descriptor
 * (flag bit 3) after its data instead of the sizes up front.
 *
 * ponytail: ZIP32 — under 4 GB and 65,535 entries per archive. Callers split
 * into parts well below that; add ZIP64 records if a part ever has to be bigger.
 */

export type ZipEntry = {
  /** Path inside the archive; `/` separates folders. */
  name: string;
  date: Date;
  data: AsyncIterable<Uint8Array>;
};

const UTF8_AND_DESCRIPTOR = 0x0808;

function dosTime(date: Date) {
  return ((date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)) & 0xffff;
}

function dosDate(date: Date) {
  return (((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
}

function header(size: number, write: (view: DataView, bytes: Uint8Array) => void) {
  const bytes = new Uint8Array(size);
  write(new DataView(bytes.buffer), bytes);
  return bytes;
}

/** Streams `entries` as one ZIP archive. Each entry's bytes are read once. */
export async function* zipStream(entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>): AsyncGenerator<Uint8Array> {
  const central: Uint8Array[] = [];
  let offset = 0;
  let count = 0;

  for await (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const time = dosTime(entry.date);
    const date = dosDate(entry.date);
    const localOffset = offset;

    const local = header(30 + name.length, (view, bytes) => {
      view.setUint32(0, 0x04034b50, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, UTF8_AND_DESCRIPTOR, true);
      view.setUint16(8, 0, true);
      view.setUint16(10, time, true);
      view.setUint16(12, date, true);
      // CRC and sizes are 0 here; the data descriptor carries them.
      view.setUint16(26, name.length, true);
      bytes.set(name, 30);
    });
    yield local;
    offset += local.length;

    let crc = 0;
    let size = 0;

    for await (const chunk of entry.data) {
      crc = crc32(chunk, crc);
      size += chunk.length;
      yield chunk;
    }

    offset += size;

    const descriptor = header(16, (view) => {
      view.setUint32(0, 0x08074b50, true);
      view.setUint32(4, crc >>> 0, true);
      view.setUint32(8, size, true);
      view.setUint32(12, size, true);
    });
    yield descriptor;
    offset += descriptor.length;

    central.push(
      header(46 + name.length, (view, bytes) => {
        view.setUint32(0, 0x02014b50, true);
        view.setUint16(4, 20, true);
        view.setUint16(6, 20, true);
        view.setUint16(8, UTF8_AND_DESCRIPTOR, true);
        view.setUint16(10, 0, true);
        view.setUint16(12, time, true);
        view.setUint16(14, date, true);
        view.setUint32(16, crc >>> 0, true);
        view.setUint32(20, size, true);
        view.setUint32(24, size, true);
        view.setUint16(28, name.length, true);
        view.setUint32(42, localOffset, true);
        bytes.set(name, 46);
      }),
    );
    count += 1;
  }

  const centralSize = central.reduce((sum, row) => sum + row.length, 0);

  for (const row of central) yield row;

  yield header(22, (view) => {
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(8, count, true);
    view.setUint16(10, count, true);
    view.setUint32(12, centralSize, true);
    view.setUint32(16, offset, true);
  });
}

/** An async generator as a web `ReadableStream`, for a route `Response`. */
export function toReadableStream(source: AsyncGenerator<Uint8Array>) {
  return new ReadableStream<Uint8Array>({
    async cancel() {
      await source.return(undefined);
    },
    async pull(controller) {
      const next = await source.next();

      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
  });
}

/** A name safe on Windows, macOS and Linux alike, kept readable. **Pure.** */
export function safeEntryName(value: string) {
  const cleaned = value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/\s+/g, " ").trim();

  return cleaned.slice(0, 120) || "file";
}

/**
 * Minute bitmap for one UTC day.
 *
 * 1440 minutes, one bit each, packed into 180 bytes. Bit N is minute N of the
 * UTC day, stored least significant bit first within its byte: minute 0 is
 * 0x01 of byte 0, minute 7 is 0x80 of byte 0, minute 8 is 0x01 of byte 1.
 *
 * Setting an already set bit is a no-op, which is what makes crediting
 * idempotent: the same minute credited twice changes nothing.
 */

export const MINUTES_PER_DAY = 1440;
export const BITMAP_BYTES = MINUTES_PER_DAY / 8; // 180

export function emptyBitmap(): Buffer {
    return Buffer.alloc(BITMAP_BYTES);
}

function assertMinute(minute: number): void {
    if (!Number.isInteger(minute) || minute < 0 || minute >= MINUTES_PER_DAY) {
        throw new RangeError(`Minute ${minute} is outside the UTC day.`);
    }
}

export function isMinuteSet(bitmap: Buffer, minute: number): boolean {
    assertMinute(minute);
    return (bitmap[minute >> 3] & (1 << (minute & 7))) !== 0;
}

/** Mutates in place. Returns true when the bit changed from unset to set. */
export function setMinute(bitmap: Buffer, minute: number): boolean {
    assertMinute(minute);
    const index = minute >> 3;
    const mask = 1 << (minute & 7);
    if ((bitmap[index] & mask) !== 0) return false;
    bitmap[index] |= mask;
    return true;
}

export function clearMinute(bitmap: Buffer, minute: number): boolean {
    assertMinute(minute);
    const index = minute >> 3;
    const mask = 1 << (minute & 7);
    if ((bitmap[index] & mask) === 0) return false;
    bitmap[index] &= ~mask;
    return true;
}

const POPCOUNT_TABLE = (() => {
    const table = new Uint8Array(256);
    for (let value = 0; value < 256; value += 1) {
        table[value] = (value & 1) + table[value >> 1];
    }
    return table;
})();

export function popcount(bitmap: Buffer): number {
    let total = 0;
    for (let index = 0; index < bitmap.length; index += 1) {
        total += POPCOUNT_TABLE[bitmap[index]];
    }
    return total;
}

/**
 * Count set minutes in [fromMinute, toMinute), clamped to the day.
 * Used for cross day window summation: the caller slices each day's window and
 * adds the results, so a window spanning midnight is two calls, not special
 * cased arithmetic.
 */
export function countRange(bitmap: Buffer, fromMinute: number, toMinute: number): number {
    const start = Math.max(0, Math.min(MINUTES_PER_DAY, Math.floor(fromMinute)));
    const end = Math.max(0, Math.min(MINUTES_PER_DAY, Math.ceil(toMinute)));
    if (end <= start) return 0;

    let total = 0;
    let minute = start;

    // Leading partial byte.
    while (minute < end && (minute & 7) !== 0) {
        if (isMinuteSet(bitmap, minute)) total += 1;
        minute += 1;
    }
    // Whole bytes.
    while (minute + 8 <= end) {
        total += POPCOUNT_TABLE[bitmap[minute >> 3]];
        minute += 8;
    }
    // Trailing partial byte.
    while (minute < end) {
        if (isMinuteSet(bitmap, minute)) total += 1;
        minute += 1;
    }
    return total;
}

/** Every set minute, as minute-of-day indices. For exports and diagnostics. */
export function setMinutes(bitmap: Buffer): number[] {
    const minutes: number[] = [];
    for (let index = 0; index < bitmap.length; index += 1) {
        const byte = bitmap[index];
        if (byte === 0) continue;
        for (let bit = 0; bit < 8; bit += 1) {
            if ((byte & (1 << bit)) !== 0) minutes.push(index * 8 + bit);
        }
    }
    return minutes;
}

/** Set minutes per UTC hour, length 24. Feeds the coverage heatmap. */
export function hourHistogram(bitmap: Buffer): number[] {
    const hours = new Array<number>(24).fill(0);
    for (let hour = 0; hour < 24; hour += 1) {
        hours[hour] = countRange(bitmap, hour * 60, (hour + 1) * 60);
    }
    return hours;
}

export function normaliseBitmap(input: Buffer | Uint8Array | null | undefined): Buffer {
    if (!input) return emptyBitmap();
    const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
    if (buffer.length === BITMAP_BYTES) return buffer;
    const padded = emptyBitmap();
    buffer.copy(padded, 0, 0, Math.min(buffer.length, BITMAP_BYTES));
    return padded;
}

/** Minute of the UTC day for an instant. */
export function minuteOfUtcDay(instant: Date): number {
    return instant.getUTCHours() * 60 + instant.getUTCMinutes();
}

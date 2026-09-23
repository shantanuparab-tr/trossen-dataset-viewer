/**
 * Readable names for recordings whose filename is a UUID.
 *
 * The recorder names episodes with a UUIDv7 (RFC 9562), whose first 48 bits are
 * the Unix time in milliseconds at which it was created. A list of those is
 * unreadable as written, but the timestamp inside them is exactly what someone
 * scanning a session wants, so it is decoded and shown instead, with a short
 * prefix of the id kept to tell two recordings of the same second apart.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-([1-8])[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The millisecond timestamp inside a UUIDv7, or null for any other string. */
export function uuidV7Time(name: string): Date | null {
  const match = UUID_RE.exec(name);
  if (!match || match[1] !== "7") return null;
  const hex = name.slice(0, 8) + name.slice(9, 13);
  const ms = Number.parseInt(hex, 16);
  // 2^48 ms runs to the year 10889, so anything outside a sane range is a
  // filename that merely looks like a v7 uuid.
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms);
}

/** True when the name is a UUID of any version. */
export function isUuid(name: string): boolean {
  return UUID_RE.test(name);
}

export interface EpisodeName {
  /** What to show: the recording time for a v7 uuid, else the name as written. */
  label: string;
  /** Short id, shown next to the time so same-second recordings stay distinct. */
  detail: string | null;
  /** Recording time, for sorting; null when the name does not carry one. */
  time: Date | null;
}

/**
 * Split a recording's filename into what to show and what to show beside it.
 *
 * @param name Filename without its extension.
 */
export function episodeName(name: string): EpisodeName {
  const time = uuidV7Time(name);
  if (time) {
    return {
      label: time.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
      detail: name.slice(0, 8),
      time,
    };
  }
  // A uuid of another version carries no time, so the id is all there is.
  if (isUuid(name))
    return { label: name.slice(0, 8), detail: null, time: null };
  return { label: name, detail: null, time: null };
}

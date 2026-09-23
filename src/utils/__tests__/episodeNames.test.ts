import { describe, expect, it } from "bun:test";

import { episodeName, isUuid, uuidV7Time } from "../episodeNames";

describe("uuidV7Time", () => {
  it("decodes the millisecond timestamp of a v7 uuid", () => {
    // 0x018f5a1b2c3d = 1716500000829 ms.
    const time = uuidV7Time("018f5a1b-2c3d-7abc-8def-0123456789ab");
    expect(time?.getTime()).toBe(0x018f5a1b2c3d);
  });

  it("returns null for other uuid versions", () => {
    expect(uuidV7Time("f47ac10b-58cc-4372-a567-0e02b2c3d479")).toBeNull();
  });

  it("returns null for the legacy episode_NNNNNN names", () => {
    expect(uuidV7Time("episode_000056")).toBeNull();
  });
});

describe("episodeName", () => {
  it("shows the recording time and a short id for a v7 uuid", () => {
    const name = episodeName("018f5a1b-2c3d-7abc-8def-0123456789ab");
    expect(name.detail).toBe("018f5a1b");
    expect(name.time).not.toBeNull();
    expect(name.label).not.toContain("018f5a1b");
  });

  it("leaves a non-uuid name as written", () => {
    expect(episodeName("episode_000056")).toEqual({
      label: "episode_000056",
      detail: null,
      time: null,
    });
  });

  it("shortens a uuid that carries no time", () => {
    expect(episodeName("f47ac10b-58cc-4372-a567-0e02b2c3d479").label).toBe(
      "f47ac10b",
    );
  });
});

describe("isUuid", () => {
  it("accepts a canonical uuid and rejects anything else", () => {
    expect(isUuid("018f5a1b-2c3d-7abc-8def-0123456789ab")).toBe(true);
    expect(isUuid("episode_000056")).toBe(false);
  });
});

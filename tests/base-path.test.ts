import {
  normalizeBasePath,
  resolveBasePath,
  webBaseFor,
} from "../src/backend/base-path.ts";

describe("normalizeBasePath", () => {
  test.each<[string, string]>([
    ["", ""],
    ["/", ""],
    ["//", ""],
    ["mousehole", "/mousehole"],
    ["mousehole/", "/mousehole"],
    ["/mousehole", "/mousehole"],
    ["/mousehole/", "/mousehole"],
    ["/apps/mousehole", "/apps/mousehole"],
    ["  /mousehole/  ", "/mousehole"],
  ])("normalises %j to %j", (value, expected) => {
    expect(normalizeBasePath(value)).toBe(expected);
  });

  test.each([
    // would read as an authority, i.e. an off-site URL
    "//evil.example",
    "/a//b",
    // dot segments
    "/a/../b",
    "/a/./b",
    "/..",
    "/.",
    // whitespace, query, fragment, backslash, control characters
    "/a b",
    "/a\tb",
    "/a?b",
    "/a#b",
    String.raw`/a\b`,
    "/a\u0000b",
    // scheme-ish and characters a mount point never needs
    "https://evil.example",
    "http://evil.example/path",
    "a;b",
  ])("rejects %j", (value) => {
    expect(normalizeBasePath(value)).toBeUndefined();
  });
});

describe("resolveBasePath", () => {
  test("is the origin root when neither source is set", () => {
    expect(resolveBasePath("")).toBe("");
  });

  test("takes a validated X-Forwarded-Prefix when no prefix is configured", () => {
    expect(resolveBasePath("", "/mousehole")).toBe("/mousehole");
    expect(resolveBasePath("", "mousehole/")).toBe("/mousehole");
  });

  // A client can send the header itself, so a bad value must not fail the
  // request — it just means "at the root".
  test.each(["//evil.example", "/a/../b", "a;b", "https://evil.example"])(
    "discards the hostile header %j",
    (forwarded) => {
      expect(resolveBasePath("", forwarded)).toBe("");
    },
  );

  test("the configured prefix wins over any header", () => {
    expect(resolveBasePath("/mousehole", "/other")).toBe("/mousehole");
  });
});

describe("webBaseFor", () => {
  test("is the root base when no prefix is configured", () => {
    expect(webBaseFor("")).toBe("/web/");
  });

  test("nests under the prefix", () => {
    expect(webBaseFor("/mousehole")).toBe("/mousehole/web/");
    expect(webBaseFor("/apps/mousehole")).toBe("/apps/mousehole/web/");
  });
});

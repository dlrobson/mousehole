import { healthcheckUrl } from "../src/backend/healthcheck.ts";

describe("healthcheckUrl", () => {
  test("probes the origin root by default", () => {
    expect(healthcheckUrl({}).href).toBe("http://localhost:5010/health");
  });

  test("probes under a configured base path", () => {
    expect(healthcheckUrl({ MOUSEHOLE_BASE_PATH: "/mousehole" }).href).toBe(
      "http://localhost:5010/mousehole/health",
    );
  });

  test("normalizes the base path exactly as the server does", () => {
    expect(healthcheckUrl({ MOUSEHOLE_BASE_PATH: " /mousehole/ " }).href).toBe(
      "http://localhost:5010/mousehole/health",
    );
  });
});

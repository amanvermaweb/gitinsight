import { afterEach, describe, expect, it } from "vitest";
import { getClientIpAddress } from "@/lib/rate-limit";

const originalVercel = process.env.VERCEL;
const originalTrustProxy = process.env.TRUST_PROXY_IP_HEADERS;

afterEach(() => {
  process.env.VERCEL = originalVercel;
  process.env.TRUST_PROXY_IP_HEADERS = originalTrustProxy;
});

describe("client IP extraction", () => {
  it("does not trust x-forwarded-for by default", () => {
    delete process.env.VERCEL;
    delete process.env.TRUST_PROXY_IP_HEADERS;

    const headers = new Headers({
      "x-forwarded-for": "203.0.113.2",
      "x-real-ip": "198.51.100.8",
    });

    expect(getClientIpAddress(headers)).toBe("198.51.100.8");
  });

  it("trusts Vercel forwarded header when running on Vercel", () => {
    process.env.VERCEL = "1";

    const headers = new Headers({
      "x-vercel-forwarded-for": "203.0.113.9",
      "x-forwarded-for": "198.51.100.10",
    });

    expect(getClientIpAddress(headers)).toBe("203.0.113.9");
  });
});

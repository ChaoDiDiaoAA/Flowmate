import { describe, expect, it } from "vitest";
import { redactSensitiveDetails } from "../src/redaction.js";

describe("redactSensitiveDetails", () => {
  it("redacts header, bearer, and JSON credential values", () => {
    const message = [
      "Cookie: session=secret-cookie; other=value",
      "Token=secret-token",
      "Authorization: Bearer secret-bearer",
      '"api_key":"secret-api-key"',
    ].join("\n");

    const redacted = redactSensitiveDetails(message);

    expect(redacted).not.toMatch(/secret-cookie|secret-token|secret-bearer|secret-api-key/i);
    expect(redacted).toContain("[REDACTED]");
  });
});

import { describe, expect, it } from "vitest";

import { redactSecrets } from "../../src/security/redact.js";

describe("redactSecrets", () => {
  it("recursively redacts secret-valued keys without mutating benign fields", () => {
    const input = {
      title: "safe digest",
      tokenCount: 42,
      githubToken: "github-secret-value",
      authorizationHeader: "Bearer authorization-secret-value",
      cookieHeader: "session=cookie-secret-value",
      setCookieHeader: "session=set-cookie-secret-value",
      sessionId: "session-secret-value",
      contextToken: "context-secret-value",
      nested: [
        {
          api_key: "api-secret-value",
          status: "degraded",
          detail: {
            password: "password-secret-value",
            retries: 2,
          },
        },
      ],
    };

    const result = redactSecrets(input);

    expect(result).toEqual({
      title: "safe digest",
      tokenCount: 42,
      githubToken: "[REDACTED]",
      authorizationHeader: "[REDACTED]",
      cookieHeader: "[REDACTED]",
      setCookieHeader: "[REDACTED]",
      sessionId: "[REDACTED]",
      contextToken: "[REDACTED]",
      nested: [
        {
          api_key: "[REDACTED]",
          status: "degraded",
          detail: {
            password: "[REDACTED]",
            retries: 2,
          },
        },
      ],
    });
    expect(input.githubToken).toBe("github-secret-value");
  });

  it("removes token-like values embedded inside strings and keeps surrounding text", () => {
    const githubToken = `ghp_${"a".repeat(36)}`;
    const bearerToken = `eyJ${"b".repeat(24)}.${"c".repeat(24)}.${"d".repeat(24)}`;
    const apiKey = `sk-${"e".repeat(32)}`;
    const input = {
      source: "github",
      note: "No authentication was configured; public collection continued.",
      errors: [
        `request failed: Authorization: Bearer ${bearerToken}`,
        `upstream returned token=${githubToken} and api_key=${apiKey}`,
      ],
    };

    const result = redactSecrets(input);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(githubToken);
    expect(serialized).not.toContain(bearerToken);
    expect(serialized).not.toContain(apiKey);
    expect(serialized).toContain("[REDACTED]");
    expect(result).toMatchObject({
      source: "github",
      note: "No authentication was configured; public collection continued.",
    });
  });

  it("redacts Basic auth, cookie headers, and context-token assignments in strings", () => {
    const input = {
      tokenCount: 7,
      messages: [
        "request failed: Authorization: Basic dXNlcjpwYXNzd29yZA==",
        "request headers: Cookie: session=cookie-secret; theme=dark",
        "response headers: Set-Cookie: auth=set-cookie-secret; HttpOnly; Secure",
        "env WECHAT_CONTEXT_TOKEN=wechat-context-secret",
        "query context_token=context-query-secret",
      ],
    };

    const result = redactSecrets(input);

    expect(result).toEqual({
      tokenCount: 7,
      messages: [
        "request failed: Authorization: Basic [REDACTED]",
        "request headers: Cookie: [REDACTED]",
        "response headers: Set-Cookie: [REDACTED]",
        "env WECHAT_CONTEXT_TOKEN=[REDACTED]",
        "query context_token=[REDACTED]",
      ],
    });
  });

  it("serializes and redacts Error diagnostics including cause and custom fields", () => {
    const bearerToken = "opaque-" + "a".repeat(32);
    const error = Object.assign(
      new Error("request failed: Authorization: Bearer " + bearerToken, {
        cause: {
          contextToken: "cause-context-secret",
          retryable: false,
        },
      }),
      {
        authorizationHeader: "Custom custom-authorization-secret",
        detail: "context_token=detail-context-secret",
        statusCode: 401,
      },
    );

    const result = redactSecrets(error);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(bearerToken);
    expect(serialized).not.toContain("cause-context-secret");
    expect(serialized).not.toContain("custom-authorization-secret");
    expect(serialized).not.toContain("detail-context-secret");
    expect(result).toEqual({
      name: "Error",
      message: "request failed: Authorization: Bearer [REDACTED]",
      cause: {
        contextToken: "[REDACTED]",
        retryable: false,
      },
      authorizationHeader: "[REDACTED]",
      detail: "context_token=[REDACTED]",
      statusCode: 401,
    });
  });

  it("serializes and redacts Headers diagnostics", () => {
    const headers = new Headers({
      Authorization: "Custom header-authorization-secret",
      Cookie: "session=header-cookie-secret",
      "X-Request-Id": "request-123",
    });

    expect(redactSecrets(headers)).toEqual({
      authorization: "[REDACTED]",
      cookie: "[REDACTED]",
      "x-request-id": "request-123",
    });
  });

  it("serializes URL diagnostics without userinfo credentials", () => {
    const url = new URL(
      "https://diagnostic-user:diagnostic-password@example.com/private?token=query-secret&view=full",
    );

    expect(redactSecrets(url)).toBe(
      "https://[REDACTED]@example.com/private?token=[REDACTED]&view=full",
    );
  });

  it("serializes unsupported non-plain diagnostics instead of returning secrets", () => {
    class DiagnosticEnvelope {
      readonly status = "failed";
      readonly authorizationHeader = "Custom object-authorization-secret";
      readonly contextToken = "object-context-secret";
      readonly tokenCount = 9;
    }

    const result = redactSecrets(new DiagnosticEnvelope());

    expect(result).toEqual({
      status: "failed",
      authorizationHeader: "[REDACTED]",
      contextToken: "[REDACTED]",
      tokenCount: 9,
    });
    expect(result).not.toBeInstanceOf(DiagnosticEnvelope);
  });

  it("redacts GitHub fine-grained personal access tokens embedded in text", () => {
    const token = "github_pat_" + "g".repeat(82);

    expect(redactSecrets("GitHub rejected " + token)).toBe(
      "GitHub rejected [REDACTED]",
    );
  });

  it("redacts URL userinfo credentials embedded in text", () => {
    expect(
      redactSecrets(
        "download https://diagnostic-user:diagnostic-password@example.com/private?view=full",
      ),
    ).toBe("download https://[REDACTED]@example.com/private?view=full");
  });

  it("redacts token-only URL userinfo embedded in text", () => {
    expect(
      redactSecrets("download https://tokenonly@example.com/private"),
    ).toBe("download https://[REDACTED]@example.com/private");
  });

  it("serializes URL diagnostics without token-only userinfo", () => {
    expect(
      redactSecrets(new URL("https://tokenonly@example.com/private")),
    ).toBe("https://[REDACTED]@example.com/private");
  });

  it("redacts decoded secret query names on URL objects and preserves benign params", () => {
    const redacted = redactSecrets(
      new URL(
        "https://example.com/path?session=url-session-secret&client_secret=url-client-secret&access%5Ftoken=url-access-secret&view=full",
      ),
    );

    expect(typeof redacted).toBe("string");
    const parsed = new URL(redacted as string);
    expect(parsed.searchParams.get("session")).toBe("[REDACTED]");
    expect(parsed.searchParams.get("client_secret")).toBe("[REDACTED]");
    expect(parsed.searchParams.get("access_token")).toBe("[REDACTED]");
    expect(parsed.searchParams.get("view")).toBe("full");
  });

  it("redacts decoded secret query names in prose-embedded URLs", () => {
    const redacted = redactSecrets(
      "open https://example.com/path?session=prose-session-secret&client_secret=prose-client-secret&access%5Ftoken=prose-access-secret&view=full for details",
    );

    expect(redacted).not.toContain("prose-session-secret");
    expect(redacted).not.toContain("prose-client-secret");
    expect(redacted).not.toContain("prose-access-secret");
    expect(redacted).toContain("view=full");
  });

  it("redacts JSON-style token and secret values embedded in text", () => {
    expect(
      redactSecrets(
        'payload {"token":"json-token-secret","secret": "json-secret-value","tokenCount":4}',
      ),
    ).toBe(
      'payload {"token":"[REDACTED]","secret": "[REDACTED]","tokenCount":4}',
    );
  });

  it("redacts Proxy-Authorization Headers", () => {
    const headers = new Headers({
      "Proxy-Authorization": "Custom proxy-secret",
      "X-Request-Id": "request-456",
    });

    expect(redactSecrets(headers)).toEqual({
      "proxy-authorization": "[REDACTED]",
      "x-request-id": "request-456",
    });
  });

  it("redacts pre-serialized JSON authorization values", () => {
    expect(
      redactSecrets(
        'payload {"authorization":"Custom json-secret","authorizationPolicy":"public"}',
      ),
    ).toBe(
      'payload {"authorization":"[REDACTED]","authorizationPolicy":"public"}',
    );
  });

  it("redacts credentials for arbitrary Authorization schemes", () => {
    expect(
      redactSecrets(
        'request failed: Authorization: Digest username="alice", response="digest-secret"',
      ),
    ).toBe("request failed: Authorization: Digest [REDACTED]");
  });

  it("preserves benign authorization prose and tokenCount values", () => {
    const input = {
      tokenCount: 4,
      message: "The authorization policy is public and the token count is four.",
      url: "https://example.com/docs",
    };

    expect(redactSecrets(input)).toEqual(input);
  });

  it.each([
    ["Buffer", Buffer.from("buffer-secret-bytes")],
    [
      "ArrayBuffer",
      new TextEncoder().encode("array-buffer-secret-bytes").buffer,
    ],
    ["Uint8Array", new TextEncoder().encode("typed-array-secret-bytes")],
    [
      "DataView",
      new DataView(new TextEncoder().encode("data-view-secret-bytes").buffer),
    ],
  ])("treats %s input as opaque", (_kind, value) => {
    expect(redactSecrets(value)).toBe("[REDACTED]");
  });
});

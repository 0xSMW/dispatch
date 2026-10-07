import { afterEach, describe, expect, it, vi } from "vitest";
import { awsCredentialsProvider } from "@vercel/oidc-aws-credentials-provider";
import { awsCredentials } from "./aws.js";

vi.mock("@vercel/oidc-aws-credentials-provider", () => ({
  awsCredentialsProvider: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("awsCredentials", () => {
  it("keeps the SDK credential chain when no role is configured", () => {
    vi.stubEnv("AWS_ROLE_ARN", undefined);
    expect(awsCredentials()).toBeUndefined();
    expect(awsCredentialsProvider).not.toHaveBeenCalled();
  });

  it("uses the deployment identity provider for a configured role", () => {
    const roleArn = "arn:aws:iam::123456789012:role/synthetic-readiness";
    const provider = vi.fn();
    vi.stubEnv("AWS_ROLE_ARN", roleArn);
    vi.mocked(awsCredentialsProvider).mockReturnValue(provider);
    expect(awsCredentials()).toBe(provider);
    expect(awsCredentialsProvider).toHaveBeenCalledExactlyOnceWith({ roleArn });
  });
});

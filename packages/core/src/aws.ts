import { awsCredentialsProvider } from "@vercel/oidc-aws-credentials-provider";

// Vercel exchanges a short-lived deployment identity for a scoped AWS role.
// Local and AWS-native runtimes continue using the SDK credential chain.
export function awsCredentials():
  | ReturnType<typeof awsCredentialsProvider>
  | undefined {
  return process.env.AWS_ROLE_ARN
    ? awsCredentialsProvider({ roleArn: process.env.AWS_ROLE_ARN })
    : undefined;
}

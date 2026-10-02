import {
  CreateEmailIdentityCommand,
  DeleteEmailIdentityCommand,
  GetEmailIdentityCommand,
  PutEmailIdentityMailFromAttributesCommand,
  SESv2Client
} from "@aws-sdk/client-sesv2";

export type IdentityClient = {
  send(command: unknown): Promise<{
    DkimAttributes?: { Tokens?: string[]; Status?: string };
    MailFromAttributes?: { MailFromDomainStatus?: string };
    VerifiedForSendingStatus?: boolean;
  }>;
};

const clients = new Map<string, SESv2Client>();

export function sesClient(region: string) {
  return clients.get(region) ?? clients.set(region, new SESv2Client({ region })).get(region)!;
}

export async function createIdentity(client: IdentityClient, input: { name: string; mailFromDomain: string; configurationSetName?: string }) {
  const created = await client.send(new CreateEmailIdentityCommand({
    EmailIdentity: input.name,
    ConfigurationSetName: input.configurationSetName ?? "dispatch-default"
  }));
  await client.send(new PutEmailIdentityMailFromAttributesCommand({
    EmailIdentity: input.name,
    MailFromDomain: input.mailFromDomain,
    BehaviorOnMxFailure: "USE_DEFAULT_VALUE"
  }));
  return created.DkimAttributes?.Tokens ?? [];
}

export async function readIdentity(client: IdentityClient, name: string) {
  const identity = await client.send(new GetEmailIdentityCommand({ EmailIdentity: name }));
  return {
    dkimStatus: identity.DkimAttributes?.Status ?? "PENDING",
    mailFromStatus: identity.MailFromAttributes?.MailFromDomainStatus ?? "PENDING",
    verifiedForSending: Boolean(identity.VerifiedForSendingStatus)
  };
}

export async function deleteIdentity(client: IdentityClient, name: string) {
  await client.send(new DeleteEmailIdentityCommand({ EmailIdentity: name }));
}

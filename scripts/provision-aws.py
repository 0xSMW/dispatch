#!/usr/bin/env python3
"""Provision Dispatch's scoped production AWS resources; rerunnable, no credentials output."""
import json
from pathlib import Path
import subprocess
import sys

REGION = 'us-west-2'
ACCOUNT = '481609031345'
DOMAIN = 'smw.ai'
ORIGIN = 'https://dispatch.smw.ai'
BUCKET = f'dispatch-content-{ACCOUNT}-{REGION}'
CONFIGS = ['dispatch-default', 'dispatch-tls-required']
ROOT = Path(__file__).resolve().parents[1]


def aws(service, operation, optional=False, **args):
    command = ['aws', '--profile', 'console', '--region', REGION, service, operation, '--output', 'json', '--no-cli-pager', '--cli-connect-timeout', '10', '--cli-read-timeout', '20']
    for key, value in args.items():
        command.append('--' + key.replace('_', '-'))
        if isinstance(value, list) and all(isinstance(item, str) for item in value):
            command.extend(value)
        elif isinstance(value, (dict, list)):
            command.append(json.dumps(value))
        elif isinstance(value, bool):
            if not value:
                command[-1] = '--no-' + key.replace('_', '-')
        else:
            command.append(str(value))
    print(f'{service} {operation}', file=sys.stderr, flush=True)
    result = subprocess.run(command, capture_output=True, text=True, timeout=180)
    if result.returncode:
        if optional and any(code in result.stderr for code in ['NotFoundException', 'NoSuchEntity', '(404)', 'NonExistentQueue']):
            return None
        raise RuntimeError(f'{service} {operation}: {result.stderr.strip()}')
    return json.loads(result.stdout) if result.stdout.strip() else {}


def main():
    caller = aws('sts', 'get-caller-identity')
    if caller['Account'] != ACCOUNT:
        raise RuntimeError('Unexpected AWS account')
    account = aws('sesv2', 'get-account')
    identity = aws('sesv2', 'get-email-identity', optional=True, email_identity=DOMAIN)
    if identity and identity.get('MailFromAttributes', {}).get('MailFromDomain') not in [None, 'send.' + DOMAIN]:
        raise RuntimeError('Existing SES identity uses another MAIL FROM; stop for review')
    for name in CONFIGS:
        existing = aws('sesv2', 'get-configuration-set', optional=True, configuration_set_name=name)
        if existing is None:
            aws('sesv2', 'create-configuration-set', configuration_set_name=name, delivery_options={'TlsPolicy': 'REQUIRE' if name.endswith('tls-required') else 'OPTIONAL'}, reputation_options={'ReputationMetricsEnabled': True})
    if identity is None:
        aws('sesv2', 'create-email-identity', email_identity=DOMAIN, configuration_set_name=CONFIGS[0])
        aws('sesv2', 'put-email-identity-mail-from-attributes', email_identity=DOMAIN, mail_from_domain='send.' + DOMAIN, behavior_on_mx_failure='USE_DEFAULT_VALUE')
    topic = aws('sns', 'create-topic', name='dispatch-events')['TopicArn']
    config_arns = [f'arn:aws:ses:{REGION}:{ACCOUNT}:configuration-set/{name}' for name in CONFIGS]
    topic_policy = {'Version': '2012-10-17', 'Statement': [{'Sid': 'SesEvents', 'Effect': 'Allow', 'Principal': {'Service': 'ses.amazonaws.com'}, 'Action': 'sns:Publish', 'Resource': topic, 'Condition': {'StringEquals': {'AWS:SourceAccount': ACCOUNT}, 'ArnEquals': {'AWS:SourceArn': config_arns}}}]}
    aws('sns', 'set-topic-attributes', topic_arn=topic, attribute_name='Policy', attribute_value=json.dumps(topic_policy))
    for name in CONFIGS:
        destinations = aws('sesv2', 'get-configuration-set-event-destinations', configuration_set_name=name).get('EventDestinations', [])
        destination = {'Enabled': True, 'MatchingEventTypes': ['SEND', 'REJECT', 'BOUNCE', 'COMPLAINT', 'DELIVERY', 'OPEN', 'CLICK', 'RENDERING_FAILURE', 'DELIVERY_DELAY', 'SUBSCRIPTION'], 'SnsDestination': {'TopicArn': topic}}
        operation = 'update-configuration-set-event-destination' if any(item['Name'] == 'dispatch-events' for item in destinations) else 'create-configuration-set-event-destination'
        aws('sesv2', operation, configuration_set_name=name, event_destination_name='dispatch-events', event_destination=destination)
    queue_url = aws('sqs', 'create-queue', queue_name='dispatch-events-dlq', attributes={'MessageRetentionPeriod': '1209600', 'SqsManagedSseEnabled': 'true'})['QueueUrl']
    queue_arn = aws('sqs', 'get-queue-attributes', queue_url=queue_url, attribute_names=['QueueArn'])['Attributes']['QueueArn']
    queue_policy = {'Version': '2012-10-17', 'Statement': [{'Effect': 'Allow', 'Principal': {'Service': 'sns.amazonaws.com'}, 'Action': 'sqs:SendMessage', 'Resource': queue_arn, 'Condition': {'ArnEquals': {'aws:SourceArn': topic}, 'StringEquals': {'aws:SourceAccount': ACCOUNT}}}]}
    aws('sqs', 'set-queue-attributes', queue_url=queue_url, attributes={'Policy': json.dumps(queue_policy)})
    if aws('s3api', 'head-bucket', optional=True, bucket=BUCKET) is None:
        aws('s3api', 'create-bucket', bucket=BUCKET, create_bucket_configuration={'LocationConstraint': REGION})
    aws('s3api', 'put-public-access-block', bucket=BUCKET, public_access_block_configuration={'BlockPublicAcls': True, 'IgnorePublicAcls': True, 'BlockPublicPolicy': True, 'RestrictPublicBuckets': True})
    aws('s3api', 'put-bucket-encryption', bucket=BUCKET, server_side_encryption_configuration={'Rules': [{'ApplyServerSideEncryptionByDefault': {'SSEAlgorithm': 'AES256'}, 'BucketKeyEnabled': False}]})
    aws('s3api', 'put-bucket-ownership-controls', bucket=BUCKET, ownership_controls={'Rules': [{'ObjectOwnership': 'BucketOwnerEnforced'}]})
    aws('s3api', 'put-bucket-cors', bucket=BUCKET, cors_configuration={'CORSRules': [{'AllowedHeaders': ['*'], 'AllowedMethods': ['PUT', 'GET', 'HEAD'], 'AllowedOrigins': [ORIGIN], 'ExposeHeaders': ['ETag'], 'MaxAgeSeconds': 3600}]})
    issuer = 'https://oidc.vercel.com/ai-marketing'
    provider_arn = f'arn:aws:iam::{ACCOUNT}:oidc-provider/oidc.vercel.com/ai-marketing'
    providers = aws('iam', 'list-open-id-connect-providers')['OpenIDConnectProviderList']
    if not any(item['Arn'] == provider_arn for item in providers):
        aws('iam', 'create-open-id-connect-provider', url=issuer, client_id_list=['https://vercel.com/ai-marketing'])
    trust = {'Version': '2012-10-17', 'Statement': [{'Effect': 'Allow', 'Principal': {'Federated': provider_arn}, 'Action': 'sts:AssumeRoleWithWebIdentity', 'Condition': {'StringEquals': {'oidc.vercel.com/ai-marketing:aud': 'https://vercel.com/ai-marketing', 'oidc.vercel.com/ai-marketing:sub': 'owner:ai-marketing:project:dispatch:environment:production'}}}]}
    if aws('iam', 'get-role', optional=True, role_name='dispatch') is None:
        aws('iam', 'create-role', role_name='dispatch', assume_role_policy_document=trust, description='Dispatch Vercel production runtime')
    else:
        aws('iam', 'update-assume-role-policy', role_name='dispatch', policy_document=trust)
    identity_arn = f'arn:aws:ses:{REGION}:{ACCOUNT}:identity/{DOMAIN}'
    policy = {'Version': '2012-10-17', 'Statement': [
        {'Effect': 'Allow', 'Action': ['ses:SendEmail', 'ses:SendRawEmail'], 'Resource': [identity_arn, *config_arns]},
        {'Effect': 'Allow', 'Action': ['ses:CreateEmailIdentity', 'ses:DeleteEmailIdentity', 'ses:GetEmailIdentity', 'ses:PutEmailIdentityMailFromAttributes'], 'Resource': identity_arn},
        {'Effect': 'Allow', 'Action': 'ses:GetAccount', 'Resource': '*', 'Condition': {'StringEquals': {'aws:RequestedRegion': REGION}}},
        {'Effect': 'Allow', 'Action': ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload'], 'Resource': f'arn:aws:s3:::{BUCKET}/*'},
        {'Effect': 'Allow', 'Action': ['sns:ConfirmSubscription', 'sns:GetTopicAttributes'], 'Resource': topic}
    ]}
    aws('iam', 'put-role-policy', role_name='dispatch', policy_name='dispatch', policy_document=policy)
    subscriptions = aws('sns', 'list-subscriptions-by-topic', topic_arn=topic).get('Subscriptions', [])
    endpoint = ORIGIN + '/api/internal/events'
    subscription = next((item for item in subscriptions if item['Protocol'] == 'https' and item['Endpoint'] == endpoint), None)
    if subscription is None:
        try:
            subscription = aws('sns', 'subscribe', topic_arn=topic, protocol='https', notification_endpoint=endpoint, attributes={'RedrivePolicy': json.dumps({'deadLetterTargetArn': queue_arn})}, return_subscription_arn=True)
        except RuntimeError as error:
            if 'Unreachable Endpoint' not in str(error):
                raise
            subscription = {'status': 'endpoint_unreachable', 'endpoint': endpoint}
    elif subscription['SubscriptionArn'] != 'PendingConfirmation':
        aws('sns', 'set-subscription-attributes', subscription_arn=subscription['SubscriptionArn'], attribute_name='RedrivePolicy', attribute_value=json.dumps({'deadLetterTargetArn': queue_arn}))
    identity = aws('sesv2', 'get-email-identity', email_identity=DOMAIN)
    dns = [{'type': 'CNAME', 'name': token + '._domainkey.' + DOMAIN, 'value': token + '.dkim.amazonses.com', 'ttl': 300} for token in identity.get('DkimAttributes', {}).get('Tokens', [])]
    dns += [{'type': 'MX', 'name': 'send.' + DOMAIN, 'value': f'feedback-smtp.{REGION}.amazonses.com', 'priority': 10, 'ttl': 300}, {'type': 'TXT', 'name': 'send.' + DOMAIN, 'value': 'v=spf1 include:amazonses.com ~all', 'ttl': 300}]
    result = {'region': REGION, 'account': ACCOUNT, 'bucket': BUCKET, 'topic_arn': topic, 'dlq_url': queue_url, 'dlq_arn': queue_arn, 'subscription': subscription, 'role_arn': f'arn:aws:iam::{ACCOUNT}:role/dispatch', 'configuration_sets': CONFIGS, 'identity_arn': identity_arn, 'ses_account': account, 'identity': identity, 'dns': dns}
    (ROOT / '.dispatch').mkdir(exist_ok=True)
    (ROOT / '.dispatch/aws.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()

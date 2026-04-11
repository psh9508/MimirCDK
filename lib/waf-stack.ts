import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { getConfig } from './src/config/config';

const config = getConfig();

export class WafStack extends cdk.Stack {
  public readonly webAclArns: Map<string, string> = new Map();

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, {
      ...props,
      env: {
        ...props?.env,
        region: 'us-east-1', // CloudFront WAF must be in us-east-1
      },
      crossRegionReferences: true,
    });

    for (const siteConfig of config.staticSites) {
      if (siteConfig.wafAllowIps.length === 0) continue;

      const name = siteConfig.name;

      // IP Set
      const ipSet = new wafv2.CfnIPSet(this, `${name}-ip-set`, {
        name: `${name.toLowerCase()}-allowed-ips`,
        scope: 'CLOUDFRONT',
        ipAddressVersion: 'IPV4',
        addresses: siteConfig.wafAllowIps,
      });

      // WebACL
      const webAcl = new wafv2.CfnWebACL(this, `${name}-web-acl`, {
        name: `${name.toLowerCase()}-waf`,
        scope: 'CLOUDFRONT',
        defaultAction: { block: {} },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: `${name}WafMetric`,
          sampledRequestsEnabled: true,
        },
        rules: [
          {
            name: 'AllowSpecificIPs',
            priority: 1,
            action: { allow: {} },
            statement: {
              ipSetReferenceStatement: {
                arn: ipSet.attrArn,
              },
            },
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: `${name}AllowedIPsMetric`,
              sampledRequestsEnabled: true,
            },
          },
        ],
      });

      this.webAclArns.set(name, webAcl.attrArn);

      new cdk.CfnOutput(this, `${name}-waf-arn`, {
        value: webAcl.attrArn,
        description: `WAF WebACL ARN for ${name}`,
        exportName: `${name}-waf-arn`,
      });
    }
  }
}

#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { MimirCdkStack } from '../lib/mimir_cdk-stack';
import { WafStack } from '../lib/waf-stack';

const app = new cdk.App();

const account = '896824691859';

// WAF Stack (must be in us-east-1 for CloudFront)
const wafStack = new WafStack(app, 'WafStack', {
  env: { account, region: 'us-east-1' },
  crossRegionReferences: true,
});

// Main Stack
const mainStack = new MimirCdkStack(app, 'MimirCdkStack', {
  env: { account, region: 'ap-northeast-2' },
  crossRegionReferences: true,
  wafStack,
});

mainStack.addDependency(wafStack);

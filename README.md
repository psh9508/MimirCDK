# Welcome to your CDK TypeScript project

This is a blank project for CDK development with TypeScript.

The `cdk.json` file tells the CDK Toolkit how to execute your app.

## Useful commands

* `npm run build`   compile typescript to js
* `npm run watch`   watch for changes and compile
* `npm run test`    perform the jest unit tests
* `npx cdk deploy`  deploy this stack to your default AWS account/region
* `npx cdk diff`    compare deployed stack with current state
* `npx cdk synth`   emits the synthesized CloudFormation template

## Example: Deploy with a specific AWS profile

Use this flow when you want to deploy with a named AWS CLI profile.

1. Log in with AWS SSO:

```bash
aws sso login --profile cam2025-superpower
```

2. Deploy the CDK stack with the same profile:

```bash
npx cdk deploy --profile cam2025-superpower
```

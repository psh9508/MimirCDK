import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib/core';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';

export interface StaticSiteProps {
  name: string;
  bucketName: string;
  domainHead?: string;
  cicd: 'github' | 'gitlab';
  webAclArn?: string;
}

export class StaticSite extends Construct {
  public readonly bucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: StaticSiteProps) {
    super(scope, id);

    const { name, bucketName, cicd, webAclArn } = props;

    // S3 Bucket for static website
    const account = cdk.Stack.of(this).account;
    this.bucket = new s3.Bucket(this, 'bucket', {
      bucketName: `${bucketName}-${account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // CloudFront Distribution
    this.distribution = new cloudfront.Distribution(this, 'distribution', {
      comment: `${name} Static Website`,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
        },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      webAclId: webAclArn,
    });

    // GitHub OIDC Provider and Role
    if (cicd === 'github') {
      // Use existing GitHub OIDC Provider or create new one
      const githubProviderArn = `arn:aws:iam::${cdk.Stack.of(this).account}:oidc-provider/token.actions.githubusercontent.com`;
      const githubProvider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
        this,
        'github-oidc-provider',
        githubProviderArn,
      );

      const deployRole = new iam.Role(this, 'github-deploy-role', {
        roleName: `${name}-github-deploy-role`,
        assumedBy: new iam.FederatedPrincipal(
          githubProvider.openIdConnectProviderArn,
          {
            StringEquals: {
              'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
            },
            StringLike: {
              'token.actions.githubusercontent.com:sub': 'repo:*',
            },
          },
          'sts:AssumeRoleWithWebIdentity',
        ),
      });

      // S3 permissions
      this.bucket.grantReadWrite(deployRole);

      // CloudFront invalidation permissions
      deployRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['cloudfront:CreateInvalidation'],
          resources: [
            `arn:aws:cloudfront::${cdk.Stack.of(this).account}:distribution/${this.distribution.distributionId}`,
          ],
        }),
      );

      new cdk.CfnOutput(this, `${name}-deploy-role-arn`, {
        value: deployRole.roleArn,
        description: `GitHub Actions deploy role ARN for ${name}`,
      });
    }

    // Outputs
    new cdk.CfnOutput(this, `${name}-distribution-id`, {
      value: this.distribution.distributionId,
      description: `${name} CloudFront distribution ID`,
    });

    new cdk.CfnOutput(this, `${name}-distribution-domain`, {
      value: this.distribution.distributionDomainName,
      description: `${name} CloudFront domain`,
    });
  }
}

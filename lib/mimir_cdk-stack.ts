import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { getConfig } from './src/config/config';
import * as s3 from 'aws-cdk-lib/aws-s3';

const config = getConfig();

export class MimirCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const cicdRootBucket = new s3.Bucket(this, 'cicd-root-bucket', {
      bucketName: 'codepipeline-mimir-cicd',
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      // 스택 삭제 시 버킷도 삭제
      removalPolicy: cdk.RemovalPolicy.DESTROY, 
      // 버킷 안에 파일이 있어도 강제 삭제 (이 옵션이 없으면 파일이 있는 경우 에러 발생)
      autoDeleteObjects: true,
    });
  }
}

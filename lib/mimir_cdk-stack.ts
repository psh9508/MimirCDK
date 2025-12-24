import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { getConfig } from './src/config/config';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import { aws_codepipeline_actions } from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as fs from 'fs';
import * as yaml from 'yamljs';

const config = getConfig();

export class MimirCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const buildSpecObject = yaml.parse(
      fs.readFileSync('pipeline/buildspec-build.yml', 'utf8'),
    );
    const buildSpec = codebuild.BuildSpec.fromObject(buildSpecObject);

    const cicdRootBucket = new s3.Bucket(this, 'cicd-root-bucket', {
      bucketName: 'codepipeline-mimir-cicd',
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      eventBridgeEnabled: true,
      // 스택 삭제 시 버킷도 삭제
      removalPolicy: cdk.RemovalPolicy.DESTROY, 
      // 버킷 안에 파일이 있어도 강제 삭제 (이 옵션이 없으면 파일이 있는 경우 에러 발생)
      autoDeleteObjects: true,
    });

    for (const ecsService of config.ecsServices) {
      const serviceName = ecsService.name;
      const repositoryName = `mimir/${serviceName.toLowerCase()}`;

      const ecrRepository = new ecr.Repository(this, `${serviceName}-repository`, {
        repositoryName,
      });

      const pipeline = new codepipeline.Pipeline(this, `${serviceName}-pipeline`, {
        pipelineName: `${serviceName}-CICD`,
        artifactBucket: cicdRootBucket,
      });

      // S3 Object Created 이벤트 → EventBridge → CodePipeline 전체 실행
      new events.Rule(this, `${serviceName}-source-upload-rule`, {
        eventPattern: {
          source: ['aws.s3'],
          detailType: ['Object Created'],
          detail: {
            bucket: { name: [cicdRootBucket.bucketName] },
            object: { key: [{ prefix: `${serviceName}/source.zip` }] },
          },
        },
        targets: [new targets.CodePipeline(pipeline)],
      });

      // 1. source
      const sourceOutput = new codepipeline.Artifact(`${serviceName}_Artifact`);
      const sourceAction = new aws_codepipeline_actions.S3SourceAction({
        actionName: 'DownloadSourceCode',
        bucket: cicdRootBucket,
        bucketKey: `${serviceName}/source.zip`,
        output: sourceOutput
      });
      pipeline.addStage({
        stageName: 'Source',
        actions: [sourceAction],
      });

      // 2. build
      const buildOutput = new codepipeline.Artifact(`${serviceName}_BuildArtifact`);
      const codeBuildActionRole = new iam.Role(this, `${serviceName}-codebuild-action-role`, {
        assumedBy: new iam.ArnPrincipal(pipeline.role!.roleArn),
      });
      cicdRootBucket.grantReadWrite(codeBuildActionRole);

      const buildProject = new codebuild.PipelineProject(this, `${serviceName}-build-project`, {
        projectName: `${serviceName}-build`,
        environment: {
          buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
          privileged: true,
          environmentVariables: {
            ECR_REGION: { value: cdk.Stack.of(this).region },
            ECR_REPO_NAME: { value: ecrRepository.repositoryName },
            GIT_PROJECT_NAME: { value: serviceName },
          },
        },
        buildSpec,
      });
      ecrRepository.grantPullPush(buildProject);
      buildProject.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ecr:GetAuthorizationToken'],
          resources: ['*'],
        }),
      );
      codeBuildActionRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['codebuild:StartBuild', 'codebuild:BatchGetBuilds'],
          resources: [buildProject.projectArn],
        }),
      );

      const buildAction = new aws_codepipeline_actions.CodeBuildAction({
        actionName: 'BuildAndPushImage',
        project: buildProject,
        role: codeBuildActionRole,
        input: sourceOutput,
        outputs: [buildOutput],
      });
      pipeline.addStage({
        stageName: 'Build',
        actions: [buildAction],
      });

      // 3. deploy
    }
  }
}

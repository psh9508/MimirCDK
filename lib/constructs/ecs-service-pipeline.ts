import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import { aws_codepipeline_actions } from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as ecs from 'aws-cdk-lib/aws-ecs';

export interface EcsServicePipelineProps {
  serviceName: string;
  artifactBucket: s3.IBucket;
  ecrRepository: ecr.IRepository;
  buildSpec: codebuild.BuildSpec;
  fargateService: ecs.FargateService;
}

export class EcsServicePipeline extends Construct {
  public readonly pipeline: codepipeline.Pipeline;

  constructor(scope: Construct, id: string, props: EcsServicePipelineProps) {
    super(scope, id);

    const { serviceName, artifactBucket, ecrRepository, buildSpec, fargateService } = props;

    // Pipeline 생성
    this.pipeline = new codepipeline.Pipeline(this, 'pipeline', {
      pipelineName: `${serviceName}-CICD`,
      artifactBucket,
    });

    // S3 Object Created 이벤트 → EventBridge → CodePipeline 전체 실행
    new events.Rule(this, 'source-upload-rule', {
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: { name: [artifactBucket.bucketName] },
          object: { key: [{ prefix: `${serviceName}/source.zip` }] },
        },
      },
      targets: [new targets.CodePipeline(this.pipeline)],
    });

    // 1. Source Stage
    const sourceOutput = new codepipeline.Artifact(`${serviceName}_Artifact`);
    const sourceAction = new aws_codepipeline_actions.S3SourceAction({
      actionName: 'DownloadSourceCode',
      bucket: artifactBucket,
      bucketKey: `${serviceName}/source.zip`,
      output: sourceOutput,
    });
    this.pipeline.addStage({
      stageName: 'Source',
      actions: [sourceAction],
    });

    // 2. Build Stage
    const buildOutput = new codepipeline.Artifact(`${serviceName}_BuildArtifact`);
    const codeBuildActionRole = new iam.Role(this, 'codebuild-action-role', {
      assumedBy: new iam.ArnPrincipal(this.pipeline.role!.roleArn),
    });
    artifactBucket.grantReadWrite(codeBuildActionRole);

    const buildProject = new codebuild.PipelineProject(this, 'build-project', {
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
    this.pipeline.addStage({
      stageName: 'Build',
      actions: [buildAction],
    });

    // 3. Deploy Stage
    this.pipeline.addStage({
      stageName: 'Deploy',
      actions: [
        new aws_codepipeline_actions.EcsDeployAction({
          actionName: 'DeployToEcs',
          service: fargateService,
          input: buildOutput,
        }),
      ],
    });
  }
}

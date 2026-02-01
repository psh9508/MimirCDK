import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { getConfig } from './src/config/config';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as fs from 'fs';
import * as yaml from 'yamljs';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { EcsServicePipeline } from './constructs/ecs-service-pipeline';

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

    const vpc = new ec2.Vpc(this, 'mimir-cicd-vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'ingress',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          name: 'services',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });
    // PrivateLink endpoints so Fargate tasks can reach ECR/Logs/S3 without NAT
    vpc.addInterfaceEndpoint('ecr-api-endpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECR,
      privateDnsEnabled: true,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    });
    vpc.addInterfaceEndpoint('ecr-dkr-endpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      privateDnsEnabled: true,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    });
    vpc.addInterfaceEndpoint('cloudwatch-logs-endpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      privateDnsEnabled: true,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    });
    vpc.addGatewayEndpoint('s3-endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });
    const cluster = new ecs.Cluster(this, 'mimir-cicd-cluster', { vpc });
    const serviceSecurityGroup = new ec2.SecurityGroup(this, 'mimir-cicd-sg', {
      vpc,
      allowAllOutbound: true,
      description: 'Allow inbound service traffic',
    });
    serviceSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcpRange(80, 65535), 'Allow HTTP range');
    const taskExecutionRole = new iam.Role(this, 'ecs-task-execution-role', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    for (const ecsService of config.ecsServices) {
      const serviceName = ecsService.name;
      const repositoryName = `mimir/${serviceName.toLowerCase()}`;

      const ecrRepository = ecr.Repository.fromRepositoryName(
        this,
        `${serviceName}-repository`,
        repositoryName,
      );

      // ECS Task Definition
      const taskDefinition = new ecs.FargateTaskDefinition(this, `${serviceName}-taskdef`, {
        cpu: ecsService.cpu,
        memoryLimitMiB: ecsService.memory,
        executionRole: taskExecutionRole,
      });
      taskDefinition.addContainer(serviceName, {
        image: ecs.ContainerImage.fromEcrRepository(ecrRepository),
        logging: ecs.LogDrivers.awsLogs({
          streamPrefix: serviceName,
          logRetention: logs.RetentionDays.ONE_WEEK,
        }),
        portMappings: [
          {
            containerPort: ecsService.port,
          },
        ],
      });

      // ECS Fargate Service
      const fargateService = new ecs.FargateService(this, `${serviceName}-service`, {
        cluster,
        taskDefinition,
        desiredCount: ecsService.desiredCount,
        assignPublicIp: false,
        securityGroups: [serviceSecurityGroup],
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      });

      // Public Load Balancer (optional)
      if (ecsService.publicLb) {
        const loadBalancerSecurityGroup = new ec2.SecurityGroup(this, `${serviceName}-lb-sg`, {
          vpc,
          allowAllOutbound: true,
          description: `Public load balancer for ${serviceName}`,
        });
        loadBalancerSecurityGroup.addIngressRule(
          ec2.Peer.anyIpv4(),
          ec2.Port.tcp(80),
          'Allow HTTP traffic to load balancer',
        );
        serviceSecurityGroup.addIngressRule(
          loadBalancerSecurityGroup,
          ec2.Port.tcp(ecsService.port),
          `Allow public LB to reach ${serviceName}`,
        );

    //     const loadBalancer = new elbv2.ApplicationLoadBalancer(this, `${serviceName}-alb`, {
    //       vpc,
    //       internetFacing: true,
    //       vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    //       securityGroup: loadBalancerSecurityGroup,
    //       loadBalancerName: `${ecsService.publicLb.domainHead}-alb`,
    //     });

    //     const listener = loadBalancer.addListener(`${serviceName}-listener`, {
    //       port: 80,
    //       open: true,
    //     });

    //     listener.addTargets(`${serviceName}-targets`, {
    //       port: ecsService.port,
    //       targets: [
    //         fargateService.loadBalancerTarget({
    //           containerName: serviceName,
    //           containerPort: ecsService.port,
    //         }),
    //       ],
    //       healthCheck: {
    //         path: '/',
    //         healthyHttpCodes: '200-399',
    //       },
    //     });

    //     new cdk.CfnOutput(this, `${serviceName}-lb-dns`, {
    //       value: loadBalancer.loadBalancerDnsName,
    //     });
      }

      // CI/CD Pipeline
      new EcsServicePipeline(this, `${serviceName}-pipeline`, {
        serviceName,
        artifactBucket: cicdRootBucket,
        ecrRepository,
        buildSpec,
        fargateService,
      });
    }
  }
}

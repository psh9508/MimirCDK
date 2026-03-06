import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';

export interface EcsMonitoringProps {
  vpc: ec2.IVpc;
  mainServiceSecurityGroup?: ec2.ISecurityGroup;
}

interface VictoriaServiceSpec {
  name: string;
  image: string;
  port: number;
  mountPath: string;
  logGroupName: string;
  healthCheck: {
    command: string[];
    interval: number;
    timeout: number;
    retries: number;
    startPeriod: number;
  };
  command?: string[];
  entryPoint?: string[];
  environment?: Record<string, string>;
}

export class EcsMonitoring extends Construct {
  readonly cluster: ecs.Cluster;
  readonly serviceSecurityGroup: ec2.SecurityGroup;
  readonly efsSecurityGroup: ec2.SecurityGroup;
  readonly fileSystem: efs.FileSystem;
  readonly privateLoadBalancer: elbv2.ApplicationLoadBalancer;

  constructor(scope: Construct, id: string, props: EcsMonitoringProps) {
    super(scope, id);

    const { vpc, mainServiceSecurityGroup } = props;

    const clusterLogGroup = new logs.LogGroup(this, 'monitoring-cluster-log-group', {
      logGroupName: '/aws/ecs/cluster/monitoring',
      retention: logs.RetentionDays.ONE_MONTH,
    });

    this.cluster = new ecs.Cluster(this, 'monitoring-cluster', {
      vpc,
      clusterName: 'monitoring',
      containerInsights: false,
      executeCommandConfiguration: {
        logging: ecs.ExecuteCommandLogging.OVERRIDE,
        logConfiguration: {
          cloudWatchLogGroup: clusterLogGroup,
        },
      },
    });

    const albSecurityGroup = new ec2.SecurityGroup(this, 'monitoring-alb-sg', {
      vpc,
      allowAllOutbound: true,
      description: 'Security group for internal monitoring ALB',
    });
    albSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(80),
      'Allow HTTP from VPC',
    );
    albSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(8428),
      'Allow victoriametrics from VPC',
    );
    albSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(9428),
      'Allow victorialogs from VPC',
    );
    albSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(10428),
      'Allow victoriatraces from VPC',
    );
    if (mainServiceSecurityGroup) {
      albSecurityGroup.addIngressRule(
        mainServiceSecurityGroup,
        ec2.Port.tcp(80),
        'Allow monitoring traffic from main ECS service SG',
      );
      albSecurityGroup.addIngressRule(
        mainServiceSecurityGroup,
        ec2.Port.tcp(8428),
        'Allow victoriametrics from main ECS service SG',
      );
      albSecurityGroup.addIngressRule(
        mainServiceSecurityGroup,
        ec2.Port.tcp(9428),
        'Allow victorialogs from main ECS service SG',
      );
      albSecurityGroup.addIngressRule(
        mainServiceSecurityGroup,
        ec2.Port.tcp(10428),
        'Allow victoriatraces from main ECS service SG',
      );
    }

    this.privateLoadBalancer = new elbv2.ApplicationLoadBalancer(this, 'monitoring-private-alb', {
      vpc,
      internetFacing: false,
      securityGroup: albSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      loadBalancerName: 'monitoring-private-alb',
    });

    this.serviceSecurityGroup = new ec2.SecurityGroup(this, 'monitoring-service-sg', {
      vpc,
      allowAllOutbound: true,
      description: 'Security group for monitoring ECS services',
    });
    this.serviceSecurityGroup.addIngressRule(
      this.serviceSecurityGroup,
      ec2.Port.allTcp(),
      'Allow intra-service communication',
    );
    this.serviceSecurityGroup.addIngressRule(
      albSecurityGroup,
      ec2.Port.allTcp(),
      'Allow traffic from monitoring ALB',
    );
    if (mainServiceSecurityGroup) {
      this.serviceSecurityGroup.addIngressRule(
        mainServiceSecurityGroup,
        ec2.Port.allTcp(),
        'Allow traffic from main ECS services',
      );
    }

    this.efsSecurityGroup = new ec2.SecurityGroup(this, 'monitoring-efs-sg', {
      vpc,
      allowAllOutbound: true,
      description: 'Security group for monitoring EFS',
    });
    this.efsSecurityGroup.addIngressRule(
      this.serviceSecurityGroup,
      ec2.Port.tcp(2049),
      'Allow NFS from monitoring services',
    );

    this.fileSystem = new efs.FileSystem(this, 'monitoring-efs', {
      vpc,
      encrypted: true,
      securityGroup: this.efsSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_14_DAYS,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
      fileSystemName: 'monitoring-victoria-data',
    });

    const accessPoints = {
      logs: this.createAccessPoint('victoria-logs-ap', '/victoria-logs-data'),
      metrics: this.createAccessPoint('victoria-metrics-ap', '/victoria-metrics-data'),
      traces: this.createAccessPoint('victoria-traces-ap', '/victoria-traces-data'),
    };

    this.createService(
      {
        name: 'victorialogs',
        image: '905418179820.dkr.ecr.ap-northeast-2.amazonaws.com/docker.io/victoriametrics/victoria-logs:v1.43.1',
        port: 9428,
        command: [
          '-storageDataPath=/victoria-logs-data',
          '-retentionPeriod=90d',
          '-httpListenAddr=:9428',
        ],
        mountPath: '/victoria-logs-data',
        logGroupName: '/ecs/victoria/victorialogs',
        healthCheck: {
          command: ['CMD-SHELL', 'wget --no-verbose --tries=1 --spider http://localhost:9428/health || exit 1'],
          interval: 30,
          timeout: 5,
          retries: 3,
          startPeriod: 60,
        },
      },
      accessPoints.logs,
    );

    const scrapeConfigValue = this.generateScrapeConfig();

    const vmCommand = [
      'mkdir -p /etc/victoriametrics && ' +
        'printf "%s" "$VM_SCRAPE_CONFIG" > /etc/victoriametrics/scrape.yaml && ' +
        '/victoria-metrics-prod -retentionPeriod=1y -promscrape.config=/etc/victoriametrics/scrape.yaml ' +
        '-opentelemetry.usePrometheusNaming=true -maxLabelsPerTimeseries=64',
    ];

    this.createService(
      {
        name: 'victoriametrics',
        image: '905418179820.dkr.ecr.ap-northeast-2.amazonaws.com/docker.io/victoriametrics/victoria-metrics:v1.133.0',
        port: 8428,
        entryPoint: ['/bin/sh', '-c'],
        command: vmCommand,
        mountPath: '/victoria-metrics-data',
        logGroupName: '/ecs/victoria/victoriametrics',
        healthCheck: {
          command: ['CMD-SHELL', 'wget --no-verbose --tries=1 --spider http://localhost:8428/health || exit 1'],
          interval: 30,
          timeout: 5,
          retries: 3,
          startPeriod: 60,
        },
        environment: {
          VM_SCRAPE_CONFIG: scrapeConfigValue,
        },
      },
      accessPoints.metrics,
    );

    this.createService(
      {
        name: 'victoriatraces',
        image: '905418179820.dkr.ecr.ap-northeast-2.amazonaws.com/docker.io/victoriametrics/victoria-traces:v0.5.1',
        port: 10428,
        command: [
          '-storageDataPath=/victoria-traces-data',
          '-retentionPeriod=14d',
          '-httpListenAddr=:10428',
        ],
        mountPath: '/victoria-traces-data',
        logGroupName: '/ecs/victoria/victoriatraces',
        healthCheck: {
          command: ['CMD-SHELL', 'wget --no-verbose --tries=1 --spider http://localhost:10428/health || exit 1'],
          interval: 30,
          timeout: 5,
          retries: 3,
          startPeriod: 60,
        },
      },
      accessPoints.traces,
    );

    new cdk.CfnOutput(this, 'monitoring-private-alb-dns', {
      value: this.privateLoadBalancer.loadBalancerDnsName,
    });
  }

  private createAccessPoint(id: string, path: string): efs.AccessPoint {
    return new efs.AccessPoint(this, id, {
      fileSystem: this.fileSystem,
      path,
      createAcl: {
        ownerGid: '1000',
        ownerUid: '1000',
        permissions: '755',
      },
      posixUser: {
        gid: '1000',
        uid: '1000',
      },
    });
  }

  private createService(spec: VictoriaServiceSpec, accessPoint: efs.AccessPoint): ecs.FargateService {
    const executionRole = this.createEcsTaskExecutionRole(`${spec.name}-exec`);
    const taskRole = this.createEcsTaskRole(`${spec.name}-task`);

    this.fileSystem.grant(taskRole, 'elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite');
    taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'elasticfilesystem:ClientMount',
          'elasticfilesystem:ClientWrite',
          'elasticfilesystem:ClientRootAccess',
        ],
        resources: [this.fileSystem.fileSystemArn, accessPoint.accessPointArn],
      }),
    );
    const taskDefinition = new ecs.FargateTaskDefinition(this, `${spec.name}-task-definition`, {
      cpu: 2048,
      memoryLimitMiB: 4096,
      executionRole,
      taskRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const volumeName = `${spec.name}-data`;
    taskDefinition.addVolume({
      name: volumeName,
      efsVolumeConfiguration: {
        fileSystemId: this.fileSystem.fileSystemId,
        rootDirectory: '/',
        transitEncryption: 'ENABLED',
        authorizationConfig: {
          accessPointId: accessPoint.accessPointId,
          iam: 'ENABLED',
        },
      },
    });

    const containerLogGroup = new logs.LogGroup(this, `${spec.name}-log-group`, {
      logGroupName: spec.logGroupName,
      retention: logs.RetentionDays.ONE_MONTH,
    });
    const container = taskDefinition.addContainer(spec.name, {
      image: ecs.ContainerImage.fromRegistry(spec.image),
      cpu: 2048,
      memoryLimitMiB: 4096,
      essential: true,
      entryPoint: spec.entryPoint,
      command: spec.command,
      environment: spec.environment,
      logging: ecs.LogDrivers.awsLogs({
        logGroup: containerLogGroup,
        streamPrefix: 'ecs',
      }),
      stopTimeout: cdk.Duration.seconds(120),
      healthCheck: {
        command: spec.healthCheck.command,
        interval: cdk.Duration.seconds(spec.healthCheck.interval),
        timeout: cdk.Duration.seconds(spec.healthCheck.timeout),
        retries: spec.healthCheck.retries,
        startPeriod: cdk.Duration.seconds(spec.healthCheck.startPeriod),
      },
    });
    container.addPortMappings({
      containerPort: spec.port,
      hostPort: spec.port,
      protocol: ecs.Protocol.TCP,
      appProtocol: ecs.AppProtocol.http,
      name: spec.name,
    });
    container.addMountPoints({
      sourceVolume: volumeName,
      containerPath: spec.mountPath,
      readOnly: false,
    });

    const service = new ecs.FargateService(this, `${spec.name}-service`, {
      serviceName: spec.name,
      cluster: this.cluster,
      taskDefinition,
      desiredCount: 1,
      assignPublicIp: false,
      securityGroups: [this.serviceSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      healthCheckGracePeriod: cdk.Duration.seconds(60),
    });

    const listener = this.privateLoadBalancer.addListener(`${spec.name}-listener`, {
      port: spec.port,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false,
    });
    listener.addTargets(`${spec.name}-target`, {
      port: spec.port,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [
        service.loadBalancerTarget({
          containerName: spec.name,
          containerPort: spec.port,
        }),
      ],
      healthCheck: {
        path: '/health',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 3,
        unhealthyThresholdCount: 2,
      },
    });

    return service;
  }

  private createEcsTaskExecutionRole(name: string): iam.Role {
    const role = new iam.Role(this, name, {
      roleName: `ecs-victoria-${name}`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
    );
    return role;
  }

  private createEcsTaskRole(name: string): iam.Role {
    return new iam.Role(this, name, {
      roleName: `ecs-victoria-${name}`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
  }

  private generateScrapeConfig(): string {
    const lbDnsName = this.privateLoadBalancer.loadBalancerDnsName;

    return `scrape_configs:
  - job_name: victoriametrics
    static_configs:
      - targets:
          - "localhost:8428"
  - job_name: victorialogs
    static_configs:
      - targets:
          - "${lbDnsName}:9428"
  - job_name: victoriatraces
    static_configs:
      - targets:
          - "${lbDnsName}:10428"`;
  }
}

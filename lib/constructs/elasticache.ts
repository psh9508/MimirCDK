import { Construct } from 'constructs';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as cdk from 'aws-cdk-lib/core';

export interface ElastiCacheProps {
  name: string;
  engine: 'valkey' | 'redis' | 'memcached';
  nodeType: string;
  numNodes: number;
  vpc: ec2.IVpc;
  serviceSecurityGroup: ec2.ISecurityGroup;
}

export class ElastiCache extends Construct {
  public readonly endpoint: string;
  public readonly port: number;

  constructor(scope: Construct, id: string, props: ElastiCacheProps) {
    super(scope, id);

    const { name, engine, nodeType, numNodes, vpc, serviceSecurityGroup } = props;

    // Security Group for ElastiCache
    const cacheSecurityGroup = new ec2.SecurityGroup(this, 'cache-sg', {
      vpc,
      allowAllOutbound: false,
      description: `Security group for ${name} cache`,
    });

    // Default port based on engine
    const defaultPort = engine === 'memcached' ? 11211 : 6379;
    this.port = defaultPort;

    cacheSecurityGroup.addIngressRule(
      serviceSecurityGroup,
      ec2.Port.tcp(defaultPort),
      `Allow ${engine} access from ECS services`,
    );

    // Subnet Group
    const subnetGroup = new elasticache.CfnSubnetGroup(this, 'subnet-group', {
      description: `Subnet group for ${name}`,
      subnetIds: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }).subnetIds,
      cacheSubnetGroupName: `${name.toLowerCase()}-subnet-group`,
    });

    if (engine === 'memcached') {
      // Memcached uses CfnCacheCluster
      const cluster = new elasticache.CfnCacheCluster(this, 'cluster', {
        clusterName: name.toLowerCase(),
        engine: 'memcached',
        cacheNodeType: nodeType,
        numCacheNodes: numNodes,
        cacheSubnetGroupName: subnetGroup.cacheSubnetGroupName,
        vpcSecurityGroupIds: [cacheSecurityGroup.securityGroupId],
      });
      cluster.addDependency(subnetGroup);

      this.endpoint = cluster.attrConfigurationEndpointAddress;
    } else {
      // Valkey and Redis must use CfnReplicationGroup (CfnCacheCluster not supported for Valkey)
      const replicationGroup = new elasticache.CfnReplicationGroup(this, 'replication-group', {
        replicationGroupId: name.toLowerCase(),
        replicationGroupDescription: `${name} cache replication group using ${engine}`,
        engine: engine,
        cacheNodeType: nodeType,
        numCacheClusters: numNodes,
        cacheSubnetGroupName: subnetGroup.cacheSubnetGroupName,
        securityGroupIds: [cacheSecurityGroup.securityGroupId],
        automaticFailoverEnabled: numNodes > 1,
        transitEncryptionEnabled: false,
      });
      replicationGroup.addDependency(subnetGroup);

      this.endpoint = replicationGroup.attrPrimaryEndPointAddress;
    }

    // Output endpoint
    new cdk.CfnOutput(this, `${name}-endpoint`, {
      value: this.endpoint,
      description: `${name} cache endpoint`,
    });

    new cdk.CfnOutput(this, `${name}-port`, {
      value: String(this.port),
      description: `${name} cache port`,
    });
  }
}

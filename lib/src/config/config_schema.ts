import { z } from 'zod';

export const secretConfigSchema = z.object({
  name: z.string(),
});

export const ecsServiceConfigSchema = z.object({
  name: z.string(),
  port: z.number(),
  cpu: z.number().default(256),
  memory: z.number().default(512),
  desiredCount: z.number().default(1),
  secrets: z.array(secretConfigSchema).optional(),
  publicLb: z
    .object({
      domainHead: z.string(),
      allowedCidrs: z.array(z.string()).optional(),
    })
    .optional(),
});

export const cacheConfigSchema = z.object({
  name: z.string(),
  engine: z.enum(['valkey', 'redis', 'memcached']).default('valkey'),
  nodeType: z.string().default('cache.t3.micro'),
  numNodes: z.number().default(1),
});

export const staticSiteConfigSchema = z.object({
  name: z.string(),
  bucketName: z.string(),
  domainHead: z.string().optional(),
  cicd: z.enum(['github', 'gitlab']).default('github'),
  wafAllowIps: z.array(z.string()).default([]),
});

export const databaseConfigSchema = z.object({
  name: z.string(),
  username: z.string(),
  engineVersion: z.string().default('15.4'),
  instanceClass: z.string().default('t3.micro'),
  allocatedStorage: z.number().default(20),
  maxAllocatedStorage: z.number().default(100),
  databaseName: z.string(),
  port: z.number().default(5432),
  multiAz: z.boolean().default(false),
  deletionProtection: z.boolean().default(false),
  backupRetentionDays: z.number().default(7),
});

export const clusterConfigSchema = z.object({
  name: z.string(),
  ecsServices: z.array(ecsServiceConfigSchema).default([]),
});

export const configSchema = z.object({
  clusters: z.array(clusterConfigSchema).default([]),
  databases: z.array(databaseConfigSchema).default([]),
  caches: z.array(cacheConfigSchema).default([]),
  staticSites: z.array(staticSiteConfigSchema).default([]),
});

export type SecretConfig = z.infer<typeof secretConfigSchema>;
export type EcsServiceConfig = z.infer<typeof ecsServiceConfigSchema>;
export type DatabaseConfig = z.infer<typeof databaseConfigSchema>;
export type CacheConfig = z.infer<typeof cacheConfigSchema>;
export type StaticSiteConfig = z.infer<typeof staticSiteConfigSchema>;
export type ClusterConfig = z.infer<typeof clusterConfigSchema>;
export type Config = z.infer<typeof configSchema>;

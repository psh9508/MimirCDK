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
    })
    .optional(),
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

export const configSchema = z.object({
  ecsServices: z.array(ecsServiceConfigSchema).default([]),
  databases: z.array(databaseConfigSchema).default([]),
});

export type SecretConfig = z.infer<typeof secretConfigSchema>;
export type EcsServiceConfig = z.infer<typeof ecsServiceConfigSchema>;
export type DatabaseConfig = z.infer<typeof databaseConfigSchema>;
export type Config = z.infer<typeof configSchema>;

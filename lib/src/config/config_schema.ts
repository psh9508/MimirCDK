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

export const configSchema = z.object({
  ecsServices: z.array(ecsServiceConfigSchema).default([]),
});

export type SecretConfig = z.infer<typeof secretConfigSchema>;
export type EcsServiceConfig = z.infer<typeof ecsServiceConfigSchema>;
export type Config = z.infer<typeof configSchema>;

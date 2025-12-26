import { z } from 'zod';

export const ecsServiceConfigSchema = z.object({
  name: z.string(),
  port: z.number(),
  desiredCount: z.number().default(1),
});

export const configSchema = z.object({
  ecsServices: z.array(ecsServiceConfigSchema).default([]),
});

export type EcsServiceConfig = z.infer<typeof ecsServiceConfigSchema>;
export type Config = z.infer<typeof configSchema>;

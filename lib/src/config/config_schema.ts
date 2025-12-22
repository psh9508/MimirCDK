import { z } from 'zod';

export const ecsServiceConfigSchema = z.object({
  name: z.string(),
  prot: z.number(),
});

export const configSchema = z.object({
  escServices: z.array(ecsServiceConfigSchema).default([]),
});

export type Config = z.infer<typeof configSchema>;

import { z } from "zod";

export const DesktopCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("listSamples") }).strict(),
  z.object({ type: z.literal("start"), sampleId: z.string().min(1), candidateId: z.string().min(1), clientRequestId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("rebuild"), jobId: z.string().min(1), clientRequestId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("cancel"), runId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("getJob"), jobId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("getEvidence"), jobId: z.string().min(1), assetId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("getDiagnostics") }).strict(),
]);
export type DesktopCommand = z.infer<typeof DesktopCommandSchema>;

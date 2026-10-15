import { z } from 'zod';
import type { RegressionOrigin } from './regression-origin.ts';

export const fileSchema = z.object({ path: z.string().min(1).refine(path => !path.includes('\\') &&
    path.split('/').every(part => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) && part !== '.' && part !== '..')),
    encoding: z.enum(['utf8', 'base64']), content: z.string(), bytes: z.number().int().nonnegative() }).strict();
export type EmbeddedFile = z.infer<typeof fileSchema>;
export function decodeFile(value: unknown): { file: EmbeddedFile; bytes: Buffer } {
    const file = fileSchema.parse(value), bytes = Buffer.from(file.content, file.encoding === 'utf8' ? 'utf8' : 'base64');
    if (bytes.length !== file.bytes || file.encoding === 'base64' && bytes.toString('base64') !== file.content)
        throw new Error('Embedded material byte length or encoding changed: ' + file.path);
    return { file, bytes };
}
export type FlatDataset = { regressionOrigins?: Record<string, RegressionOrigin[]>; authored?: {version:'v1';cases:any[];gold:Record<string,any>;reviews:Record<string,any>;fixtures:Record<string,any>}; manifest: any; tasks: Record<string, any>; files: Record<string, EmbeddedFile>;
    inputs: Record<string, EmbeddedFile[]>; reviews: Record<string, any> };

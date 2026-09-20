import { productError } from '../../../contracts/src/errors.ts';

/** P0 engineering limits from the phase plan, not measured performance claims. */
export const P0_INPUT_LIMITS = Object.freeze({ maxFileBytes: 67_108_864, maxSampleBytes: 268_435_456, maxManifestBytes: 16_777_216, maxFilesPerSample: 2048, maxPages: 200, maxImagePixels: 40_000_000 });

export function enforceInputLimit(value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw productError({ code: 'INPUT_LIMIT_EXCEEDED', category: 'input', source: { component: 'voxel51', operation: 'inputBudget' }, safeMessage: 'The input exceeds an approved P0 capacity limit', impactScope: 'call', recoveryAction: 'correct_input', correlation: {} });
}

export function enforceSampleBudget(files: readonly { bytes: number }[]): void {
  enforceInputLimit(files.length, P0_INPUT_LIMITS.maxFilesPerSample);
  let total = 0;
  for (const file of files) {
    enforceInputLimit(file.bytes, P0_INPUT_LIMITS.maxFileBytes);
    total += file.bytes;
  }
  enforceInputLimit(total, P0_INPUT_LIMITS.maxSampleBytes);
}

export function enforceImageBudget(bytes: Uint8Array, path: string): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0, height = 0;
  if (/\.png$/i.test(path) && bytes.length >= 24) {
    width = view.getUint32(16); height = view.getUint32(20);
  } else if (/\.jpe?g$/i.test(path) && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 3 < bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
        height = view.getUint16(offset + 3); width = view.getUint16(offset + 5); break;
      }
      offset += length;
    }
  }
  if (!width || !height) throw productError({ code: 'IMAGE_UNREADABLE', category: 'input', source: { component: 'voxel51', operation: 'imageDimensions' }, safeMessage: 'Image dimensions cannot be established', impactScope: 'call', recoveryAction: 'correct_input', correlation: {} });
  enforceInputLimit(width * height, P0_INPUT_LIMITS.maxImagePixels);
}

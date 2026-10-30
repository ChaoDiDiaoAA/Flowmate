import durablePackage from '@earendil-works/pi-durable/package.json' with { type: 'json' };
import chordPackage from '@earendil-works/chord/package.json' with { type: 'json' };
import { PI_AI_VERSION } from '@earendil-works/pi-ai';

export const DURABLE_SDK_VERSIONS = { durable: durablePackage.version, ai: PI_AI_VERSION, chord: chordPackage.version } as const;

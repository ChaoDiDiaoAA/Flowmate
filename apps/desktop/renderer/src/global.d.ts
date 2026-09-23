import type { DesktopBridge } from '@flowmate/contracts';

declare global {
  interface Window { flowmate: DesktopBridge }
}

export {};

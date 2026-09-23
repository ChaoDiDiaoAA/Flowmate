import { openDatabase } from '@flowmate/core';
import { deferCleanup } from './resources.ts';

export const openTestDatabase: typeof openDatabase = paths => {
  const result = openDatabase(paths);
  if (result.ok) deferCleanup(() => result.data.close());
  return result;
};

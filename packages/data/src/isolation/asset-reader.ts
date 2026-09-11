import { lstat, realpath } from "node:fs/promises";
import { relative, sep } from "node:path";
import { readStableFile } from "../source/inspect.js";

export type FrozenAssetRecord = {
  assetId: string;
  path: string;
  sha256: string;
  mediaType: string;
  role: "original" | "parsed" | "labels";
};

export type AssetScope = {
  scopeId: string;
  root: string;
  assets: Record<string, FrozenAssetRecord>;
};

export class AssetReadError extends Error {
  constructor(public readonly code: "ASSET_NOT_ALLOWED" | "ASSET_PATH_ESCAPE" | "ASSET_SYMLINK" | "ASSET_HASH_MISMATCH", message: string) {
    super(message);
    this.name = "AssetReadError";
  }
}

function isInside(root: string, path: string): boolean {
  const value = relative(root, path);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !value.includes(`..${sep}`));
}

export async function readAsset(scope: AssetScope, assetId: string): Promise<Uint8Array> {
  const asset = scope.assets[assetId];
  if (!asset) throw new AssetReadError("ASSET_NOT_ALLOWED", "asset is not in the current input scope");
  let rootPath: string;
  let assetPath: string;
  try {
    rootPath = await realpath(scope.root);
    assetPath = await realpath(asset.path);
  } catch {
    throw new AssetReadError("ASSET_PATH_ESCAPE", "asset path cannot be resolved");
  }
  if (!isInside(rootPath, assetPath)) throw new AssetReadError("ASSET_PATH_ESCAPE", "asset path escapes the frozen input root");
  const stat = await lstat(asset.path).catch(() => null);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) throw new AssetReadError("ASSET_SYMLINK", "asset is not a regular frozen file");
  const result = await readStableFile(asset.path);
  if ("code" in result || result.sha256 !== asset.sha256) throw new AssetReadError("ASSET_HASH_MISMATCH", "frozen asset digest does not match");
  return new Uint8Array(result.bytes);
}

import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { HostAgent } from './dsh.ts';

export function expandHomePath(value: string): string {
  return value === '~' ? homedir() : /^~[/\\]/.test(value) ? join(homedir(), value.slice(2)) : value;
}

export type LocalFileResolver = (value: string, signal?: AbortSignal) => Promise<{
  path: string;
  read(maxBytes: number, signal?: AbortSignal): Promise<Uint8Array>;
}>;

function readError(error: unknown, signal?: AbortSignal): never {
  if (signal?.aborted) throw new Error('LOCAL_MEDIA_READ_ABORTED');
  const code = (error as { code?: string })?.code;
  const mapped: Record<string, string> = {
    FS_NOT_FOUND: 'LOCAL_MEDIA_NOT_FOUND', FS_NOT_REGULAR_FILE: 'LOCAL_MEDIA_NOT_FILE',
    FS_TOO_LARGE: 'MEDIA_TOO_LARGE', FS_ABORTED: 'LOCAL_MEDIA_READ_ABORTED',
    FS_SANDBOX_DENIED: 'LOCAL_MEDIA_READ_DENIED', EACCES: 'LOCAL_MEDIA_READ_DENIED', EPERM: 'LOCAL_MEDIA_READ_DENIED',
  };
  throw new Error(mapped[code ?? ''] ?? 'LOCAL_MEDIA_READ_FAILED');
}

/** Use the same fs provider and per-agent cwd as DSH's read_file/read_image tools. */
export function sessionLocalFiles(ctx: { get?(name: string): any }, agent: HostAgent | undefined): LocalFileResolver | undefined {
  if (!agent) return undefined;
  const service = (name: string) => agent.ctx?.get(name) ?? ctx.get?.(name);
  const fs = service('fs');
  if (!fs) return undefined;
  return async (value, signal) => {
    try {
      if (typeof fs.resolve !== 'function' || typeof fs.stat !== 'function' || typeof fs.readBytes !== 'function') throw new Error('UNSUPPORTED_FS_PROVIDER');
      const cwd = await service('workingDirectory')?.ensure(agent, signal);
      const target = await fs.resolve(expandHomePath(value), { ...(cwd === undefined ? {} : { cwd }), signal });
      const info = await fs.stat(target, signal);
      if (!info) throw Object.assign(new Error(), { code: 'FS_NOT_FOUND' });
      if (info.type !== 'file') throw Object.assign(new Error(), { code: 'FS_NOT_REGULAR_FILE' });
      // Keep an optional directory restriction bound to the canonical file the
      // provider will read, even if a display-path symlink changes meanwhile.
      const filename = typeof target.targetKey === 'string' && isAbsolute(target.targetKey) ? target.targetKey : target.displayPath;
      return { path: filename, read: async (maxBytes, readSignal) => {
        try {
          if (info.size > maxBytes) throw Object.assign(new Error(), { code: 'FS_TOO_LARGE' });
          return await fs.readBytes(target, readSignal, maxBytes);
        } catch (error) { return readError(error, readSignal); }
      } };
    } catch (error) { return readError(error, signal); }
  };
}

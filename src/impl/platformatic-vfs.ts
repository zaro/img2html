import { create, RealFSProvider } from '@platformatic/vfs';
import type { VirtualFileSystem } from '@platformatic/vfs';

export function createDefaultVfs(outputDir: string): VirtualFileSystem {
  const vfs = create(new RealFSProvider(outputDir), {
    overlay: false,
    moduleHooks: false,
    virtualCwd: false,
  });
  vfs.mount('/');
  return vfs;
}

/**
 * Process lifecycle & launcher IPC guard for `server.js`.
 *
 * When launched via `scripts/launch.js` (detached session with `--launcher-child`),
 * the visible console owns the launcher while the server runs in a separate session
 * so closing a Windows `.bat` window does not hard-kill the server before it releases
 * the NAS `.fund-manager.lock/` lease. Instead, the IPC channel closes on launcher exit
 * and this module triggers a graceful shutdown.
 */
function installLauncherGuard({ isMain, argv = process.argv, proc = process } = {}) {
  const launcherChild = Boolean(isMain && argv.includes('--launcher-child'));
  const exitWithoutLauncher = () => proc.exit(0);

  if (launcherChild) {
    // Install before loading storage: losing the console during initialization
    // must not leave an unattended server or a lease on the shared directory.
    if (!proc.connected) proc.exit(0);
    proc.once('disconnect', exitWithoutLauncher);
    for (const stream of [proc.stdout, proc.stderr]) {
      stream.on('error', error => {
        if (error.code !== 'EPIPE') throw error;
      });
    }
  }

  function attachServer(server, { port }) {
    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      // Pending HTTP clients cannot keep a closed launcher alive indefinitely.
      const shutdownTimer = setTimeout(() => proc.exit(0), 5000);
      shutdownTimer.unref();
      // Stop accepting HTTP work first. Keep ownership through pending requests
      // and background work; the synchronous exit hook releases it only as this
      // process terminates, so no surviving callback can write after release.
      server.close(() => proc.exit(0));
      server.closeIdleConnections?.();
    };

    proc.on('SIGINT', shutdown);
    proc.on('SIGTERM', shutdown);
    proc.on('SIGHUP', shutdown);
    if (launcherChild) {
      proc.removeListener('disconnect', exitWithoutLauncher);
      proc.once('disconnect', shutdown);
      if (!proc.connected) shutdown();
    }

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`\n❌ [启动失败] 端口 ${port} 已被占用！`);
        console.error(`💡 请检查是否已经运行了系统实例，或关闭占用 ${port} 端口的程序后重试。\n`);
        proc.exit(1);
      }
      console.error('[启动失败] 无法监听本机服务：', err.code || err.message);
      proc.exit(1);
    });
  }

  return { launcherChild, attachServer };
}

module.exports = { installLauncherGuard };

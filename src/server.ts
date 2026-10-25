import { TestWorkflowEnvironment } from '@temporalio/testing';

// A local Temporal dev server (downloaded on first run), with the Web UI on :8233.
// Same as `temporal server start-dev` if you have the Temporal CLI installed.
async function main() {
  const env = await TestWorkflowEnvironment.createLocal({ server: { ip: '127.0.0.1', port: 7233, ui: true, uiPort: 8233 } });
  console.log('Temporal dev server on 127.0.0.1:7233, Web UI on http://localhost:8233 (Ctrl+C to stop)');
  const stop = async () => {
    await env.teardown();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  setInterval(() => undefined, 60_000); // keep this process, and the server it owns, alive
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

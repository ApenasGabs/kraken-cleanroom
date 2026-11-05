import { startDemoServer } from "./index.js";

function resolvePortFromArgsOrEnv(argv: string[]): number {
  const portFlagIndex = argv.findIndex((arg) => arg === "--port" || arg === "-p");
  if (portFlagIndex !== -1) {
    const nextArg = argv[portFlagIndex + 1];
    if (nextArg) {
      const parsed = Number(nextArg);
      if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535) {
        return parsed;
      }
    }
  }
  const envPort = process.env.DEMO_APP_PORT ?? process.env.PORT;
  if (envPort) {
    const parsed = Number(envPort);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535) {
      return parsed;
    }
  }
  return 4173;
}

async function main(): Promise<void> {
  const port = resolvePortFromArgsOrEnv(process.argv.slice(2));
  const demo = await startDemoServer(port);
  process.stdout.write(`demo-app listening on ${demo.baseUrl}\n`);

  const shutdown = async (): Promise<void> => {
    await demo.close();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

void main();

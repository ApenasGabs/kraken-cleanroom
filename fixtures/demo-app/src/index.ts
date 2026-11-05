import { type ServerType, serve } from "@hono/node-server";
import type { Hono } from "hono";
import { createDemoApp } from "./app.js";
import { PUBLIC_APP_BUNDLE_JS } from "./bundle-content.js";
import {
  type DemoProject,
  type DemoStats,
  type DemoStore,
  type DemoStoreOptions,
  type PaginatedProjects,
  type PlanTier,
  type ProjectStatus,
  VALIDATION_MESSAGES,
  type ValidationFailure,
  type ValidationIssue,
  type ValidationResult,
  type ValidationSuccess,
  createDemoStore,
} from "./store.js";

export {
  createDemoApp,
  createDemoStore,
  PUBLIC_APP_BUNDLE_JS,
  VALIDATION_MESSAGES,
  type DemoProject,
  type DemoStats,
  type DemoStore,
  type DemoStoreOptions,
  type PaginatedProjects,
  type PlanTier,
  type ProjectStatus,
  type ValidationFailure,
  type ValidationIssue,
  type ValidationResult,
  type ValidationSuccess,
};

export interface StartDemoServerOptions extends DemoStoreOptions {
  hostname?: string;
}

export interface DemoServer {
  port: number;
  hostname: string;
  baseUrl: string;
  app: Hono;
  store: DemoStore;
  server: ServerType;
  getCreatedProjectsCount(): number;
  close(): Promise<void>;
}

export async function startDemoServer(
  port = 0,
  options: StartDemoServerOptions = {},
): Promise<DemoServer> {
  const urlHostname = options.hostname ?? "localhost";
  const { app, store } = createDemoApp(options);

  return new Promise<DemoServer>((resolve, reject) => {
    try {
      const server = serve(
        {
          fetch: app.fetch,
          port,
          ...(options.hostname ? { hostname: options.hostname } : {}),
        },
        (info) => {
          const boundPort = info.port;
          const baseUrl = `http://${urlHostname}:${boundPort}`;
          resolve({
            port: boundPort,
            hostname: urlHostname,
            baseUrl,
            app,
            store,
            server,
            getCreatedProjectsCount: () => store.getCreatedProjectsCount(),
            close: () =>
              new Promise<void>((res, rej) => {
                server.close((err) => {
                  if (err) {
                    rej(err);
                    return;
                  }
                  res();
                });
              }),
          });
        },
      );
      server.on("error", (err) => {
        reject(err);
      });
    } catch (error) {
      reject(error);
    }
  });
}

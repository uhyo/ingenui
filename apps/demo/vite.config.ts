import type { IncomingMessage } from "node:http";
import { fileURLToPath } from "node:url";

import { defineConfig, loadEnv } from "vite";
import type { Plugin } from "vite";

// Resolve `@ingenui/incremental-jsx-parser` (and its subpaths) straight to the library
// source, so the demo always reflects the code in
// `../../packages/incremental-jsx-parser/src` with no build step.
// We don't depend on `@vitejs/plugin-react`; Vite's built-in esbuild transform
// handles `.tsx` using the `jsx: "react-jsx"` setting from `tsconfig.json`.
const fromHere = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** A Node request as a Fetch API `Request`. */
async function toRequest(req: IncomingMessage): Promise<Request> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new Request(new URL(req.url ?? "/", "http://localhost"), {
    method: req.method,
    headers,
    body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
  });
}

/** The Worker's variables, as `wrangler dev` reads them (`.env`, `.env.local`). */
const WORKER_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_MODEL"];

/**
 * Serve the Worker's `/api/*` routes (`worker/index.ts`) from `vite dev`, so
 * the demo's server side runs without wrangler. The module goes through
 * Vite's SSR loader, so the workspace aliases below apply to it too. Its
 * `env` comes from the same `.env` files wrangler reads (or the shell).
 */
function workerApi(): Plugin {
  return {
    name: "demo-worker-api",
    configureServer(server) {
      const fileEnv = loadEnv(server.config.mode, server.config.envDir || server.config.root, "");
      const env: Record<string, string> = {};
      for (const name of WORKER_VARS) {
        const value = process.env[name] ?? fileEnv[name];
        if (value) env[name] = value;
      }
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/")) return next();
        try {
          const worker = (await server.ssrLoadModule("/worker/index.ts")) as {
            default: { fetch(request: Request, env: Record<string, string>): Promise<Response> };
          };
          const response = await worker.default.fetch(await toRequest(req), env);
          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          if (response.body) {
            // Forward chunk by chunk, so streaming reaches the browser live;
            // a closed connection cancels the body (and so the model request).
            const reader = response.body.getReader();
            res.on("close", () => void reader.cancel().catch(() => {}));
            for (;;) {
              // oxlint-disable-next-line no-await-in-loop -- forwarding is sequential
              const { done, value } = await reader.read();
              if (done || res.destroyed) break;
              res.write(value);
            }
          }
          res.end();
        } catch (error) {
          next(error);
        }
      });
    },
  };
}

export default defineConfig({
  root: fromHere("."),
  plugins: [workerApi()],
  resolve: {
    alias: {
      "@ingenui/incremental-jsx-parser/react": fromHere(
        "../../packages/incremental-jsx-parser/src/react.ts",
      ),
      "@ingenui/incremental-jsx-parser/core": fromHere(
        "../../packages/incremental-jsx-parser/src/core.ts",
      ),
      "@ingenui/incremental-jsx-parser": fromHere(
        "../../packages/incremental-jsx-parser/src/index.ts",
      ),
      "ingenui/react": fromHere("../../packages/ingenui/src/react.ts"),
      "ingenui/schema": fromHere("../../packages/ingenui/src/schema.ts"),
      "ingenui/server": fromHere("../../packages/ingenui/src/server.ts"),
      ingenui: fromHere("../../packages/ingenui/src/index.ts"),
    },
    // The aliased library source imports `react`/`react-dom` too.
    // Without deduping, the production build resolves those to a separate copy
    // (e.g. the repo-root install) from the demo's own, so the page ships two
    // React instances and hooks crash with "Cannot read properties of null
    // (reading 'useMemo')". Force a single copy from the demo's deps.
    dedupe: ["react", "react-dom"],
  },
  server: {
    // The library source lives outside the demo root (in the workspace's
    // `packages/` directory); allow the dev server to read the whole repo so
    // `pnpm dev` can serve the aliased modules.
    fs: { allow: [fromHere("../..")] },
  },
});

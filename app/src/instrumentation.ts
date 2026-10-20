// Runs once when the server starts. Next calls register() in every runtime and also bundles this file for the Edge
// runtime, so all of the work lives in ./instrumentation-node and is imported only inside the NEXT_RUNTIME check below:
// the bundler drops that branch from the Edge bundle (Next docs, instrumentation: "Importing runtime-specific code").
// An early `return` for other runtimes is not enough; the imports after it still landed in the Edge graph and the build
// warned about process.kill/on/off/pid, node:fs, node:path and node:crypto there. The edge runtime does nothing.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") await (await import("./instrumentation-node")).registerNode();
}

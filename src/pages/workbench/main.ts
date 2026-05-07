async function main(): Promise<void> {
  const { startBackendWorkbench } = await import("./backend-workbench.js");
  await startBackendWorkbench();
}

void main();

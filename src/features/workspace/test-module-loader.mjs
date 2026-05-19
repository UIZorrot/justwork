import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const outRoot = await mkdtemp(path.join(os.tmpdir(), "justwork-workspace-tests-"));
const emittedModules = new Map();

function transpileModule(source, filename) {
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      esModuleInterop: true,
      verbatimModuleSyntax: false,
    },
    fileName: filename,
  });
  return output.outputText;
}

function resolveRelativeImport(sourceFilename, specifier) {
  const base = path.resolve(path.dirname(sourceFilename), specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`];
  return candidates.find((candidate) => path.extname(candidate) && existsSync(candidate))
    ?? candidates[0];
}

function relativeImportPath(fromFile, toFile) {
  const relative = path.relative(path.dirname(fromFile), toFile).replace(/\\/g, "/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

async function emitModule(sourceFilename) {
  const normalizedSource = path.resolve(sourceFilename);
  const existing = emittedModules.get(normalizedSource);
  if (existing) return existing;

  const relativeOutput = path.relative(process.cwd(), normalizedSource).replace(/\.(ts|tsx)$/, ".mjs");
  const outputFilename = path.join(outRoot, relativeOutput);
  emittedModules.set(normalizedSource, outputFilename);

  const source = await readFile(normalizedSource, "utf8");
  let compiled = transpileModule(source, path.basename(normalizedSource));

  const specifiers = [
    ...compiled.matchAll(/from\s+["'](\.[^"']+)["']/g),
    ...compiled.matchAll(/import\(\s*["'](\.[^"']+)["']\s*\)/g),
  ].map((match) => match[1]);

  for (const specifier of new Set(specifiers)) {
    const dependencySource = resolveRelativeImport(normalizedSource, specifier);
    const dependencyOutput = await emitModule(dependencySource);
    compiled = compiled.replaceAll(specifier, relativeImportPath(outputFilename, dependencyOutput));
  }

  await mkdir(path.dirname(outputFilename), { recursive: true });
  await writeFile(outputFilename, compiled, "utf8");
  return outputFilename;
}

export async function loadTranspiledModule(relativePath) {
  const outputFilename = await emitModule(path.resolve(relativePath));
  return import(`${pathToFileURL(outputFilename).href}?t=${Date.now()}`);
}

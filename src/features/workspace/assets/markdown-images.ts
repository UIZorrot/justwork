import type { WorkspaceImageAssetStore } from "./asset-store";

const PLACEHOLDER_PREFIX = "jwasset://";
const IMAGE_REF_RE = /!\[([^\]]*)\]\((jwasset:\/\/[^)]+)\)/g;

function parseAssetRef(url: string): { workspaceId: string; assetId: string } | null {
  if (!url.startsWith(PLACEHOLDER_PREFIX)) return null;
  const [, workspaceId, assetId] = url.match(/^jwasset:\/\/([^/]+)\/(.+)$/) ?? [];
  if (!workspaceId || !assetId) return null;
  return { workspaceId, assetId };
}

function extractWorkspaceAssetRefs(markdown: string, workspaceId: string): string[] {
  const refs: string[] = [];
  for (const match of markdown.matchAll(IMAGE_REF_RE)) {
    const ref = parseAssetRef(match[2] ?? "");
    if (ref && ref.workspaceId === workspaceId) refs.push(ref.assetId);
  }
  return refs;
}

export function collectWorkspaceAssetRefs(markdown: string, workspaceId: string): string[] {
  return extractWorkspaceAssetRefs(markdown, workspaceId);
}

export function createWorkspaceImageMarkdownCodec(opts: {
  workspaceId: string;
  store: WorkspaceImageAssetStore;
}) {
  const { workspaceId, store } = opts;

  return {
    async warmMarkdown(markdown: string): Promise<void> {
      const refs = extractWorkspaceAssetRefs(markdown, workspaceId);
      for (const assetId of refs) {
        await store.loadBlobUrl(assetId);
      }
    },
    async warmMarkdowns(markdowns: string[]): Promise<void> {
      for (const markdown of markdowns) {
        const refs = extractWorkspaceAssetRefs(markdown, workspaceId);
        for (const assetId of refs) {
          await store.loadBlobUrl(assetId);
        }
      }
    },
    rewriteForEditor(markdown: string): string {
      return markdown.replace(IMAGE_REF_RE, (_full, alt: string, url: string) => {
        const ref = parseAssetRef(url);
        if (!ref || ref.workspaceId !== workspaceId) return `![${alt}](${url})`;
        return `![${alt}](${store.resolveAssetUrlSync(ref.assetId)})`;
      });
    },
    rewriteFromEditor(markdown: string): string {
      return markdown.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_full, alt: string, url: string) => {
        const ref = parseAssetRef(url);
        if (ref && ref.workspaceId === workspaceId) return `![${alt}](${url})`;
        const assetId = store.resolveAssetIdFromUrl(url);
        if (!assetId) return `![${alt}](${url})`;
        return `![${alt}](jwasset://${workspaceId}/${assetId})`;
      });
    },
    resolveAssetUrl(assetId: string): string {
      return store.resolveAssetUrlSync(assetId);
    },
    async refreshAsset(assetId: string): Promise<string | null> {
      return store.loadBlobUrl(assetId);
    },
  };
}

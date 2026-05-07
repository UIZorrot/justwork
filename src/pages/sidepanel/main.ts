import "@/shared/toast";
import { createWysiwygEditor } from "@/features/editor/vditor/create-editor";
import { fetchBridgeDocument, putBridgeDocument } from "@/features/bridge/client";
import {
  applyI18n,
  createTranslator,
  observePreferredLocaleChanges,
  resolvePreferredLocale,
} from "@/shared/i18n";
import {
  DEFAULT_BRIDGE_SETTINGS,
  STORAGE_KEYS,
  type BridgeSettings,
  type DocPayloadV2,
} from "@/shared/storage-keys";

function debounce(
  fn: (bridge: BridgeSettings, markdown: string) => void,
  ms: number,
): (bridge: BridgeSettings, markdown: string) => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (bridge: BridgeSettings, markdown: string) => {
    if (t !== undefined) {
      clearTimeout(t);
    }
    t = setTimeout(() => {
      fn(bridge, markdown);
    }, ms);
  };
}

async function loadBridgeSettings(): Promise<BridgeSettings> {
  const raw = await chrome.storage.local.get(STORAGE_KEYS.BRIDGE_SETTINGS);
  const v = raw[STORAGE_KEYS.BRIDGE_SETTINGS] as BridgeSettings | undefined;
  if (!v || typeof v.baseUrl !== "string") {
    return { ...DEFAULT_BRIDGE_SETTINGS };
  }
  return {
    enabled: Boolean(v.enabled),
    baseUrl: v.baseUrl,
    token: v.token,
  };
}

async function loadDocPayload(): Promise<DocPayloadV2> {
  const raw = await chrome.storage.local.get([STORAGE_KEYS.DOC_V2, STORAGE_KEYS.DOC_V1_DRAFT]);
  const v2 = raw[STORAGE_KEYS.DOC_V2] as DocPayloadV2 | undefined;
  if (v2 && typeof v2.markdown === "string" && typeof v2.revision === "number") {
    return v2;
  }
  const legacy = raw[STORAGE_KEYS.DOC_V1_DRAFT];
  if (typeof legacy === "string") {
    return { markdown: legacy, revision: 0 };
  }
  return { markdown: "", revision: 0 };
}

async function saveDocPayload(payload: DocPayloadV2): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.DOC_V2]: payload });
}

function main(): void {
  const root = document.getElementById("editor-root");
  if (!root) {
    console.error("editor-root missing");
    return;
  }

  void (async () => {
    const locale = await resolvePreferredLocale();
    let i18n = createTranslator(locale);
    applyI18n(document, i18n);
    const disposeLocaleObserver = observePreferredLocaleChanges((nextLocale) => {
      if (nextLocale === i18n.locale) return;
      i18n = createTranslator(nextLocale);
      applyI18n(document, i18n);
    });

    const bridge = await loadBridgeSettings();
    let local = await loadDocPayload();

    const remote = await fetchBridgeDocument(bridge);
    if (remote && remote.revision >= local.revision) {
      local = { markdown: remote.markdown, revision: remote.revision };
      await saveDocPayload(local);
    }

    const pushToBridge = debounce((b: BridgeSettings, markdown: string) => {
      void putBridgeDocument(b, markdown).then(async (doc) => {
        if (!doc) {
          return;
        }
        local = { markdown: doc.markdown, revision: doc.revision };
        await saveDocPayload(local);
      });
    }, 800);

    const editor = createWysiwygEditor({
      container: root,
      initialMarkdown: local.markdown,
      onChange: (markdown) => {
        void (async () => {
          const next: DocPayloadV2 = {
            markdown,
            revision: local.revision,
          };
          local = next;
          await saveDocPayload(next);
          const b = await loadBridgeSettings();
          if (b.enabled) {
            pushToBridge(b, markdown);
          }
        })();
      },
    });

    window.addEventListener("beforeunload", () => {
      disposeLocaleObserver();
      editor.destroy();
    });
  })();
}

main();

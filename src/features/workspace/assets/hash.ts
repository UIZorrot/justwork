function toUint8Array(input: ArrayBuffer | ArrayBufferView | Blob): Promise<Uint8Array> {
  if (input instanceof Blob) return input.arrayBuffer().then((buf) => new Uint8Array(buf));
  if (input instanceof ArrayBuffer) return Promise.resolve(new Uint8Array(input));
  return Promise.resolve(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(input: ArrayBuffer | ArrayBufferView | Blob): Promise<string> {
  const bytes = await toUint8Array(input);
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest("SHA-256", bytes.slice().buffer);
    return hex(new Uint8Array(digest));
  }
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(bytes).digest("hex");
}

export async function toArrayBuffer(input: ArrayBuffer | ArrayBufferView | Blob): Promise<ArrayBuffer> {
  if (input instanceof Blob) return input.arrayBuffer();
  if (input instanceof ArrayBuffer) return input.slice(0);
  const view = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return view.slice().buffer;
}

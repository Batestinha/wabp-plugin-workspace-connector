import { open } from 'node:fs/promises';

// Read only on demand. Readable.toWeb(createReadStream(...)) can enqueue after
// cancellation when a server rejects a large upload before consuming its body.
export async function openFileUpload(filePath: string): Promise<{
  body: ReadableStream<Uint8Array>;
  close: () => Promise<void>;
}> {
  const file = await open(filePath, 'r');
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await file.close();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = new Uint8Array(64 * 1024);
        const { bytesRead } = await file.read(chunk);
        if (closed) return;
        if (bytesRead === 0) {
          await close();
          controller.close();
        } else {
          controller.enqueue(chunk.subarray(0, bytesRead));
        }
      } catch (error) {
        if (!closed) {
          await close();
          controller.error(error);
        }
      }
    },
    cancel: close,
  }, { highWaterMark: 0 });
  return { body, close };
}

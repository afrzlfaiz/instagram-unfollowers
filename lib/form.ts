import type { IncomingMessage } from "node:http";

export async function readUrlEncodedForm(
  request: IncomingMessage,
  maxBytes = 16 * 1024,
): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > maxBytes) throw new Error("Request terlalu besar");
    chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

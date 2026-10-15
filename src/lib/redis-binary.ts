import type { RedisBlob } from "./redis.ts";

const PREVIEW_LIMIT = 64 * 1024;
const FIELD_LIMIT = 256;
const NAME_LIMIT = 4096;
const primitiveTypes: Record<string, string> = {
  B: "byte",
  C: "char",
  D: "double",
  F: "float",
  I: "int",
  J: "long",
  S: "short",
  Z: "boolean",
};
interface JavaDescriptor {
  version: number;
  className: string | null;
  serialVersionUid: string | null;
  fields: { name: string; type: string }[];
  partial: boolean;
}
export interface RedisBinaryInfo {
  text: string;
  bytes: number;
  limited: boolean;
  java: JavaDescriptor | null;
}

function javaDescriptor(bytes: Uint8Array): JavaDescriptor {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result: JavaDescriptor = {
    version: view.getUint16(2),
    className: null,
    serialVersionUid: null,
    fields: [],
    partial: true,
  };
  let offset = 4;
  const take = (length: number) => {
    if (offset + length > bytes.length) throw new Error("Incomplete descriptor");
    const start = offset;
    offset += length;
    return start;
  };
  const byte = () => bytes[take(1)];
  const utf = () => {
    const length = view.getUint16(take(2));
    if (length > NAME_LIMIT) throw new Error("Descriptor string limit");
    const end = take(length) + length;
    let index = end - length;
    let value = "";
    // Java metadata uses modified UTF-8, including UTF-16 surrogate pairs. Java 元数据使用修订版 UTF-8，含 UTF-16 代理对。
    while (index < end) {
      const first = bytes[index++];
      if (first > 0 && first < 0x80) value += String.fromCharCode(first);
      else if ((first & 0xe0) === 0xc0 && index < end) {
        const second = bytes[index++];
        const code = ((first & 0x1f) << 6) | (second & 0x3f);
        if ((second & 0xc0) !== 0x80 || (code < 0x80 && code !== 0))
          throw new Error("Invalid modified UTF-8");
        value += String.fromCharCode(code);
      } else if ((first & 0xf0) === 0xe0 && index + 1 < end) {
        const second = bytes[index++],
          third = bytes[index++];
        const code = ((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f);
        if ((second & 0xc0) !== 0x80 || (third & 0xc0) !== 0x80 || code < 0x800)
          throw new Error("Invalid modified UTF-8");
        value += String.fromCharCode(code);
      } else throw new Error("Invalid modified UTF-8");
    }
    return value;
  };
  const fieldType = (descriptor: string): string => {
    let depth = 0;
    while (descriptor[depth] === "[") depth++;
    const value = descriptor.slice(depth);
    const type =
      (value.length === 1 ? primitiveTypes[value] : undefined) ??
      (value.startsWith("L") && value.endsWith(";") ? value.slice(1, -1).replaceAll("/", ".") : "");
    if (!type || depth > 255) throw new Error("Invalid field type");
    return type + "[]".repeat(depth);
  };
  try {
    if (result.version !== 5) return result;
    while (bytes[offset] === 0x79) offset++;
    if ([0x73, 0x75, 0x76, 0x7e].includes(bytes[offset])) offset++;
    if (byte() !== 0x72) return result;
    result.className = utf();
    result.serialVersionUid = view.getBigInt64(take(8)).toString();
    byte();
    const count = view.getUint16(take(2));
    // Inspect only the first class descriptor; never construct objects or invoke hooks. 仅检查首个类描述，不构造对象或执行回调。
    const strings = new Map<number, string>();
    let handle = 0x7e0001;
    for (let index = 0; index < Math.min(count, FIELD_LIMIT); index++) {
      const code = String.fromCharCode(byte());
      const name = utf();
      let type = primitiveTypes[code];
      if (code === "L" || code === "[") {
        const token = byte();
        let descriptor: string | undefined;
        if (token === 0x74) {
          descriptor = utf();
          strings.set(handle++, descriptor);
        } else if (token === 0x71) descriptor = strings.get(view.getUint32(take(4)));
        if (!descriptor || descriptor[0] !== code) throw new Error("Invalid field reference");
        type = fieldType(descriptor);
      }
      if (!type) throw new Error("Invalid field type");
      result.fields.push({ name, type });
    }
    result.partial = count > FIELD_LIMIT;
  } catch {
    // Keep already-read metadata when a page ends or the descriptor is unsupported. 分页结束或描述不受支持时，保留已读取的元数据。
  }
  return result;
}

/** Builds a bounded, read-only view of received bytes; offset skips stream-header detection on later pages. 为已接收字节生成有界只读预览；后续分页不识别流头。 */
export function redisBinaryInfo(value: RedisBlob, offset = 0): RedisBinaryInfo {
  // Slice base64 before decoding so extra preview work stays bounded. 解码前截取 Base64，限制额外预览处理量。
  const binary = atob(value.data.slice(0, Math.ceil(PREVIEW_LIMIT / 3) * 4));
  const bytes = Uint8Array.from(binary.slice(0, PREVIEW_LIMIT), (char) => char.charCodeAt(0));
  const text = new TextDecoder("utf-8")
    .decode(bytes)
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "·");
  return {
    text,
    bytes: bytes.length,
    limited: value.truncated || value.size > bytes.length,
    java:
      offset === 0 && bytes.length >= 4 && bytes[0] === 0xac && bytes[1] === 0xed
        ? javaDescriptor(bytes)
        : null,
  };
}

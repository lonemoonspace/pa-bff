// secretbox：用 AES-GCM 封装机密（第三方 API 密钥、push token）。
// 只用 Web 标准 API（crypto.subtle、btoa/atob），不引入依赖。
//
// additionalData 固定为 "pa-bff:v1:" + purpose：把密文和它的用途（例如
// secret:google_routes、push_token）绑死，防止把一处密文挪到另一处去解密
// （即便主密钥泄露被拿去跑离线穷举，也不能跨用途复用）。

/** 密封后的密文，seal() 的返回值 / open() 的输入。 */
export interface SealedBox {
  /** AES-GCM 密文（含认证 tag），base64 编码。 */
  ciphertext: string;
  /** 随机 IV（12 字节），base64 编码。 */
  iv: string;
}

const AES_GCM = "AES-GCM";
const IV_BYTES = 12;
const MASTER_KEY_BYTES = 32;
const AAD_PREFIX = "pa-bff:v1:";

// 同一 isolate 内，相同的 base64 主密钥只导入一次：CryptoKey 不可导出，
// 缓存的是 import 过程本身（Promise），避免并发调用时重复 import。
const importedKeys = new Map<string, Promise<CryptoKey>>();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function additionalDataFor(purpose: string): Uint8Array {
  return new TextEncoder().encode(AAD_PREFIX + purpose);
}

/**
 * 导入 base64 编码的主密钥为不可导出的 AES-GCM CryptoKey。
 * 解码后长度不是 32 字节（256 位）时抛出明确错误。
 */
export function importMasterKey(masterKeyB64: string): Promise<CryptoKey> {
  const cached = importedKeys.get(masterKeyB64);
  if (cached) return cached;

  const promise = (async () => {
    // 错误消息不得包含 MASTER_KEY 的任何内容（G2 修复 5）：只报告长度，不回显原文，
    // 避免异常/日志把主密钥（哪怕是格式错误的、部分正确的）泄露出去。
    let raw: Uint8Array;
    try {
      raw = base64ToBytes(masterKeyB64);
    } catch {
      throw new Error(`MASTER_KEY 不是合法的 base64（长度 ${masterKeyB64.length}）`);
    }
    if (raw.length !== MASTER_KEY_BYTES) {
      throw new Error(
        `MASTER_KEY 解码后必须正好 ${MASTER_KEY_BYTES} 字节，实际 ${raw.length} 字节`,
      );
    }
    return crypto.subtle.importKey("raw", raw, AES_GCM, false, [
      "encrypt",
      "decrypt",
    ]);
  })();

  importedKeys.set(masterKeyB64, promise);
  return promise;
}

/**
 * 加密明文。每次调用生成新的随机 12 字节 IV，因此同一明文两次 seal
 * 得到的密文不同。purpose 写入 additionalData，open() 时必须一致。
 */
export async function seal(
  key: CryptoKey,
  plaintext: string,
  purpose: string,
): Promise<SealedBox> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: AES_GCM, iv, additionalData: additionalDataFor(purpose) },
    key,
    new TextEncoder().encode(plaintext),
  );
  return {
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    iv: bytesToBase64(iv),
  };
}

/**
 * 解密。密文 / IV / purpose 任一项被篡改都会导致 AES-GCM 认证失败，
 * 此时返回 null（不抛异常，调用方不需要 try/catch）。
 */
export async function open(
  key: CryptoKey,
  sealed: SealedBox,
  purpose: string,
): Promise<string | null> {
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: AES_GCM,
        iv: base64ToBytes(sealed.iv),
        additionalData: additionalDataFor(purpose),
      },
      key,
      base64ToBytes(sealed.ciphertext),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}

/**
 * 给 SecretStatus.hint 用的脱敏提示：末 4 位前加 "···"。
 * 明文太短（<8 位）时干脆不露出任何字符，只返回 "···"。
 */
export function hintOf(plaintext: string): string {
  if (plaintext.length < 8) return "···";
  return "···" + plaintext.slice(-4);
}

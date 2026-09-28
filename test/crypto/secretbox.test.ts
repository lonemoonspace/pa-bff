import { beforeAll, describe, expect, it } from "vitest";
import {
  hintOf,
  importMasterKey,
  open,
  seal,
  type SealedBox,
} from "../../src/crypto/secretbox";

// 32 字节随机数的 base64 编码，仅测试用。
const MASTER_KEY_B64 = "iN/Gcnuuu887bqnQ9I/yOgc1ZByf+qkaVUaPe4mYOzY=";
const PURPOSE = "secret:google_routes";

describe("secretbox", () => {
  let key: CryptoKey;

  beforeAll(async () => {
    key = await importMasterKey(MASTER_KEY_B64);
  });

  it("往返：seal 后 open 得到原文", async () => {
    const sealed = await seal(key, "hello world", PURPOSE);
    const plaintext = await open(key, sealed, PURPOSE);
    expect(plaintext).toBe("hello world");
  });

  it("同一明文两次 seal，密文不同（随机 IV）", async () => {
    const a = await seal(key, "same plaintext", PURPOSE);
    const b = await seal(key, "same plaintext", PURPOSE);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.iv).not.toBe(b.iv);
  });

  it("篡改密文 → open 返回 null", async () => {
    const sealed = await seal(key, "secret value", PURPOSE);
    const tampered: SealedBox = {
      ...sealed,
      ciphertext: flipLastByte(sealed.ciphertext),
    };
    await expect(open(key, tampered, PURPOSE)).resolves.toBeNull();
  });

  it("篡改 IV → open 返回 null", async () => {
    const sealed = await seal(key, "secret value", PURPOSE);
    const tampered: SealedBox = { ...sealed, iv: flipLastByte(sealed.iv) };
    await expect(open(key, tampered, PURPOSE)).resolves.toBeNull();
  });

  it("purpose 不一致（密文挪作他用）→ open 返回 null", async () => {
    const sealed = await seal(key, "secret value", PURPOSE);
    await expect(open(key, sealed, "push_token")).resolves.toBeNull();
  });

  it("错误长度的主密钥被拒", async () => {
    await expect(importMasterKey("dG9vc2hvcnQ=")).rejects.toThrow();
  });

  it("G2 修复 5：非法 base64 的主密钥被拒，错误消息不包含原文内容", async () => {
    await expect(importMasterKey("!!!")).rejects.toThrow();
    try {
      await importMasterKey("!!!");
      throw new Error("unreachable");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain("!!!");
    }
  });

  it("hintOf：明文 >= 8 位时返回 ··· + 末 4 位", () => {
    expect(hintOf("abcdefgh")).toBe("···efgh");
    expect(hintOf("AIzaSyAbc123456789")).toBe("···6789");
  });

  it("hintOf：明文少于 8 位时只返回 ···", () => {
    expect(hintOf("abc")).toBe("···");
    expect(hintOf("")).toBe("···");
    expect(hintOf("1234567")).toBe("···");
  });
});

/** 把 base64 字符串解码、翻转最后一个字节、再编码，用于制造「被篡改」的密文/IV。 */
function flipLastByte(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  bytes[bytes.length - 1] = (bytes[bytes.length - 1]! ^ 0xff) & 0xff;
  let out = "";
  for (const b of bytes) out += String.fromCharCode(b);
  return btoa(out);
}

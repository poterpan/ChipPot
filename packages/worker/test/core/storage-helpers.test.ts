import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import {
  buildScreenshotKey, extForContentType, assertImageOk, InvalidImage,
  putObject, getObject, deleteObject,
} from "../../src/core/storage";

const bytes = new Uint8Array([1, 2, 3, 4, 5]);

describe("storage helpers", () => {
  it("buildScreenshotKey follows {ws}/{period}/{user}/{stamp}.{ext}", () => {
    expect(buildScreenshotKey(1, "2026-06", 7, "png", "abc")).toBe("1/2026-06/7/abc.png");
  });

  it("extForContentType maps image types", () => {
    expect(extForContentType("image/png")).toBe("png");
    expect(extForContentType("image/jpeg")).toBe("jpg");
    expect(extForContentType("image/webp")).toBe("webp");
  });

  it("assertImageOk accepts allowed types and rejects others/oversize", () => {
    expect(() => assertImageOk("image/png", 1000)).not.toThrow();
    expect(() => assertImageOk("application/pdf", 1000)).toThrow(InvalidImage);
    expect(() => assertImageOk("image/png", 0)).toThrow(InvalidImage);
    expect(() => assertImageOk("image/png", 50 * 1024 * 1024)).toThrow(InvalidImage);
  });

  it("put/get/delete round trip", async () => {
    const key = "9099/test/obj.bin";
    await putObject(env.BUCKET, key, bytes, "application/octet-stream");
    const got = await getObject(env.BUCKET, key);
    expect(got).not.toBeNull();
    expect(new Uint8Array(await got!.arrayBuffer())).toEqual(bytes);
    await deleteObject(env.BUCKET, key);
    expect(await getObject(env.BUCKET, key)).toBeNull();
  });
});

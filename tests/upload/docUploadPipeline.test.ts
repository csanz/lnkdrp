import { beforeEach, describe, expect, it, vi } from "vitest";

const blobUploadMock = vi.fn();
const fetchJsonMock = vi.fn();
const fetchWithTempUserMock = vi.fn();
const notifyDocsChangedMock = vi.fn();
const debugLogMock = vi.fn();
const debugErrorMock = vi.fn();

vi.mock("@vercel/blob/client", () => {
  return { upload: blobUploadMock };
});
vi.mock("../../src/lib/http/fetchJson", () => {
  return { fetchJson: fetchJsonMock };
});
vi.mock("../../src/lib/gating/tempUserClient", () => {
  return { fetchWithTempUser: fetchWithTempUserMock };
});
vi.mock("../../src/lib/sidebarCache", () => {
  return { notifyDocsChanged: notifyDocsChangedMock };
});
vi.mock("../../src/lib/debug", () => {
  return { debugLog: debugLogMock, debugError: debugErrorMock };
});

async function flushMicrotasks(times = 10) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

describe("docUploadPipeline.startBlobUploadAndProcess", () => {
  beforeEach(() => {
    blobUploadMock.mockReset();
    fetchJsonMock.mockReset();
    fetchWithTempUserMock.mockReset();
    notifyDocsChangedMock.mockReset();
    debugLogMock.mockReset();
    debugErrorMock.mockReset();
  });

  it("happy path: uploads to Blob, PATCHes upload record, triggers processing, then notifies docs changed", async () => {
    blobUploadMock.mockResolvedValueOnce({
      url: "https://blob.example/test.pdf",
      pathname: "docs/doc1/uploads/u1/ts-test.pdf",
    });
    fetchJsonMock.mockResolvedValueOnce({ ok: true });
    fetchWithTempUserMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

    const { startBlobUploadAndProcess } = await import("../../src/lib/client/docUploadPipeline");

    const file = new File([new Uint8Array([1, 2, 3])], "test.pdf", { type: "application/pdf" });
    startBlobUploadAndProcess({ docId: "doc1", uploadId: "u1", file });

    await flushMicrotasks();

    expect(blobUploadMock).toHaveBeenCalledTimes(1);
    expect(blobUploadMock.mock.calls[0]?.[1]).toBe(file);
    expect(blobUploadMock.mock.calls[0]?.[0]).toMatch(/^docs\/doc1\/uploads\/u1\//);
    expect(blobUploadMock.mock.calls[0]?.[0]).toMatch(/-test\.pdf$/);
    expect(blobUploadMock.mock.calls[0]?.[2]).toMatchObject({
      access: "public",
      handleUploadUrl: "/api/blob/upload",
      contentType: "application/pdf",
    });

    expect(fetchJsonMock).toHaveBeenCalledTimes(1);
    expect(fetchJsonMock).toHaveBeenCalledWith(
      "/api/uploads/u1",
      expect.objectContaining({
        method: "PATCH",
        headers: { "content-type": "application/json" },
      }),
    );
    expect(fetchJsonMock.mock.calls[0]?.[1]?.body).toContain("\"status\":\"uploaded\"");
    expect(fetchJsonMock.mock.calls[0]?.[1]?.body).toContain("https://blob.example/test.pdf");

    expect(fetchWithTempUserMock).toHaveBeenCalledTimes(1);
    expect(fetchWithTempUserMock).toHaveBeenCalledWith("/api/uploads/u1/process", { method: "POST" });

    expect(notifyDocsChangedMock).toHaveBeenCalledTimes(1);
  });

  it("failure path: if blob upload fails, it calls onFailure and still notifies docs changed", async () => {
    blobUploadMock.mockRejectedValueOnce(new Error("blob down"));

    const onFailure = vi.fn();
    const { startBlobUploadAndProcess } = await import("../../src/lib/client/docUploadPipeline");

    const file = new File([new Uint8Array([1])], "x.pdf", { type: "application/pdf" });
    startBlobUploadAndProcess({ docId: "doc1", uploadId: "u1", file, onFailure });

    await flushMicrotasks();

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(String(onFailure.mock.calls[0]?.[0] ?? "")).toMatch(/blob down/i);

    expect(fetchJsonMock).not.toHaveBeenCalled();
    expect(fetchWithTempUserMock).not.toHaveBeenCalled();
    expect(notifyDocsChangedMock).toHaveBeenCalledTimes(1);
  });
});



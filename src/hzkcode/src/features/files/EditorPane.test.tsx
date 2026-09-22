import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import type { FileContent } from "@/lib/ipc";

vi.mock("@/lib/platform", () => ({
  isWeb: false,
  fileUrl: (path: string) => `http://127.0.0.1:9/media?token=t&path=${encodeURIComponent(path)}`,
}));

import { EditorPane } from "./EditorPane";
import { useFilesStore } from "./store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function content(over: Partial<FileContent>): FileContent {
  return { kind: "text", text: "", dataUrl: null, truncated: false, ...over };
}

describe("EditorPane media previews", () => {
  let container: HTMLDivElement;
  let root: Root;

  function resetStores() {
    useFilesStore.setState({
      openFiles: [],
      fileStates: {},
      activeFilePath: null,
      dirtyPaths: {},
    });
  }

  beforeEach(() => {
    resetStores();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetStores();
  });

  function render(path: string, fileContent: FileContent) {
    act(() => {
      useFilesStore.setState({
        openFiles: [path],
        fileStates: {
          [path]: { path, content: fileContent, loading: false, error: null, loadNonce: 1 },
        },
        activeFilePath: path,
      });
    });
    act(() => {
      root.render(<EditorPane path={path} />);
    });
  }

  it("streams an image with no inline copy through the media server", () => {
    render("/tmp/pic.png", content({ kind: "image" }));
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      `http://127.0.0.1:9/media?token=t&path=${encodeURIComponent("/tmp/pic.png")}`,
    );
  });

  it("keeps the inline data URL when the backend provided one", () => {
    render("/tmp/pic.png", content({ kind: "image", dataUrl: "data:image/png;base64,AAAA" }));
    expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
  });

  it("renders a video player for video kinds", () => {
    render("/tmp/clip.mp4", content({ kind: "video" }));
    const video = container.querySelector("video");
    expect(video?.getAttribute("src")).toBe(
      `http://127.0.0.1:9/media?token=t&path=${encodeURIComponent("/tmp/clip.mp4")}`,
    );
    expect(video?.hasAttribute("controls")).toBe(true);
  });

  it("falls back to the notice when the image cannot be decoded", () => {
    render("/tmp/pic.png", content({ kind: "image" }));
    const img = container.querySelector("img");
    act(() => {
      img?.dispatchEvent(new Event("error"));
    });
    expect(container.textContent).toContain(i18n.t("files.imageUnsupported"));
  });
});

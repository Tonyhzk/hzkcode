import { useState } from "react";
import { useTranslation } from "react-i18next";
import { EmptyState } from "@/components/base/empty-state";

function EditorHeader({ name }: { name: string }) {
  return (
    <div className="flex h-10 shrink-0 items-center border-b border-border-button-default px-3">
      <span className="truncate text-body-medium text-text-primary">{name}</span>
    </div>
  );
}

/** Image preview. The URL is either a loopback media-server URL (any size,
 *  see platform.fileUrl) or an inline data URL (small local images, remote
 *  files). Formats the webview cannot decode land on the unsupported notice
 *  instead of a blank pane. */
export function ImageFileView({ name, url }: { name: string; url: string | null }) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <EditorHeader name={name} />
      <EmptyState className="overflow-auto bg-background-secondary-default p-4">
        {url && !failed ? (
          <img
            src={url}
            alt={name}
            className="max-h-full max-w-full object-contain"
            onError={() => setFailed(true)}
          />
        ) : (
          <p className="text-body-medium text-text-tertiary">{t("files.imageUnsupported")}</p>
        )}
      </EmptyState>
    </div>
  );
}

/** Video preview. The asset protocol streams the file (byte ranges, so the
 *  player's seek bar works); anything the platform codecs cannot decode lands
 *  on the unsupported notice. */
export function VideoFileView({ name, url }: { name: string; url: string | null }) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <EditorHeader name={name} />
      <EmptyState className="bg-background-secondary-default p-4">
        {url && !failed ? (
          <video
            src={url}
            controls
            className="max-h-full max-w-full"
            onError={() => setFailed(true)}
          />
        ) : (
          <p className="text-body-medium text-text-tertiary">{t("files.videoUnsupported")}</p>
        )}
      </EmptyState>
    </div>
  );
}

export function BinaryFileView({ name }: { name: string }) {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <EditorHeader name={name} />
      <EmptyState className="p-6">
        <p className="text-body-medium text-text-tertiary">{t("files.binaryFile")}</p>
      </EmptyState>
    </div>
  );
}

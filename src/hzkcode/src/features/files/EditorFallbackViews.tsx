import { useTranslation } from "react-i18next";
import { EmptyState } from "@/components/base/empty-state";

function EditorHeader({ name }: { name: string }) {
  return (
    <div className="flex h-10 shrink-0 items-center border-b border-border-button-default px-3">
      <span className="truncate text-body-medium text-text-primary">{name}</span>
    </div>
  );
}

export function ImageFileView({ name, dataUrl }: { name: string; dataUrl: string | null }) {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <EditorHeader name={name} />
      <EmptyState className="overflow-auto bg-background-secondary-default p-4">
        {dataUrl ? (
          <img src={dataUrl} alt={name} className="max-h-full max-w-full object-contain" />
        ) : (
          <p className="text-body-medium text-text-tertiary">{t("files.imageTooLarge")}</p>
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

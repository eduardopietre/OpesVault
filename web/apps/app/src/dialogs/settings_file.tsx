/**
 * Choosing a backup file: a button in Portuguese (the browser's own "Choose file" speaks its interface
 * language) over a real file input, which stays reachable by keyboard and by its name. The file is read in
 * this browser and never uploaded.
 */
import { cn, formatBytes } from "@opesvault/ui";
import { FolderOpen } from "lucide-react";
import { useId } from "react";

export interface FilePickerProps {
  label: string;
  file: File | null;
  onFile: (file: File | null) => void;
  /** Said while no file is chosen. */
  empty: string;
}

export function FilePicker({ label, file, onFile, empty }: FilePickerProps) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <span id={`${id}-label`} className="text-body font-medium text-text">
        {label}
      </span>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <label
          className={cn(
            "inline-flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-md border border-separator-strong bg-raised px-3 text-body font-medium text-text shadow-sm",
            "transition-colors hover:bg-hover active:bg-pressed focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus",
          )}
        >
          <input
            type="file"
            aria-labelledby={`${id}-label`}
            className="sr-only"
            onChange={(event) => onFile(event.target.files?.[0] ?? null)}
          />
          <FolderOpen aria-hidden="true" className="size-4" />
          {file ? "Trocar arquivo…" : "Escolher arquivo…"}
        </label>
        <p className="min-w-0 break-all text-caption text-secondary">
          {file ? `${file.name} · ${formatBytes(file.size)}` : empty}
        </p>
      </div>
    </div>
  );
}

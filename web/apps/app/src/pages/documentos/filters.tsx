/**
 * The type and date filters of Documentos, beside the list's search box: PDF, image or other, and any date, one
 * month or a range of days. The rules are `keepsDocument` (rows.ts); this is only the controls.
 */
import { ymOf, type IsoDate } from "@opesvault/domain";
import { DateField, MonthPicker, Select, type SelectOption } from "@opesvault/ui";
import { useState } from "react";
import { FILE_TYPE_LABELS, type DocumentFilter, type FileType } from "./rows.ts";

const ALL = "all";

const TYPE_OPTIONS: readonly SelectOption[] = [
  { id: ALL, label: "Todos os tipos" },
  ...(Object.keys(FILE_TYPE_LABELS) as FileType[]).map((type) => ({ id: type, label: FILE_TYPE_LABELS[type] })),
];

const DATE_OPTIONS: readonly SelectOption[] = [
  { id: "any", label: "Qualquer data" },
  { id: "month", label: "Um mês" },
  { id: "range", label: "Intervalo de datas" },
];

export function DocumentFilters({
  filter,
  onChange,
  today,
}: {
  filter: DocumentFilter;
  onChange: (next: DocumentFilter) => void;
  today: IsoDate;
}) {
  // The text typed in the range, kept as typed; the filter takes the dates once they are valid.
  const [fromText, setFromText] = useState("");
  const [toText, setToText] = useState("");
  const { date } = filter;
  const chooseDate = (kind: string) => {
    if (kind === "month") onChange({ ...filter, date: { kind: "month", month: ymOf(today) } });
    else if (kind === "range") {
      setFromText("");
      setToText("");
      onChange({ ...filter, date: { kind: "range", from: null, to: null } });
    } else onChange({ ...filter, date: { kind: "any" } });
  };
  const range = date.kind === "range" ? date : null;
  return (
    <>
      <Select
        label="Tipo de arquivo"
        hideLabel
        options={TYPE_OPTIONS}
        value={filter.type ?? ALL}
        onChange={(id) => onChange({ ...filter, type: id === ALL ? null : (id as FileType) })}
        className="w-40"
      />
      <Select
        label="Data dos documentos"
        hideLabel
        options={DATE_OPTIONS}
        value={date.kind}
        onChange={chooseDate}
        className="w-44"
      />
      {date.kind === "month" ? (
        <MonthPicker
          label="Mês dos documentos"
          value={date.month}
          onChange={(month) => onChange({ ...filter, date: { kind: "month", month } })}
        />
      ) : null}
      {range ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <DateField
            label="Data inicial"
            hideLabel
            placeholder="De dd/mm/aaaa"
            value={fromText}
            onChange={setFromText}
            onDateChange={(iso) => onChange({ ...filter, date: { ...range, from: iso as IsoDate | null } })}
            fieldClassName="w-36"
          />
          <DateField
            label="Data final"
            hideLabel
            placeholder="Até dd/mm/aaaa"
            value={toText}
            onChange={setToText}
            onDateChange={(iso) => onChange({ ...filter, date: { ...range, to: iso as IsoDate | null } })}
            fieldClassName="w-36"
          />
        </div>
      ) : null}
    </>
  );
}

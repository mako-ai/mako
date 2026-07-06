import {
  FormControl,
  FormHelperText,
  InputLabel,
  MenuItem,
  Select,
} from "@mui/material";
import {
  DBT_VERSION_OPTIONS,
  DEFAULT_DBT_VERSION,
  isKnownDbtVersion,
} from "../lib/dbt-versions";

export default function DbtVersionSelect({
  value,
  onChange,
  labelId = "dbt-version-select",
  helperText = "Pinned release track for runs and compile. Patch version is managed by the runner.",
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  labelId?: string;
  helperText?: string;
  disabled?: boolean;
}) {
  const safeValue = isKnownDbtVersion(value) ? value : DEFAULT_DBT_VERSION;

  return (
    <FormControl fullWidth size="small" disabled={disabled}>
      <InputLabel id={labelId}>dbt version</InputLabel>
      <Select
        labelId={labelId}
        label="dbt version"
        value={safeValue}
        onChange={e => onChange(e.target.value)}
      >
        {DBT_VERSION_OPTIONS.map(opt => (
          <MenuItem key={opt.value} value={opt.value}>
            {opt.label}
          </MenuItem>
        ))}
      </Select>
      {helperText && <FormHelperText>{helperText}</FormHelperText>}
    </FormControl>
  );
}

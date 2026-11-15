import { Box, Button } from "@mui/material";
import { styled } from "@mui/material/styles";
import {
  Add as AddIcon,
  Delete as DeleteIcon,
  Save as SaveIcon,
} from "@mui/icons-material";

const Bar = styled(Box)(({ theme }) =>
  theme.unstable_sx({
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    px: 2,
    py: 1,
    borderBottom: 1,
    borderColor: "divider",
  }),
);

interface FlowFormTopBarProps {
  isNew: boolean;
  isSubmitting: boolean;
  /** Shown only for an existing flow. */
  onDelete?: () => void;
  onCancel?: () => void;
  onSave: () => void;
  saveDisabled?: boolean;
}

/** Delete on the left; Cancel and Create/Save on the right. */
export function FlowFormTopBar({
  isNew,
  isSubmitting,
  onDelete,
  onCancel,
  onSave,
  saveDisabled = false,
}: FlowFormTopBarProps) {
  return (
    <Bar>
      {onDelete && (
        <Button
          color="error"
          size="small"
          startIcon={<DeleteIcon />}
          onClick={onDelete}
          disabled={isSubmitting}
        >
          Delete
        </Button>
      )}
      <Box sx={{ flex: 1 }} />
      <Box sx={{ display: "flex", gap: 1 }}>
        {onCancel && (
          <Button size="small" onClick={onCancel} disabled={isSubmitting}>
            Cancel
          </Button>
        )}
        <Button
          type="submit"
          variant="contained"
          size="small"
          startIcon={isNew ? <AddIcon /> : <SaveIcon />}
          disabled={isSubmitting || saveDisabled}
          onClick={onSave}
        >
          {isNew ? "Create" : "Save"}
        </Button>
      </Box>
    </Bar>
  );
}

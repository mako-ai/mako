import { useState } from "react";
import { Box } from "@mui/material";
import { Plug } from "lucide-react";

/** Square connection logo with a plug fallback when the image fails. */
export function ConnectionIcon({
  src,
  size = 36,
}: {
  src?: string | null;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <Box
        sx={{
          width: size,
          height: size,
          borderRadius: 1.5,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          bgcolor: "action.hover",
          color: "text.secondary",
          flexShrink: 0,
        }}
      >
        <Plug size={size * 0.55} />
      </Box>
    );
  }
  return (
    <Box
      component="img"
      src={src}
      alt=""
      onError={() => setFailed(true)}
      sx={{
        width: size,
        height: size,
        borderRadius: 1.5,
        objectFit: "contain",
        flexShrink: 0,
      }}
    />
  );
}

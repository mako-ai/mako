import {
  Box,
  Typography,
  Paper,
  Button,
  Stack,
  Chip,
} from "@mui/material";
import {
  PlayArrow as PlayIcon,
  Storage as DatabaseIcon,
  Star as StarIcon,
} from "@mui/icons-material";
import { QualificationData } from "./types";

interface PathSelectionStepProps {
  qualificationData: QualificationData;
  onSelectPath: (path: "demo" | "connect") => void;
  isProvisioning?: boolean;
}

export function PathSelectionStep({
  qualificationData,
  onSelectPath,
  isProvisioning = false,
}: PathSelectionStepProps) {
  // Recommend demo if user has no database
  const recommendDemo = qualificationData.hasNoDatabase;

  return (
    <Box>
      <Typography variant="h5" gutterBottom sx={{ mb: 3 }}>
        How would you like to get started?
      </Typography>
      <Typography color="text.secondary" sx={{ mb: 4 }}>
        {recommendDemo
          ? "Since you don't have a database yet, we recommend starting with our demo data."
          : "Connect your database to get started with your real data."}
      </Typography>

      <Stack spacing={3}>
        {/* Demo Option */}
        <Paper
          variant="outlined"
          sx={{
            p: 3,
            cursor: "pointer",
            transition: "all 0.2s",
            borderWidth: recommendDemo ? 2 : 1,
            borderColor: recommendDemo ? "primary.main" : "divider",
            "&:hover": {
              borderColor: "primary.main",
              bgcolor: "action.hover",
            },
          }}
          onClick={() => !isProvisioning && onSelectPath("demo")}
        >
          <Box sx={{ display: "flex", alignItems: "flex-start", gap: 2 }}>
            <Box
              sx={{
                p: 1.5,
                borderRadius: 2,
                bgcolor: "primary.main",
                color: "primary.contrastText",
              }}
            >
              <PlayIcon />
            </Box>
            <Box sx={{ flex: 1 }}>
              <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1 }}>
                <Typography variant="h6">Try with Demo Database</Typography>
                {recommendDemo && (
                  <Chip
                    label="Recommended"
                    size="small"
                    color="primary"
                    icon={<StarIcon sx={{ fontSize: 14 }} />}
                  />
                )}
              </Box>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Explore Mako instantly with a pre-populated e-commerce dataset.
                No setup required.
              </Typography>
              <Stack direction="row" spacing={1}>
                <Chip label="Instant access" size="small" variant="outlined" />
                <Chip label="Sample queries" size="small" variant="outlined" />
                <Chip label="Zero setup" size="small" variant="outlined" />
              </Stack>
            </Box>
          </Box>
          <Button
            variant={recommendDemo ? "contained" : "outlined"}
            fullWidth
            size="large"
            sx={{ mt: 3 }}
            disabled={isProvisioning}
            onClick={e => {
              e.stopPropagation();
              onSelectPath("demo");
            }}
          >
            {isProvisioning ? "Setting up demo..." : "Start Exploring"}
          </Button>
        </Paper>

        {/* Connect Option */}
        <Paper
          variant="outlined"
          sx={{
            p: 3,
            cursor: "pointer",
            transition: "all 0.2s",
            borderWidth: !recommendDemo ? 2 : 1,
            borderColor: !recommendDemo ? "primary.main" : "divider",
            "&:hover": {
              borderColor: "primary.main",
              bgcolor: "action.hover",
            },
          }}
          onClick={() => !isProvisioning && onSelectPath("connect")}
        >
          <Box sx={{ display: "flex", alignItems: "flex-start", gap: 2 }}>
            <Box
              sx={{
                p: 1.5,
                borderRadius: 2,
                bgcolor: "secondary.main",
                color: "secondary.contrastText",
              }}
            >
              <DatabaseIcon />
            </Box>
            <Box sx={{ flex: 1 }}>
              <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1 }}>
                <Typography variant="h6">Connect Your Database</Typography>
                {!recommendDemo && (
                  <Chip
                    label="Recommended"
                    size="small"
                    color="primary"
                    icon={<StarIcon sx={{ fontSize: 14 }} />}
                  />
                )}
              </Box>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Connect to your existing database and start querying your real
                data immediately.
              </Typography>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                {qualificationData.databaseTypes &&
                qualificationData.databaseTypes.length > 0 ? (
                  qualificationData.databaseTypes.slice(0, 3).map(db => (
                    <Chip
                      key={db}
                      label={db.charAt(0).toUpperCase() + db.slice(1)}
                      size="small"
                      variant="outlined"
                    />
                  ))
                ) : (
                  <>
                    <Chip label="MongoDB" size="small" variant="outlined" />
                    <Chip label="PostgreSQL" size="small" variant="outlined" />
                    <Chip label="+ more" size="small" variant="outlined" />
                  </>
                )}
              </Stack>
            </Box>
          </Box>
          <Button
            variant={!recommendDemo ? "contained" : "outlined"}
            fullWidth
            size="large"
            sx={{ mt: 3 }}
            disabled={isProvisioning}
            onClick={e => {
              e.stopPropagation();
              onSelectPath("connect");
            }}
          >
            Connect Database
          </Button>
        </Paper>

        {/* Skip option */}
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ textAlign: "center", mt: 2 }}
        >
          You can always add or change databases later in settings.
        </Typography>
      </Stack>
    </Box>
  );
}

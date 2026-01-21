import {
  Box,
  Typography,
  Button,
  Card,
  CardContent,
  CardActionArea,
  Stack,
  Chip,
  alpha,
  useTheme,
} from "@mui/material";
import StorageIcon from "@mui/icons-material/Storage";
import PlayCircleOutlineIcon from "@mui/icons-material/PlayCircleOutline";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import { QualificationData } from "./QualificationStep";

export type OnboardingPath = "demo" | "connect";

interface PathSelectionStepProps {
  qualificationData: QualificationData;
  onSelectPath: (path: OnboardingPath) => void;
  onBack: () => void;
}

export function PathSelectionStep({
  qualificationData,
  onSelectPath,
  onBack,
}: PathSelectionStepProps) {
  const theme = useTheme();

  // Determine recommendation based on qualification data
  const recommendDemo = qualificationData.hasNoDatabase;

  return (
    <Box>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 2 }}>
        <Button
          onClick={onBack}
          startIcon={<ArrowBackIcon />}
          size="small"
          sx={{ minWidth: "auto" }}
        >
          Back
        </Button>
      </Box>

      <Typography variant="h5" fontWeight={600} gutterBottom>
        Choose your path
      </Typography>
      <Typography color="text.secondary" sx={{ mb: 4 }}>
        {recommendDemo
          ? "We recommend starting with our demo database to explore Mako's features"
          : "Connect your database to start querying your data with AI"}
      </Typography>

      <Stack spacing={3}>
        {/* Demo Option */}
        <Card
          variant="outlined"
          sx={{
            position: "relative",
            borderWidth: recommendDemo ? 2 : 1,
            borderColor: recommendDemo ? "primary.main" : "divider",
            transition: "all 0.2s",
            "&:hover": {
              borderColor: "primary.main",
              transform: "translateY(-2px)",
              boxShadow: theme.shadows[4],
            },
          }}
        >
          {recommendDemo && (
            <Chip
              label="Recommended"
              color="primary"
              size="small"
              sx={{
                position: "absolute",
                top: -10,
                right: 16,
                fontWeight: 600,
              }}
            />
          )}
          <CardActionArea onClick={() => onSelectPath("demo")}>
            <CardContent sx={{ p: 3 }}>
              <Box sx={{ display: "flex", alignItems: "flex-start", gap: 2 }}>
                <Box
                  sx={{
                    p: 1.5,
                    borderRadius: 2,
                    bgcolor: alpha(theme.palette.primary.main, 0.1),
                    color: "primary.main",
                  }}
                >
                  <PlayCircleOutlineIcon fontSize="large" />
                </Box>
                <Box sx={{ flex: 1 }}>
                  <Typography variant="h6" fontWeight={600} gutterBottom>
                    Try with Demo Database
                  </Typography>
                  <Typography variant="body2" color="text.secondary" paragraph>
                    Explore Mako instantly with a pre-populated e-commerce
                    dataset. Perfect for learning how everything works.
                  </Typography>
                  <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                    <Chip
                      icon={<CheckCircleIcon fontSize="small" />}
                      label="Instant access"
                      size="small"
                      variant="outlined"
                    />
                    <Chip
                      icon={<CheckCircleIcon fontSize="small" />}
                      label="Zero setup"
                      size="small"
                      variant="outlined"
                    />
                    <Chip
                      icon={<CheckCircleIcon fontSize="small" />}
                      label="Sample data"
                      size="small"
                      variant="outlined"
                    />
                  </Stack>
                </Box>
              </Box>
              <Button
                variant={recommendDemo ? "contained" : "outlined"}
                fullWidth
                size="large"
                sx={{ mt: 3 }}
              >
                Start Exploring
              </Button>
            </CardContent>
          </CardActionArea>
        </Card>

        {/* Connect Option */}
        <Card
          variant="outlined"
          sx={{
            position: "relative",
            borderWidth: !recommendDemo ? 2 : 1,
            borderColor: !recommendDemo ? "primary.main" : "divider",
            transition: "all 0.2s",
            "&:hover": {
              borderColor: "primary.main",
              transform: "translateY(-2px)",
              boxShadow: theme.shadows[4],
            },
          }}
        >
          {!recommendDemo && (
            <Chip
              label="Recommended"
              color="primary"
              size="small"
              sx={{
                position: "absolute",
                top: -10,
                right: 16,
                fontWeight: 600,
              }}
            />
          )}
          <CardActionArea onClick={() => onSelectPath("connect")}>
            <CardContent sx={{ p: 3 }}>
              <Box sx={{ display: "flex", alignItems: "flex-start", gap: 2 }}>
                <Box
                  sx={{
                    p: 1.5,
                    borderRadius: 2,
                    bgcolor: alpha(theme.palette.success.main, 0.1),
                    color: "success.main",
                  }}
                >
                  <StorageIcon fontSize="large" />
                </Box>
                <Box sx={{ flex: 1 }}>
                  <Typography variant="h6" fontWeight={600} gutterBottom>
                    Connect Your Database
                  </Typography>
                  <Typography variant="body2" color="text.secondary" paragraph>
                    Connect your real database and start querying your data with
                    AI immediately.
                  </Typography>
                  <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                    <Chip
                      icon={<CheckCircleIcon fontSize="small" />}
                      label="Your real data"
                      size="small"
                      variant="outlined"
                    />
                    <Chip
                      icon={<CheckCircleIcon fontSize="small" />}
                      label="Full capabilities"
                      size="small"
                      variant="outlined"
                    />
                    {qualificationData.databaseTypes.length > 0 && (
                      <Chip
                        label={`${qualificationData.databaseTypes[0].charAt(0).toUpperCase() + qualificationData.databaseTypes[0].slice(1)} ready`}
                        size="small"
                        color="primary"
                        variant="outlined"
                      />
                    )}
                  </Stack>
                </Box>
              </Box>
              <Button
                variant={!recommendDemo ? "contained" : "outlined"}
                fullWidth
                size="large"
                sx={{ mt: 3 }}
              >
                Connect Now
              </Button>
            </CardContent>
          </CardActionArea>
        </Card>
      </Stack>
    </Box>
  );
}

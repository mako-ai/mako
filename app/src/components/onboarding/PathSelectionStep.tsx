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
import PlayCircleOutlineIcon from "@mui/icons-material/PlayCircleOutline";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import { Database } from "lucide-react";
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

  // Option card component
  const OptionCard = ({
    isRecommended,
    icon,
    iconBgColor,
    iconColor,
    title,
    description,
    buttonText,
    onClick,
  }: {
    isRecommended: boolean;
    icon: React.ReactNode;
    iconBgColor: string;
    iconColor: string;
    title: string;
    description: string;
    buttonText: string;
    onClick: () => void;
  }) => (
    <Card
      variant="outlined"
      sx={{
        position: "relative",
        overflow: "visible",
        borderWidth: isRecommended ? 2 : 1,
        borderColor: isRecommended ? "primary.main" : "divider",
        transition: "all 0.2s",
        "&:hover": {
          borderColor: "primary.main",
          transform: "translateY(-2px)",
          boxShadow: theme.shadows[4],
        },
      }}
    >
      {isRecommended && (
        <Chip
          label="Recommended"
          color="primary"
          size="small"
          sx={{
            position: "absolute",
            top: -12,
            right: 16,
            fontWeight: 600,
          }}
        />
      )}
      <CardActionArea onClick={onClick}>
        <CardContent sx={{ p: 3 }}>
          <Box sx={{ display: "flex", alignItems: "flex-start", gap: 2 }}>
            <Box
              sx={{
                p: 1.5,
                borderRadius: 2,
                bgcolor: iconBgColor,
                color: iconColor,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {icon}
            </Box>
            <Box sx={{ flex: 1 }}>
              <Typography variant="h6" fontWeight={600} gutterBottom>
                {title}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {description}
              </Typography>
            </Box>
          </Box>
          <Button
            variant={isRecommended ? "contained" : "outlined"}
            fullWidth
            size="large"
            sx={{ mt: 2 }}
          >
            {buttonText}
          </Button>
        </CardContent>
      </CardActionArea>
    </Card>
  );

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
        {/* Recommended option always first */}
        {!recommendDemo ? (
          <>
            <OptionCard
              isRecommended={true}
              icon={<Database size={28} />}
              iconBgColor={alpha(theme.palette.success.main, 0.1)}
              iconColor={theme.palette.success.main}
              title="Connect Your Database"
              description="Connect your real database and start querying your data with AI immediately."
              buttonText="Connect Now"
              onClick={() => onSelectPath("connect")}
            />
            <OptionCard
              isRecommended={false}
              icon={<PlayCircleOutlineIcon fontSize="large" />}
              iconBgColor={alpha(theme.palette.primary.main, 0.1)}
              iconColor={theme.palette.primary.main}
              title="Try with Demo Database"
              description="Explore Mako instantly with a pre-populated e-commerce dataset."
              buttonText="Start Exploring"
              onClick={() => onSelectPath("demo")}
            />
          </>
        ) : (
          <>
            <OptionCard
              isRecommended={true}
              icon={<PlayCircleOutlineIcon fontSize="large" />}
              iconBgColor={alpha(theme.palette.primary.main, 0.1)}
              iconColor={theme.palette.primary.main}
              title="Try with Demo Database"
              description="Explore Mako instantly with a pre-populated e-commerce dataset."
              buttonText="Start Exploring"
              onClick={() => onSelectPath("demo")}
            />
            <OptionCard
              isRecommended={false}
              icon={<Database size={28} />}
              iconBgColor={alpha(theme.palette.success.main, 0.1)}
              iconColor={theme.palette.success.main}
              title="Connect Your Database"
              description="Connect your real database and start querying your data with AI immediately."
              buttonText="Connect Now"
              onClick={() => onSelectPath("connect")}
            />
          </>
        )}
      </Stack>
    </Box>
  );
}
